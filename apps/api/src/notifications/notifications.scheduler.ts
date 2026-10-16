import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from './notifications.service.js';
import { PushService } from './push.service.js';
import { businessDateToIso, businessToday, addBusinessDays } from '../domain/business-date.js';
import { dec } from '../domain/money.js';

interface ReminderOffsets {
  offsets: number[];
}

/**
 * PLANIFICADOR DE RECORDATORIOS
 * -----------------------------
 * Los avisos críticos NO dependen del navegador: los genera este planificador
 * en el servidor. Cada aviso usa una CLAVE DE DEDUPLICACIÓN, así que reiniciar
 * el servidor o ejecutar el planificador dos veces no duplica nada.
 *
 * Recordatorios escalonados (spec §12): por defecto a la hora configurada
 * (0), una hora después (60 min) y tres horas después (180 min); al día
 * siguiente sigue apareciendo como tarea pendiente marcada como atrasada.
 *
 * Se evita el spam: como máximo unos pocos avisos por día y por concepto.
 */
@Injectable()
export class NotificationsScheduler {
  private readonly logger = new Logger(NotificationsScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly push: PushService,
  ) {}

  /** Cada 5 minutos: recordatorios de cierre, vencimientos y presupuestos. */
  @Cron('*/5 * * * *', { name: 'finanza-reminders' })
  async runReminders(): Promise<void> {
    try {
      await this.generateReminders();
      await this.notifications.flushPending(100);
    } catch (error) {
      this.logger.error(`Fallo al generar recordatorios: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Una vez al día de madrugada: mantenimiento y estado de vencimientos. */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'finanza-maintenance' })
  async dailyMaintenance(): Promise<void> {
    try {
      const entities = await this.prisma.financialEntity.findMany({
        where: { isActive: true },
        select: { id: true },
      });
      const entityIds = entities.map((entity) => entity.id);

      // Marca como vencido lo que ya venció (status OVERDUE).
      const [receivables, payables] = await Promise.all([
        this.prisma.receivable.updateMany({
          where: { entityId: { in: entityIds }, status: { in: ['PENDING', 'PARTIAL'] }, dueDate: { lt: businessToday() } },
          data: { status: 'OVERDUE' },
        }),
        this.prisma.payable.updateMany({
          where: { entityId: { in: entityIds }, status: { in: ['PENDING', 'PARTIAL'] }, dueDate: { lt: businessToday() } },
          data: { status: 'OVERDUE' },
        }),
      ]);

      const prunedNotifications = await this.notifications.pruneRead(60);
      const prunedSync = await this.prisma.syncOperation.deleteMany({
        where: {
          status: { in: ['APPLIED', 'DUPLICATE'] },
          appliedAt: { lt: new Date(Date.now() - 90 * 86_400_000) },
        },
      });

      this.logger.log(
        `Mantenimiento diario: ${receivables.count} cuentas por cobrar y ${payables.count} por pagar marcadas como vencidas; ` +
          `${prunedNotifications} notificaciones y ${prunedSync.count} operaciones de sincronización depuradas.`,
      );
    } catch (error) {
      this.logger.error(`Fallo en el mantenimiento diario: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Genera los recordatorios del momento para cada usuario activo.
   * Es idempotente: se puede invocar tantas veces como se quiera.
   */
  async generateReminders(): Promise<{ usersProcessed: number; notificationsCreated: number }> {
    const users = await this.prisma.user.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        preference: {
          select: {
            timezone: true,
            closingReminderHour: true,
            closingReminderMinute: true,
            reminderOffsetsJson: true,
            dailyBriefEnabled: true,
            cashDifferenceAlert: true,
          },
        },
      },
      take: 100,
    });

    let created = 0;

    for (const user of users) {
      const timezone = user.preference?.timezone ?? 'America/Santo_Domingo';
      const now = DateTime.now().setZone(timezone);
      const reminderHour = user.preference?.closingReminderHour ?? 21;
      const reminderMinute = user.preference?.closingReminderMinute ?? 0;
      const offsets = this.parseOffsets(user.preference?.reminderOffsetsJson ?? [0, 60, 180]);

      const entities = await this.prisma.financialEntity.findMany({
        where: { ownerUserId: user.id, isActive: true },
        select: { id: true, name: true },
      });

      const today = businessToday();
      const todayIso = businessDateToIso(today);

      for (const entity of entities) {
        // --- ¿Hay movimientos hoy? ------------------------------------
        const todayMovements = await this.prisma.financialTransaction.count({
          where: { entityId: entity.id, businessDate: today, status: 'POSTED' },
        });

        const closing = await this.prisma.dailyClosing.findUnique({
          where: { entityId_businessDate: { entityId: entity.id, businessDate: today } },
          select: { status: true, closedAt: true, difference: true, differencesJson: true },
        });

        const isClosed = closing?.closedAt !== null && closing?.closedAt !== undefined;

        if (!isClosed) {
          // Recordatorios escalonados del día.
          for (const offset of offsets) {
            const fireAt = DateTime.fromObject(
              { hour: reminderHour, minute: reminderMinute, second: 0, millisecond: 0 },
              { zone: timezone },
            ).plus({ minutes: offset });

            if (now < fireAt) {
              continue;
            }

            // Si el usuario pasó el día sin movimientos, se le recuerda una vez
            // confirmar que efectivamente no hubo movimientos.
            const result = await this.notifications.create({
              userId: user.id,
              entityId: entity.id,
              type: offset === 0 ? 'CLOSING_REMINDER' : 'CLOSING_REMINDER_ESCALATED',
              title: offset === 0 ? `Cierre diario de ${entity.name}` : `Sigue pendiente el cierre de ${entity.name}`,
              body:
                todayMovements === 0
                  ? 'Hoy no hay movimientos registrados. Confirme el cierre del día (también los días sin movimientos se cierran).'
                  : `Hoy se registraron ${todayMovements} movimiento(s). Cuente el efectivo y confirme el cierre.`,
              severity: offset >= 180 ? 'CRITICAL' : 'WARNING',
              dedupeKey: `closing:${user.id}:${entity.id}:${todayIso}:${offset}`,
              actionUrl: `/cierres?entityId=${entity.id}&date=${todayIso}`,
              relatedType: 'FinancialEntity',
              relatedId: entity.id,
            });
            if (result.created && !result.deduplicated) {
              created += 1;
            }
          }
        }

        // --- Diferencias de caja sin explicar -------------------------
        if (closing && closing.differencesJson) {
          const rows = closing.differencesJson as unknown as Array<{ explained?: boolean }>;
          const unexplained = rows.filter((row) => row.explained === false).length;
          if (unexplained > 0) {
            const result = await this.notifications.create({
              userId: user.id,
              entityId: entity.id,
              type: 'CASH_DIFFERENCE_UNEXPLAINED',
              title: `Diferencia de caja sin explicar en ${entity.name}`,
              body: `${unexplained} cuenta(s) con diferencia. Explique la diferencia para poder cerrar el día correctamente.`,
              severity: 'CRITICAL',
              dedupeKey: `difference:${user.id}:${entity.id}:${todayIso}`,
              actionUrl: `/cierres?entityId=${entity.id}&date=${todayIso}`,
            });
            if (result.created && !result.deduplicated) {
              created += 1;
            }
          }
        }

        // --- Cierres atrasados (día anterior sin cerrar) --------------
        const previousDay = addBusinessDays(today, -1);
        const previousMovements = await this.prisma.financialTransaction.count({
          where: { entityId: entity.id, businessDate: previousDay, status: 'POSTED' },
        });
        const previousClosing = await this.prisma.dailyClosing.findUnique({
          where: { entityId_businessDate: { entityId: entity.id, businessDate: previousDay } },
          select: { closedAt: true },
        });

        if (previousMovements > 0 && !previousClosing?.closedAt) {
          const result = await this.notifications.create({
            userId: user.id,
            entityId: entity.id,
            type: 'CLOSING_OVERDUE',
            title: `Cierre atrasado en ${entity.name}`,
            body: `El día ${businessDateToIso(previousDay)} tiene ${previousMovements} movimiento(s) y sigue sin cerrarse.`,
            severity: 'CRITICAL',
            dedupeKey: `closing-overdue:${user.id}:${entity.id}:${businessDateToIso(previousDay)}`,
            actionUrl: `/cierres?entityId=${entity.id}&date=${businessDateToIso(previousDay)}`,
          });
          if (result.created && !result.deduplicated) {
            created += 1;
          }
        }

        // --- Vencimientos próximos (una vez al día) -------------------
        const soon = addBusinessDays(today, 3);
        const duePayables = await this.prisma.payable.findMany({
          where: {
            entityId: entity.id,
            status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] },
            dueDate: { lte: soon },
          },
          select: { id: true, description: true, dueDate: true, originalAmount: true, settledAmount: true },
        });

        for (const payable of duePayables) {
          if (!payable.dueDate) {
            continue;
          }
          const overdue = payable.dueDate.getTime() < today.getTime();
          const result = await this.notifications.create({
            userId: user.id,
            entityId: entity.id,
            type: overdue ? 'PAYABLE_OVERDUE' : 'PAYABLE_DUE_SOON',
            title: overdue ? `Cuenta por pagar VENCIDA: ${payable.description}` : `Por pagar pronto: ${payable.description}`,
            body: `Importe pendiente ${payable.originalAmount.minus(payable.settledAmount).toFixed(2)} con vencimiento ${businessDateToIso(payable.dueDate)}.`,
            severity: overdue ? 'CRITICAL' : 'WARNING',
            dedupeKey: `payable-due:${user.id}:${payable.id}:${businessDateToIso(payable.dueDate)}`,
            actionUrl: `/obligaciones?entityId=${entity.id}`,
          });
          if (result.created && !result.deduplicated) {
            created += 1;
          }
        }

        const dueLoans = await this.prisma.loan.findMany({
          where: { entityId: entity.id, status: 'ACTIVE', direction: 'PAYABLE', nextDueDate: { lte: soon } },
          select: { id: true, name: true, nextDueDate: true, currentBalance: true, installmentAmount: true },
        });

        for (const loan of dueLoans) {
          if (!loan.nextDueDate) {
            continue;
          }
          const overdue = loan.nextDueDate.getTime() < today.getTime();
          const result = await this.notifications.create({
            userId: user.id,
            entityId: entity.id,
            type: overdue ? 'LOAN_INSTALLMENT_OVERDUE' : 'LOAN_INSTALLMENT_DUE_SOON',
            title: `${overdue ? 'Cuota VENCIDA' : 'Próxima cuota'}: ${loan.name}`,
            body: `Cuota ${(loan.installmentAmount ?? loan.currentBalance).toFixed(2)} con vencimiento ${businessDateToIso(loan.nextDueDate)}.`,
            severity: overdue ? 'CRITICAL' : 'WARNING',
            dedupeKey: `loan-due:${user.id}:${loan.id}:${businessDateToIso(loan.nextDueDate)}`,
            actionUrl: `/prestamos?entityId=${entity.id}`,
          });
          if (result.created && !result.deduplicated) {
            created += 1;
          }
        }
      }

