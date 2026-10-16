import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import { ClosingsService } from '../closings/closings.service.js';
import { addBusinessDays, businessDateToIso, businessToday } from '../domain/business-date.js';
import { dec, percentOf } from '../domain/money.js';

export type TaskSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export interface DailyTask {
  id: string;
  code: string;
  severity: TaskSeverity;
  title: string;
  detail: string;
  /** A dónde debe ir el usuario para resolverlo. */
  route: string;
  entityId: string | null;
  entityName: string | null;
  amount: string | null;
  dueDate: string | null;
  /** Días de retraso (positivo) o días que faltan (negativo). */
  daysOffset: number | null;
}

/**
 * MI CONTROL DIARIO
 * -----------------
 * Convierte los datos reales del sistema en una lista de TAREAS con su motivo y
 * su destino, más un semáforo y unos indicadores de constancia.
 *
 * Reglas de diseño:
 *  · Nada se inventa: cada tarea sale de una consulta a datos reales. Si no hay
 *    datos, no hay tareas (y el semáforo es verde por ausencia de problemas).
 *  · El módulo NO bloquea nada. Avisa y ordena; nunca impide registrar dinero.
 *  · El semáforo se apoya en el cálculo de disciplina que ya existe (una sola
 *    definición de «rojo» en todo el sistema).
 */
