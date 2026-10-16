import { Injectable, Logger } from '@nestjs/common';
import type { NotificationSeverity } from '../generated/prisma/enums.js';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import { NotFoundError } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import { addBusinessDays, businessDateToIso, businessToday } from '../domain/business-date.js';
import { dec } from '../domain/money.js';
import { PushService } from './push.service.js';

export interface CreateNotificationInput {
  userId: string;
  entityId?: string | null;
  type: string;
  title: string;
  body: string;
  severity?: NotificationSeverity;
  /** Evita enviar el mismo aviso dos veces (clave única). */
  dedupeKey?: string;
  relatedType?: string;
  relatedId?: string;
  actionUrl?: string;
  scheduledFor?: Date;
  /** Si es true se intenta el envío push inmediatamente. */
  sendPush?: boolean;
}

export interface PendingTask {
  id: string;
  type: 'CLOSING' | 'OBLIGATION' | 'SYNC' | 'BUDGET' | 'CASH_DIFFERENCE';
  title: string;
  detail: string;
  severity: NotificationSeverity;
  entityId: string | null;
  entityName: string | null;
  amount: string | null;
  dueDate: string | null;
  /** Ruta directa para abrir la tarea pendiente en la app. */
  actionUrl: string;
  /** Obligatoria: impide que la tarea se ignore sin justificación. */
  isMandatory: boolean;
}