      // --- Pendientes de sincronizar --------------------------------
      const pending = await this.prisma.syncOperation.count({
        where: { userId: user.id, status: { in: ['RECEIVED', 'ERROR'] } },
      });
      const pendingTransactions = await this.prisma.financialTransaction.count({
        where: { createdByUserId: user.id, syncStatus: { in: ['PENDING', 'FAILED'] } },
      });

      if (pending + pendingTransactions > 0) {
        const result = await this.notifications.create({
          userId: user.id,
          type: 'SYNC_PENDING',
          title: 'Movimientos sin confirmar por el servidor',
          body: `${pending + pendingTransactions} operación(es) siguen sólo en este dispositivo. Conéctese para confirmarlas.`,
          severity: 'CRITICAL',
          dedupeKey: `sync-pending:${user.id}:${businessDateToIso(today)}`,
          actionUrl: '/sincronizacion',
        });
        if (result.created && !result.deduplicated) {
          created += 1;
        }
      }

      // --- Resumen diario ------------------------------------------
      if (user.preference?.dailyBriefEnabled !== false) {
        const briefTime = DateTime.fromObject(
          { hour: reminderHour, minute: Math.min(59, reminderMinute + 30), second: 0 },
          { zone: timezone },
        );

        if (now >= briefTime) {
          const entityIdsForBrief = entities.map((entity) => entity.id);
          const [incomeRow, expenseRow] = await Promise.all([
            this.prisma.financialTransaction.aggregate({
              _sum: { amount: true },
              where: { entityId: { in: entityIdsForBrief }, kind: 'INCOME', status: 'POSTED', businessDate: today },
            }),
            this.prisma.financialTransaction.aggregate({
              _sum: { amount: true },
              where: { entityId: { in: entityIdsForBrief }, kind: 'EXPENSE', status: 'POSTED', businessDate: today },
            }),
          ]);

          const income = dec(incomeRow._sum.amount ?? 0);
          const expense = dec(expenseRow._sum.amount ?? 0);
          const result = income.minus(expense);

          const todayMovementsTotal = await this.prisma.financialTransaction.count({
            where: { entityId: { in: entityIdsForBrief }, status: 'POSTED', businessDate: today },
          });

          const brief = await this.notifications.create({
            userId: user.id,
            type: 'DAILY_BRIEF',
            title: 'Resumen del día',
            body:
              `Ingresos ${income.toFixed(2)} · Gastos ${expense.toFixed(2)} · Resultado ${result.toFixed(2)}` +
              (todayMovementsTotal === 0 ? ' · Sin movimientos registrados hoy' : ''),
            severity: result.isNegative() ? 'WARNING' : 'INFO',
            dedupeKey: `daily-brief:${user.id}:${todayIso}`,
            actionUrl: '/panel',
          });
          if (brief.created && !brief.deduplicated) {
            created += 1;
          }
        }
      }
    }

    if (created > 0) {
      this.logger.log(`Recordatorios generados: ${created}`);
    }

    return { usersProcessed: users.length, notificationsCreated: created };
  }

  private parseOffsets(value: unknown): number[] {
    if (Array.isArray(value)) {
      return value.filter((item): item is number => typeof item === 'number' && item >= 0).sort((a, b) => a - b);
    }
    return [0, 60, 180];
  }
}