@Injectable()
export class DailyControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly closings: ClosingsService,
  ) {}

  async overview(user: AuthenticatedUser, entityId?: string, days = 7) {
    const entityIds = await this.access.resolveScope(user.userId, entityId);
    const today = businessToday();
    const windowStart = addBusinessDays(today, -29);
    const horizon = addBusinessDays(today, days);

    const [entities, discipline] = await Promise.all([
      this.prisma.financialEntity.findMany({
        where: { id: { in: entityIds } },
        select: { id: true, name: true, code: true },
        orderBy: { name: 'asc' },
      }),
      this.closings.discipline(user, entityId),
    ]);

    const entityNameById = new Map(entities.map((entity) => [entity.id, entity.name]));
    const tasks: DailyTask[] = [];

    // --------------------------- 1. Cierres --------------------------------
    const [closings, movementDays] = await Promise.all([
      this.prisma.dailyClosing.findMany({
        where: { entityId: { in: entityIds }, businessDate: { gte: windowStart, lte: today } },
        select: {
          id: true,
          entityId: true,
          businessDate: true,
          status: true,
          difference: true,
          closedAt: true,
          differencesJson: true,
        },
      }),
      this.prisma.financialTransaction.findMany({
        where: { entityId: { in: entityIds }, businessDate: { gte: windowStart, lte: today }, status: 'POSTED' },
        select: { entityId: true, businessDate: true },
        distinct: ['entityId', 'businessDate'],
      }),
    ]);

    const closedKey = new Set(
      closings.filter((row) => row.closedAt !== null).map((row) => `${row.entityId}|${businessDateToIso(row.businessDate)}`),
    );
    const openByKey = new Map(
      closings.map((row) => [`${row.entityId}|${businessDateToIso(row.businessDate)}`, row]),
    );

    for (const entity of entities) {
      const daysForEntity = movementDays
        .filter((row) => row.entityId === entity.id)
        .map((row) => businessDateToIso(row.businessDate))
        .sort();
      const unclosed = daysForEntity.filter((day) => !closedKey.has(`${entity.id}|${day}`));

      // Todo día con movimientos sin cerrar es una tarea, y el retraso importa:
      // un cierre de hoy es una rutina; el de hace una semana es un problema.
      for (const day of unclosed) {
        const offset = Math.round(
          (today.getTime() - new Date(`${day}T00:00:00.000Z`).getTime()) / 86_400_000,
        );
        const isToday = offset === 0;
        tasks.push({
          id: `closing-${entity.id}-${day}`,
          code: isToday ? 'CLOSING_TODAY' : 'CLOSING_OVERDUE',
          severity: isToday ? 'WARNING' : offset > 1 ? 'CRITICAL' : 'WARNING',
          title: isToday ? `Cerrar el día de hoy en ${entity.name}` : `Cierre pendiente del ${day} en ${entity.name}`,
          detail: isToday
            ? `Hay ${daysForEntity.filter((value) => value === day).length > 0 ? 'movimientos registrados hoy' : 'actividad'} y el día sigue abierto. El cierre es lo que confirma que el saldo cuadra.`
            : `Ese día tuvo movimientos y nunca se cerró. Van ${offset} día(s) sin conciliar.`,
          route: `/cierres?entityId=${entity.id}`,
          entityId: entity.id,
          entityName: entity.name,
          amount: null,
          dueDate: day,
          daysOffset: offset,
        });
      }

      // Diferencias de caja sin explicar.
      for (const closing of closings.filter((row) => row.entityId === entity.id)) {
        const differences = (closing.differencesJson as unknown as Array<{ explained?: boolean; difference?: string }> | null) ?? [];
        const unexplained = differences.filter((row) => row?.explained === false);
        if (unexplained.length > 0) {
          tasks.push({
            id: `difference-${closing.id}`,
            code: 'UNEXPLAINED_DIFFERENCE',
            severity: 'CRITICAL',
            title: `Diferencia de caja sin explicar en ${entity.name}`,
            detail: `${unexplained.length} cuenta(s) del cierre del ${businessDateToIso(closing.businessDate)} tienen diferencia sin justificar. Es dinero que no se sabe dónde está.`,
            route: `/cierres?entityId=${entity.id}`,
            entityId: entity.id,
            entityName: entity.name,
            amount: dec(closing.difference ?? 0).toFixed(2),
            dueDate: businessDateToIso(closing.businessDate),
            daysOffset: null,
          });
        }
        // Cierre guardado sin finalizar.
        if (closing.closedAt === null && ['PENDING', 'IN_PROGRESS', 'PROVISIONAL', 'WITH_DIFFERENCES'].includes(closing.status)) {
          const key = `${entity.id}|${businessDateToIso(closing.businessDate)}`;
          if (!tasks.some((task) => task.id === `closing-${key}`)) {
            tasks.push({
              id: `closing-open-${closing.id}`,
              code: 'CLOSING_UNFINISHED',
              severity: 'WARNING',
              title: `Cierre sin finalizar del ${businessDateToIso(closing.businessDate)} en ${entity.name}`,
              detail: 'El recuento está guardado pero el día no se ha dado por cerrado.',
              route: `/cierres?entityId=${entity.id}`,
              entityId: entity.id,
              entityName: entity.name,
              amount: dec(closing.difference ?? 0).toFixed(2),
              dueDate: businessDateToIso(closing.businessDate),
              daysOffset: null,
            });
          }
        }
      }
    }

    // ------------------ 2. Deudas y compromisos que vencen ----------------
    const [loans, recurrings, receivables, payables] = await Promise.all([
      this.prisma.loan.findMany({
        where: { entityId: { in: entityIds }, status: 'ACTIVE' },
        select: { id: true, entityId: true, name: true, direction: true, nextDueDate: true, installmentAmount: true, currentBalance: true },
      }),
      this.prisma.recurringObligation.findMany({
        where: { entityId: { in: entityIds }, status: 'ACTIVE' },
        select: { id: true, entityId: true, name: true, direction: true, nextDueDate: true, amount: true, remindDaysBefore: true },
      }),
      this.prisma.receivable.findMany({
        where: { entityId: { in: entityIds }, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
        select: { id: true, entityId: true, description: true, dueDate: true, originalAmount: true, settledAmount: true },
      }),
      this.prisma.payable.findMany({
        where: { entityId: { in: entityIds }, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
        select: { id: true, entityId: true, description: true, dueDate: true, originalAmount: true, settledAmount: true },
      }),
    ]);

    const dueTask = (
      kind: string,
      id: string,
      entityIdValue: string,
      title: string,
      detail: string,
      dueDate: Date | null,
      amount: string,
      route: string,
    ) => {
      const offset = dueDate ? Math.round((dueDate.getTime() - today.getTime()) / 86_400_000) : null;
      const overdue = offset !== null && offset < 0;
      tasks.push({
        id: `${kind}-${id}`,
        code: overdue ? `${kind.toUpperCase()}_OVERDUE` : `${kind.toUpperCase()}_DUE`,
        severity: overdue ? 'CRITICAL' : 'WARNING',
        title,
        detail,
        route,
        entityId: entityIdValue,
        entityName: entityNameById.get(entityIdValue) ?? null,
        amount,
        dueDate: dueDate ? businessDateToIso(dueDate) : null,
        daysOffset: offset,
      });
    };

    for (const loan of loans) {
      if (!loan.nextDueDate || loan.nextDueDate.getTime() > horizon.getTime()) {
        continue;
      }
      const isDebt = loan.direction === 'PAYABLE';
      dueTask(
        isDebt ? 'debt' : 'collection',
        loan.id,
        loan.entityId,
        isDebt
          ? `Cuota de «${loan.name}» ${loan.nextDueDate.getTime() < today.getTime() ? 'vencida' : 'próxima'}`
          : `Cobro pendiente de «${loan.name}»`,
        `${isDebt ? 'Pagar' : 'Cobrar'} antes del ${businessDateToIso(loan.nextDueDate)}. Capital pendiente: ${dec(loan.currentBalance).toFixed(2)}.`,
        loan.nextDueDate,
        loan.installmentAmount ? dec(loan.installmentAmount).toFixed(2) : dec(loan.currentBalance).toFixed(2),
        '/deudas',
      );
    }

    for (const recurring of recurrings) {
      const remindFrom = addBusinessDays(recurring.nextDueDate, -Math.max(0, recurring.remindDaysBefore));
      if (remindFrom.getTime() > today.getTime()) {
        continue;
      }
      dueTask(
        'recurring',
        recurring.id,
        recurring.entityId,
        `Compromiso «${recurring.name}»`,
        `${recurring.direction === 'PAYABLE' ? 'Por pagar' : 'Por cobrar'} el ${businessDateToIso(recurring.nextDueDate)}. Al registrarlo se genera el movimiento del período.`,
        recurring.nextDueDate,
        dec(recurring.amount).toFixed(2),
        '/obligaciones',
      );
    }

    for (const receivable of receivables) {
      if (!receivable.dueDate || receivable.dueDate.getTime() > horizon.getTime()) {
        continue;
      }
      const pending = dec(receivable.originalAmount).minus(dec(receivable.settledAmount));
      dueTask(
        'receivable',
        receivable.id,
        receivable.entityId,
        `Cobro pendiente: ${receivable.description}`,
        `Vence el ${businessDateToIso(receivable.dueDate)}. Sin cobrar: ${pending.toFixed(2)}.`,
        receivable.dueDate,
        pending.toFixed(2),
        '/obligaciones',
      );
    }

    for (const payable of payables) {
      if (!payable.dueDate || payable.dueDate.getTime() > horizon.getTime()) {
        continue;
      }
      const pending = dec(payable.originalAmount).minus(dec(payable.settledAmount));
      dueTask(
        'payable',
        payable.id,
        payable.entityId,
        `Pago pendiente: ${payable.description}`,
        `Vence el ${businessDateToIso(payable.dueDate)}. Sin pagar: ${pending.toFixed(2)}.`,
        payable.dueDate,
        pending.toFixed(2),
        '/obligaciones',
      );
    }

    // ------------- 3. Gastos sin categoría (dinero sin explicación) --------
    const uncategorized = await this.prisma.financialTransaction.groupBy({
      by: ['entityId'],
      where: {
        entityId: { in: entityIds },
        kind: 'EXPENSE',
        categoryId: null,
        status: 'POSTED',
        businessDate: { gte: windowStart, lte: today },
      },
      _count: { _all: true },
      _sum: { amount: true },
    });

    for (const row of uncategorized) {
      const count = row._count._all;
      if (count === 0) {
        continue;
      }
      tasks.push({
        id: `uncategorized-${row.entityId}`,
        code: 'UNCATEGORIZED_EXPENSE',
        severity: 'WARNING',
        title: `${count} gasto(s) sin categoría en ${entityNameById.get(row.entityId) ?? 'una unidad'}`,
        detail: `Total ${dec(row._sum.amount ?? 0).toFixed(2)} en los últimos 30 días. Sin categoría no se puede saber en qué se fue el dinero.`,
        route: '/movimientos',
        entityId: row.entityId,
        entityName: entityNameById.get(row.entityId) ?? null,
        amount: dec(row._sum.amount ?? 0).toFixed(2),
        dueDate: null,
        daysOffset: null,
      });
    }

    // ---------------- 4. Operaciones sin confirmar por el servidor ---------
    const syncIssues = await this.prisma.syncOperation.groupBy({
      by: ['status'],
      where: { userId: user.userId, status: { in: ['RECEIVED', 'CONFLICT', 'REJECTED'] } },
      _count: { _all: true },
    });
    for (const row of syncIssues) {
      const count = row._count._all;
      if (count === 0) {
        continue;
      }
      const isProblem = row.status === 'CONFLICT' || row.status === 'REJECTED';
      tasks.push({
        id: `sync-${row.status}`,
        code: isProblem ? 'SYNC_REJECTED' : 'SYNC_PENDING',
        severity: isProblem ? 'CRITICAL' : 'WARNING',
        title: isProblem
          ? `${count} operación(es) rechazada(s) al sincronizar`
          : `${count} operación(es) pendientes de confirmar`,
        detail: isProblem
          ? 'El servidor no las aceptó y siguen guardadas en el dispositivo. Hasta resolverlas, ese dinero está apuntado pero no confirmado.'
          : 'Se enviarán solas al recuperar la conexión. Todavía no están confirmadas por el servidor.',
        route: '/mas?tab=sincronizacion',
        entityId: null,
        entityName: null,
        amount: null,
        dueDate: null,
        daysOffset: null,
      });
    }

    // --------------------------- 5. Presupuestos --------------------------
    for (const entityStatus of discipline.entities) {
      const metrics = entityStatus.metrics as { budgetExceeded?: number; budgetWarning?: number } | undefined;
      if ((metrics?.budgetExceeded ?? 0) > 0) {
        tasks.push({
          id: `budget-exceeded-${entityStatus.entityId}`,
          code: 'BUDGET_EXCEEDED',
          severity: 'WARNING',
          title: `${metrics?.budgetExceeded} presupuesto(s) excedido(s) en ${entityStatus.entityName}`,
          detail: 'El gasto ya superó el límite que usted mismo fijó para el período.',
          route: `/presupuestos?entityId=${entityStatus.entityId}`,
          entityId: entityStatus.entityId,
          entityName: entityStatus.entityName,
          amount: null,
          dueDate: null,
          daysOffset: null,
        });
      }
    }

    // ------------------------- 6. Constancia (rachas) ---------------------
    const streaks = await this.streaks(user, entityId);

    const bySeverity = {
      critical: tasks.filter((task) => task.severity === 'CRITICAL').length,
      warning: tasks.filter((task) => task.severity === 'WARNING').length,
      info: tasks.filter((task) => task.severity === 'INFO').length,
    };

    const level =
      bySeverity.critical > 0 ? 'RED' : bySeverity.warning > 0 ? 'YELLOW' : 'GREEN';

    const ordered: DailyTask[] = tasks.sort((left, right) => {
      const weight = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;
      if (weight[left.severity] !== weight[right.severity]) {
        return weight[left.severity] - weight[right.severity];
      }
      return (right.daysOffset ?? 0) * -1 - (left.daysOffset ?? 0) * -1;
    });

    return {
      generatedAt: new Date().toISOString(),
      entityId: entityId ?? null,
      businessDate: businessDateToIso(today),
      level,
      headline: this.headline(level, bySeverity, ordered),
      counts: { ...bySeverity, total: tasks.length },
      tasks: ordered,
      streaks,
      discipline: discipline.entities,
      /** Se conserva el detalle ya calculado para no tener dos definiciones de «rojo». */
      disciplineLevel: discipline.level,
    };
  }

  /**
   * Constancia: días seguidos cerrando, y cumplimiento de la semana y del mes.
   * Sólo cuenta días que tuvieron movimientos o que ya estaban cerrados: exigir
   * un cierre de un día festivo sin actividad sería una alarma inventada.
   */
  async streaks(user: AuthenticatedUser, entityId?: string) {
    const entityIds = await this.access.resolveScope(user.userId, entityId);
    const today = businessToday();
    const from = addBusinessDays(today, -89);

    const [closings, activity] = await Promise.all([
      this.prisma.dailyClosing.findMany({
        where: { entityId: { in: entityIds }, businessDate: { gte: from, lte: today }, closedAt: { not: null } },
        select: { entityId: true, businessDate: true },
      }),
      this.prisma.financialTransaction.findMany({
        where: { entityId: { in: entityIds }, businessDate: { gte: from, lte: today }, status: 'POSTED' },
        select: { entityId: true, businessDate: true },
        distinct: ['entityId', 'businessDate'],
      }),
    ]);

    const closedDays = new Set(closings.map((row) => businessDateToIso(row.businessDate)));
    const activityDays = new Set(activity.map((row) => businessDateToIso(row.businessDate)));
    const relevantDays = new Set([...closedDays, ...activityDays]);

    // Racha: se recorre hacia atrás desde hoy. Hasta 3 días seguidos sin
    // actividad no rompen la racha (fin de semana, festivo).
    let consecutive = 0;
    let skippedEmpty = 0;
    for (let offset = 0; offset < 90; offset += 1) {
      const day = businessDateToIso(addBusinessDays(today, -offset));
      const hasActivity = relevantDays.has(day);
      const isClosed = closedDays.has(day);
      if (isClosed) {
        consecutive += 1;
        skippedEmpty = 0;
        continue;
      }
      if (!hasActivity && skippedEmpty < 3) {
        skippedEmpty += 1;
        continue;
      }
      break;
    }

    const week = await this.complianceWindow(relevantDays, closedDays, 7, today);
    const month = await this.complianceWindow(
      relevantDays,
      closedDays,
      today.getUTCDate(),
      today,
    );

    return {
      consecutiveClosedDays: consecutive,
      closedDaysLast30: [...Array(30).keys()].filter((offset) =>
        closedDays.has(businessDateToIso(addBusinessDays(today, -offset))),
      ).length,
      week,
      month,
      bestEver:
        (await this.prisma.dailyClosing.count({
          where: { entityId: { in: entityIds }, closedAt: { not: null } },
        })) > 0,
    };
  }

  private async complianceWindow(
    relevantDays: Set<string>,
    closedDays: Set<string>,
    days: number,
    today: Date,
  ) {
    let required = 0;
    let done = 0;
    for (let offset = 0; offset < days; offset += 1) {
      const day = businessDateToIso(addBusinessDays(today, -offset));
      if (!relevantDays.has(day) && !closedDays.has(day)) {
        continue;
      }
      required += 1;
      if (closedDays.has(day)) {
        done += 1;
      }
    }
    return {
      daysWithActivity: required,
      daysClosed: done,
      compliancePct: required === 0 ? '100.00' : percentOf(done, required).toFixed(2),
    };
  }

  private headline(
    level: string,
    counts: { critical: number; warning: number; info: number },
    tasks: DailyTask[],
  ): string {
    if (level === 'GREEN') {
      return 'Todo al día. No hay tareas pendientes.';
    }
    if (level === 'RED') {
      const first = tasks[0];
      return `${counts.critical} asunto(s) que requieren atención hoy: ${first?.title ?? ''}`.trim();
    }
    return `${counts.warning} tarea(s) por resolver. Empiece por: ${tasks[0]?.title ?? ''}`.trim();
  }
}