/**
 * CENTRO DE NOTIFICACIONES Y TAREAS PENDIENTES
 * --------------------------------------------
 * FINANZA no sólo muestra datos: empuja al usuario a cumplir. Este servicio
 * genera los avisos (con deduplicación para no hacer spam) y calcula la lista
 * de TAREAS FINANCIERAS PENDIENTES que la app muestra al abrirse, incluso si
 * las notificaciones push no están disponibles.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly push: PushService,
  ) {}

  /** Crea una notificación si no existe otra con la misma clave de deduplicación. */
  async create(input: CreateNotificationInput) {
    if (input.dedupeKey) {
      const existing = await this.prisma.notification.findUnique({ where: { dedupeKey: input.dedupeKey } });
      if (existing) {
        return { created: false, notificationId: existing.id, deduplicated: true };
      }
    }

    const notification = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        entityId: input.entityId ?? null,
        type: input.type,
        title: input.title,
        body: input.body,
        severity: input.severity ?? 'INFO',
        status: 'PENDING',
        dedupeKey: input.dedupeKey ?? null,
        relatedType: input.relatedType ?? null,
        relatedId: input.relatedId ?? null,
        actionUrl: input.actionUrl ?? null,
        scheduledFor: input.scheduledFor ?? new Date(),
      },
    });

    if (input.sendPush !== false && (input.scheduledFor === undefined || input.scheduledFor <= new Date())) {
      const result = await this.push.sendToUser(input.userId, {
        title: notification.title,
        body: notification.body,
        severity: notification.severity,
        actionUrl: notification.actionUrl ?? undefined,
        notificationId: notification.id,
        tag: notification.type,
      });

      await this.prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: result.accepted > 0 ? 'SENT' : result.disabled ? 'PENDING' : 'FAILED',
          sentAt: result.accepted > 0 ? new Date() : null,
          failReason: result.disabled ? 'PUSH_DISABLED_NO_VAPID' : result.failed > 0 ? 'PUSH_DELIVERY_FAILED' : null,
        },
      });

      return {
        created: true,
        notificationId: notification.id,
        deduplicated: false,
        push: result,
      };
    }

    return { created: true, notificationId: notification.id, deduplicated: false };
  }

  async list(
    user: AuthenticatedUser,
    params: { unreadOnly?: boolean; severity?: NotificationSeverity; limit?: number; entityId?: string },
  ) {
    const rows = await this.prisma.notification.findMany({
      where: {
        userId: user.userId,
        readAt: params.unreadOnly ? null : undefined,
        severity: params.severity,
        entityId: params.entityId,
        status: { not: 'CANCELLED' },
      },
      orderBy: [{ scheduledFor: 'desc' }],
      take: Math.min(200, params.limit ?? 50),
      include: { entity: { select: { id: true, code: true, name: true } } },
    });

    const unread = await this.prisma.notification.count({ where: { userId: user.userId, readAt: null } });

    return {
      unread,
      pushEnabledOnServer: this.push.isEnabled(),
      data: rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        severity: row.severity,
        status: row.status,
        entity: row.entity,
        actionUrl: row.actionUrl,
        scheduledFor: row.scheduledFor,
        sentAt: row.sentAt,
        readAt: row.readAt,
        failReason: row.failReason,
      })),
    };
  }

  async markRead(user: AuthenticatedUser, notificationId: string) {
    const notification = await this.prisma.notification.findUnique({ where: { id: notificationId } });
    if (!notification || notification.userId !== user.userId) {
      throw new NotFoundError('Notificación', notificationId);
    }
    await this.prisma.notification.update({
      where: { id: notificationId },
      data: { readAt: new Date(), status: 'READ' },
    });
    return { read: true };
  }

  async markAllRead(user: AuthenticatedUser) {
    const result = await this.prisma.notification.updateMany({
      where: { userId: user.userId, readAt: null },
      data: { readAt: new Date(), status: 'READ' },
    });
    return { marked: result.count };
  }

  /**
   * Reintenta el envío de las notificaciones que quedaron pendientes (por
   * ejemplo, cuando las claves VAPID aún no estaban configuradas).
   */
  async flushPending(limit = 50): Promise<{ attempted: number; sent: number }> {
    if (!this.push.isEnabled()) {
      return { attempted: 0, sent: 0 };
    }

    const pending = await this.prisma.notification.findMany({
      where: { status: 'PENDING', scheduledFor: { lte: new Date() }, readAt: null },
      take: limit,
      orderBy: { scheduledFor: 'asc' },
    });

    let sent = 0;
    for (const notification of pending) {
      const result = await this.push.sendToUser(notification.userId, {
        title: notification.title,
        body: notification.body,
        severity: notification.severity,
        actionUrl: notification.actionUrl ?? undefined,
        notificationId: notification.id,
        tag: notification.type,
      });

      if (result.accepted > 0) {
        sent += 1;
        await this.prisma.notification.update({
          where: { id: notification.id },
          data: { status: 'SENT', sentAt: new Date(), failReason: null },
        });
      }
    }

    return { attempted: pending.length, sent };
  }

  /**
   * TAREAS FINANCIERAS PENDIENTES (spec §12)
   * ----------------------------------------
   * Se calculan SIEMPRE desde datos reales, no desde lo que "debería" haber.
   * Ejemplo: un día sin movimientos NO se considera "faltan movimientos".
   */
  async pendingTasks(
    user: AuthenticatedUser,
    entityId?: string,
  ): Promise<{ tasks: PendingTask[]; mandatoryCount: number; level: string; generatedAt: string; note: string }> {
    const entityIds = await this.access.resolveScope(user.userId, entityId);
    const entities = await this.prisma.financialEntity.findMany({
      where: { id: { in: entityIds } },
      select: { id: true, name: true, code: true },
    });
    const entityName = new Map(entities.map((entity) => [entity.id, entity.name]));

    const today = businessToday();
    const todayIso = businessDateToIso(today);
    const soon = addBusinessDays(today, 7);

    const tasks: PendingTask[] = [];

    // 1. Cierres de días CON movimientos que siguen sin finalizar.
    const daysWithMovements = await this.prisma.financialTransaction.findMany({
      where: { entityId: { in: entityIds }, status: 'POSTED', businessDate: { lte: today } },
      select: { entityId: true, businessDate: true },
      distinct: ['entityId', 'businessDate'],
      orderBy: { businessDate: 'desc' },
      take: 400,
    });

    const closings = await this.prisma.dailyClosing.findMany({
      where: { entityId: { in: entityIds }, businessDate: { lte: today } },
      select: { entityId: true, businessDate: true, status: true, closedAt: true },
    });
    const closedSet = new Set(
      closings.filter((closing) => closing.closedAt !== null).map((closing) => `${closing.entityId}:${businessDateToIso(closing.businessDate)}`),
    );

    for (const day of daysWithMovements) {
      const key = `${day.entityId}:${businessDateToIso(day.businessDate)}`;
      if (closedSet.has(key)) {
        continue;
      }
      const daysLate = Math.round((today.getTime() - day.businessDate.getTime()) / 86_400_000);
      tasks.push({
        id: `closing:${key}`,
        type: 'CLOSING',
        title: daysLate === 0 ? 'Cerrar el día de hoy' : `Cierre atrasado (${businessDateToIso(day.businessDate)})`,
        detail:
          daysLate === 0
            ? 'Revise los movimientos del día, cuente el efectivo y confirme el cierre.'
            : `Han pasado ${daysLate} día(s) sin cerrar este día de negocio.`,
        severity: daysLate === 0 ? 'WARNING' : 'CRITICAL',
        entityId: day.entityId,
        entityName: entityName.get(day.entityId) ?? null,
        amount: null,
        dueDate: businessDateToIso(day.businessDate),
        actionUrl: `/cierres?entityId=${day.entityId}&date=${businessDateToIso(day.businessDate)}`,
        isMandatory: true,
      });
    }

    // 2. Cierres con diferencias sin explicar.
    const differences = await this.prisma.dailyClosing.findMany({
      where: { entityId: { in: entityIds }, status: 'WITH_DIFFERENCES' },
      orderBy: { businessDate: 'desc' },
      take: 30,
    });
    for (const closing of differences) {
      const rows = (closing.differencesJson as unknown as Array<{ accountName?: string; difference?: string; explained?: boolean }> | null) ?? [];
      const unexplained = rows.filter((row) => row.explained === false);
      if (unexplained.length === 0) {
        continue;
      }
      tasks.push({
        id: `difference:${closing.id}`,
        type: 'CASH_DIFFERENCE',
        title: `Diferencia de caja sin explicar (${businessDateToIso(closing.businessDate)})`,
        detail: `${unexplained.length} cuenta(s) con diferencia pendiente de justificar.`,
        severity: 'CRITICAL',
        entityId: closing.entityId,
        entityName: entityName.get(closing.entityId) ?? null,
        amount: closing.difference ? dec(closing.difference).toFixed(2) : null,
        dueDate: businessDateToIso(closing.businessDate),
        actionUrl: `/cierres?entityId=${closing.entityId}&date=${businessDateToIso(closing.businessDate)}`,
        isMandatory: true,
      });
    }

    // 3. Obligaciones que vencen pronto o ya vencieron.
    const [payables, recurrings, loans] = await Promise.all([
      this.prisma.payable.findMany({
        where: { entityId: { in: entityIds }, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] }, dueDate: { lte: soon } },
        include: { counterparty: { select: { name: true } } },
      }),
      this.prisma.recurringObligation.findMany({
        where: { entityId: { in: entityIds }, status: 'ACTIVE', nextDueDate: { lte: soon } },
      }),
      this.prisma.loan.findMany({
        where: { entityId: { in: entityIds }, status: 'ACTIVE', direction: 'PAYABLE', nextDueDate: { lte: soon } },
      }),
    ]);

    for (const payable of payables) {
      const overdue = payable.dueDate !== null && payable.dueDate.getTime() < today.getTime();
      tasks.push({
        id: `payable:${payable.id}`,
        type: 'OBLIGATION',
        title: `${overdue ? 'Vencida' : 'Por pagar'}: ${payable.description}`,
        detail: payable.counterparty?.name ?? 'Cuenta por pagar',
        severity: overdue ? 'CRITICAL' : 'WARNING',
        entityId: payable.entityId,
        entityName: entityName.get(payable.entityId) ?? null,
        amount: payable.originalAmount.minus(payable.settledAmount).toFixed(2),
        dueDate: payable.dueDate ? businessDateToIso(payable.dueDate) : null,
        actionUrl: `/obligaciones?entityId=${payable.entityId}`,
        isMandatory: overdue,
      });
    }

    for (const recurring of recurrings) {
      const overdue = recurring.nextDueDate.getTime() < today.getTime();
      tasks.push({
        id: `recurring:${recurring.id}`,
        type: 'OBLIGATION',
        title: `${overdue ? 'Vencida' : 'Próxima'}: ${recurring.name}`,
        detail: `Obligación ${recurring.frequency.toLowerCase()}`,
        severity: overdue ? 'CRITICAL' : 'INFO',
        entityId: recurring.entityId,
        entityName: entityName.get(recurring.entityId) ?? null,
        amount: recurring.amount.toFixed(2),
        dueDate: businessDateToIso(recurring.nextDueDate),
        actionUrl: `/obligaciones?entityId=${recurring.entityId}`,
        isMandatory: overdue,
      });
    }

    for (const loan of loans) {
      const overdue = loan.nextDueDate !== null && loan.nextDueDate.getTime() < today.getTime();
      tasks.push({
        id: `loan:${loan.id}`,
        type: 'OBLIGATION',
        title: `${overdue ? 'Cuota vencida' : 'Próxima cuota'}: ${loan.name}`,
        detail: `Saldo pendiente ${loan.currentBalance.toFixed(2)}`,
        severity: overdue ? 'CRITICAL' : 'WARNING',
        entityId: loan.entityId,
        entityName: entityName.get(loan.entityId) ?? null,
        amount: loan.installmentAmount ? loan.installmentAmount.toFixed(2) : loan.currentBalance.toFixed(2),
        dueDate: loan.nextDueDate ? businessDateToIso(loan.nextDueDate) : null,
        actionUrl: `/prestamos?entityId=${loan.entityId}`,
        isMandatory: overdue,
      });
    }

    // 4. Operaciones sin confirmar por el servidor.
    const pendingSync = await this.prisma.syncOperation.count({
      where: { userId: user.userId, status: { in: ['RECEIVED', 'ERROR'] } },
    });
    const pendingTransactions = await this.prisma.financialTransaction.count({
      where: { createdByUserId: user.userId, syncStatus: { in: ['PENDING', 'FAILED'] } },
    });
    if (pendingSync + pendingTransactions > 0) {
      tasks.push({
        id: 'sync:pending',
        type: 'SYNC',
        title: `${pendingSync + pendingTransactions} operación(es) sin confirmar por el servidor`,
        detail: 'Estos movimientos existen sólo en el dispositivo y NO están en la contabilidad del servidor.',
        severity: 'CRITICAL',
        entityId: null,
        entityName: null,
        amount: null,
        dueDate: todayIso,
        actionUrl: '/sincronizacion',
        isMandatory: true,
      });
    }

    // 5. Conflictos de sincronización que requieren decisión del usuario.
    const conflicts = await this.prisma.syncOperation.count({ where: { userId: user.userId, status: 'CONFLICT' } });
    if (conflicts > 0) {
      tasks.push({
        id: 'sync:conflicts',
        type: 'SYNC',
        title: `${conflicts} conflicto(s) de sincronización`,
        detail: 'Hay operaciones que no se aplicaron porque ya existían con otros datos. Revíselas y decida.',
        severity: 'CRITICAL',
        entityId: null,
        entityName: null,
        amount: null,
        dueDate: todayIso,
        actionUrl: '/sincronizacion',
        isMandatory: true,
      });
    }

    // 6. Presupuestos excedidos.
    const budgets = await this.prisma.budget.findMany({
      where: { entityId: { in: entityIds }, status: 'ACTIVE' },
      include: { allocations: { include: { category: { select: { name: true } } } } },
    });
    for (const budget of budgets) {
      const spent = await this.prisma.financialTransaction.groupBy({
        by: ['categoryId'],
        where: {
          entityId: budget.entityId,
          kind: 'EXPENSE',
          status: 'POSTED',
          businessDate: { gte: budget.startDate },
          categoryId: { in: budget.allocations.map((allocation) => allocation.categoryId) },
        },
        _sum: { amount: true },
      });
      const spentMap = new Map(spent.map((row) => [row.categoryId as string, dec(row._sum.amount ?? 0)]));

      for (const allocation of budget.allocations) {
        const limit = dec(allocation.limitAmount);
        if (limit.isZero()) {
          continue;
        }
        const used = spentMap.get(allocation.categoryId) ?? dec(0);
        const pct = used.dividedBy(limit).times(100);
        if (pct.lessThan(allocation.alertPct ?? 100)) {
          continue;
        }
        tasks.push({
          id: `budget:${allocation.id}`,
          type: 'BUDGET',
          title: `Presupuesto excedido: ${allocation.category?.name ?? 'categoría'}`,
          detail: `Gastado ${used.toFixed(2)} de ${limit.toFixed(2)} (${pct.toFixed(0)}%)`,
          severity: 'WARNING',
          entityId: budget.entityId,
          entityName: entityName.get(budget.entityId) ?? null,
          amount: used.toFixed(2),
          dueDate: null,
          actionUrl: `/presupuestos?budgetId=${budget.id}`,
          isMandatory: false,
        });
      }
    }

    // Orden: primero lo obligatorio y más grave.
    const severityRank: Record<string, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };
    tasks.sort((a, b) => {
      if (a.isMandatory !== b.isMandatory) {
        return a.isMandatory ? -1 : 1;
      }
      return (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3);
    });

    const mandatoryCount = tasks.filter((task) => task.isMandatory).length;

    return {
      tasks,
      mandatoryCount,
      level: tasks.some((task) => task.severity === 'CRITICAL') ? 'RED' : mandatoryCount > 0 ? 'YELLOW' : 'GREEN',
      generatedAt: new Date().toISOString(),
      note: 'Estas tareas se calculan con datos reales: los días sin movimientos no generan tareas.',
    };
  }

  /** Limpia notificaciones ya leídas y antiguas (mantenimiento del planificador). */
  async pruneRead(olderThanDays = 60): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    const result = await this.prisma.notification.deleteMany({
      where: { readAt: { not: null, lt: cutoff } },
    });
    return result.count;
  }
}
