import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import {
  addBusinessDays,
  addBusinessMonths,
  businessDateToIso,
  businessToday,
  resolveRangePreset,
  startOfBusinessMonth,
  type RangePreset,
} from '../domain/business-date.js';
import { dec, percentOf, round2, sum } from '../domain/money.js';
import { balancesForAccounts, ledgerResultByDay } from '../ledger/ledger-core.js';

/**
 * DASHBOARD FINANCIERO
 * --------------------
 * Reglas de presentación que el usuario pidió explícitamente:
 *  · Los indicadores PROVISIONALES (hay movimientos sin confirmar por el
 *    servidor) se marcan como tales y nunca se mezclan con las cifras
 *    conciliadas.
 *  · Las transferencias internas NUNCA aparecen como ingreso.
 *  · El "dinero disponible" no incluye tarjetas de crédito ni cuentas por
 *    cobrar: eso es deuda y promesas de cobro, no dinero en la mano.
 *  · "Resultado" = ingresos − gastos reales (no incluye préstamos cobrados ni
 *    retiros del propietario).
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  /** Filtro de movimientos que SÍ afectan al resultado (ingresos y gastos). */
  private readonly resultFilter = { in: ['INCOME', 'EXPENSE'] as const };

  private movementWhere(entityIds: string[], from: Date, to: Date, entities?: string[]): Prisma.FinancialTransactionWhereInput {
    return {
      entityId: { in: entities && entities.length > 0 ? entities : entityIds },
      status: 'POSTED',
      businessDate: { gte: from, lte: to },
    };
  }

  /**
   * Panel principal: todo lo que el usuario necesita ver al abrir la app.
   */
  async summary(
    user: AuthenticatedUser,
    params: { entityId?: string; preset?: RangePreset; from?: string; to?: string },
  ) {
    const entityIds = await this.access.resolveScope(user.userId, params.entityId);
    const today = businessToday();
    const range = params.from
      ? { from: new Date(`${params.from}T00:00:00.000Z`), to: params.to ? new Date(`${params.to}T00:00:00.000Z`) : today }
      : resolveRangePreset(params.preset ?? 'TODAY', today);

    const monthStart = startOfBusinessMonth(today);

    const [
      todayGroups,
      rangeGroups,
      monthGroups,
      accounts,
      pendingClosings,
      todayClosing,
      debtAgg,
      receivableAgg,
      upcoming,
      unsynced,
      budgetTotals,
    ] = await Promise.all([
      // Hoy
      this.prisma.financialTransaction.groupBy({
        by: ['kind'],
        where: this.movementWhere(entityIds, today, today),
        _sum: { amount: true },
        _count: { _all: true },
      }),
      // Rango seleccionado
      this.prisma.financialTransaction.groupBy({
        by: ['kind'],
        where: this.movementWhere(entityIds, range.from, range.to),
        _sum: { amount: true },
      }),
      // Mes en curso (para retiros del propietario)
      this.prisma.financialTransaction.groupBy({
        by: ['kind'],
        where: this.movementWhere(entityIds, monthStart, today),
        _sum: { amount: true },
      }),
      // Cuentas y saldos reales
      this.prisma.financialAccount.findMany({
        where: { entityId: { in: entityIds }, status: { not: 'CLOSED' } },
        include: { ledgerAccount: { select: { normalBalance: true } } },
      }),
      // Cierres pendientes (días con movimientos sin cerrar)
      this.countPendingClosings(entityIds, today),
      this.prisma.dailyClosing.findMany({
        where: { entityId: { in: entityIds }, businessDate: today },
        select: { entityId: true, status: true, difference: true, closedAt: true },
      }),
      this.prisma.loan.aggregate({
        _sum: { currentBalance: true },
        where: { entityId: { in: entityIds }, direction: 'PAYABLE', status: 'ACTIVE' },
      }),
      this.prisma.receivable.aggregate({
        _sum: { originalAmount: true, settledAmount: true },
        where: { entityId: { in: entityIds }, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
      }),
      this.prisma.recurringObligation.findMany({
        where: { entityId: { in: entityIds }, status: 'ACTIVE', nextDueDate: { lte: addBusinessDays(today, 7) } },
        select: { id: true, name: true, amount: true, nextDueDate: true, entityId: true },
        orderBy: { nextDueDate: 'asc' },
        take: 10,
      }),
      this.prisma.syncOperation.count({ where: { userId: user.userId, status: { in: ['RECEIVED', 'ERROR'] } } }),
      this.prisma.budgetAllocation.aggregate({
        _sum: { limitAmount: true },
        where: { budget: { entityId: { in: entityIds }, status: 'ACTIVE' } },
      }),
    ]);

    const todayIncome = dec(todayGroups.find((row) => row.kind === 'INCOME')?._sum.amount ?? 0);
    const todayExpense = dec(todayGroups.find((row) => row.kind === 'EXPENSE')?._sum.amount ?? 0);
    const todayCount = todayGroups.reduce((acc, row) => acc + row._count._all, 0);

    /**
     * El resultado del período se toma del LIBRO MAYOR, no de sumar movimientos
     * por su tipo. Motivo comprobado en las pruebas de integridad: el pago de una
     * cuota de préstamo es un solo movimiento, pero su asiento lleva intereses
     * (gasto real) y capital (menos deuda). Sumando por tipo, los intereses
     * desaparecían del resultado del mes y el beneficio salía inflado.
     */
    const ledgerResult = await ledgerResultByDay(this.prisma, {
      entityIds,
      from: range.from,
      to: range.to,
    });
    const todayIso = businessDateToIso(today);
    const rangeIncome = sum([...ledgerResult.values()].map((row) => row.income));
    const rangeExpense = sum([...ledgerResult.values()].map((row) => row.expense));
    const todayLedgerRows = [...ledgerResult.entries()]
      .filter(([key]) => key.endsWith(`|${todayIso}`))
      .map(([, row]) => row);
    const ledgerTodayIncome = sum(todayLedgerRows.map((row) => row.income));
    const ledgerTodayExpense = sum(todayLedgerRows.map((row) => row.expense));

    // Si el resultado del libro no coincide con la suma por tipo, se deja dicho
    // en lugar de esconderlo: significa que hay operaciones cuyo asiento tiene
    // más efecto que su tipo (el caso típico: intereses de un préstamo).
    const resultDifference = round2(
      sum([...ledgerResult.values()].map((row) => row.income.minus(row.expense))).minus(
        dec(rangeGroups.find((row) => row.kind === 'INCOME')?._sum.amount ?? 0).minus(
          dec(rangeGroups.find((row) => row.kind === 'EXPENSE')?._sum.amount ?? 0),
        ),
      ),
    );

    const withdrawals = dec(monthGroups.find((row) => row.kind === 'OWNER_WITHDRAWAL')?._sum.amount ?? 0);
    const contributions = dec(monthGroups.find((row) => row.kind === 'OWNER_CONTRIBUTION')?._sum.amount ?? 0);

    const balances = await balancesForAccounts(this.prisma, {
      financialAccountIds: accounts.map((account) => account.id),
    });

    let availableCash = dec(0);
    let creditCardDebt = dec(0);
    let bankTotal = dec(0);
    let cashTotal = dec(0);

    for (const account of accounts) {
      const balance = dec(balances.get(account.id)?.balance ?? 0);
      const isLiability = account.isCreditCard || account.ledgerAccount.normalBalance === 'CREDIT';

      if (isLiability) {
        creditCardDebt = creditCardDebt.plus(balance);
        continue;
      }
      availableCash = availableCash.plus(balance);
      if (account.type === 'CASH' || account.type === 'BUSINESS_CASH' || account.type === 'DIGITAL_WALLET') {
        cashTotal = cashTotal.plus(balance);
      } else {
        bankTotal = bankTotal.plus(balance);
      }
    }

    const receivablePending = dec(receivableAgg._sum.originalAmount ?? 0).minus(
      dec(receivableAgg._sum.settledAmount ?? 0),
    );
    const totalDebt = dec(debtAgg._sum.currentBalance ?? 0).plus(creditCardDebt);

    // Presupuesto consumido en el mes en curso.
    const budgetSpentRows = await this.prisma.financialTransaction.groupBy({
      by: ['categoryId'],
      where: { ...this.movementWhere(entityIds, monthStart, today), kind: 'EXPENSE' },
      _sum: { amount: true },
    });
    const budgets = await this.prisma.budget.findMany({
      where: { entityId: { in: entityIds }, status: 'ACTIVE' },
      include: { allocations: true },
    });

    let budgetLimit = dec(0);
    let budgetSpent = dec(0);
    for (const budget of budgets) {
      for (const allocation of budget.allocations) {
        budgetLimit = budgetLimit.plus(dec(allocation.limitAmount));
        const spent = budgetSpentRows.find((row) => row.categoryId === allocation.categoryId)?._sum.amount ?? 0;
        budgetSpent = budgetSpent.plus(dec(spent));
      }
    }
    if (budgetLimit.isZero()) {
      budgetLimit = dec(budgetTotals._sum.limitAmount ?? 0);
    }

    const pendingClosingsCount = pendingClosings;
    const closingsToday = todayClosing.filter((closing) => closing.closedAt !== null).length;

    // Calidad del dato: lo provisional JAMÁS se presenta como conciliado.
    const dataQuality = {
      isProvisional: unsynced > 0,
      unsyncedOperations: unsynced,
      pendingClosings: pendingClosingsCount,
      closingsFinalizedToday: closingsToday,
      closingsRequiredToday: entityIds.length,
      message:
        unsynced > 0
          ? `Hay ${unsynced} operación(es) sin confirmar por el servidor: las cifras son PROVISIONALES.`
          : pendingClosingsCount > 0
            ? `Hay ${pendingClosingsCount} día(s) con movimientos sin cerrar.`
            : 'Cifras conciliadas con el libro mayor.',
    };

    return {
      range: { from: businessDateToIso(range.from), to: businessDateToIso(range.to), preset: params.preset ?? 'TODAY' },
      today: {
        income: ledgerTodayIncome.toFixed(2),
        expense: ledgerTodayExpense.toFixed(2),
        result: round2(ledgerTodayIncome.minus(ledgerTodayExpense)).toFixed(2),
        movementCount: todayCount,
      },
      period: {
        income: rangeIncome.toFixed(2),
        expense: rangeExpense.toFixed(2),
        result: round2(rangeIncome.minus(rangeExpense)).toFixed(2),
        margin: percentOf(rangeIncome.minus(rangeExpense), rangeIncome).toFixed(2),
      },
      money: {
        availableCash: availableCash.toFixed(2),
        inCash: cashTotal.toFixed(2),
        inBanks: bankTotal.toFixed(2),
        note: 'El dinero disponible NO incluye tarjetas de crédito ni cuentas por cobrar.',
      },
      obligations: {
        totalDebt: totalDebt.toFixed(2),
        loanDebt: dec(debtAgg._sum.currentBalance ?? 0).toFixed(2),
        creditCardDebt: creditCardDebt.toFixed(2),
        receivables: receivablePending.toFixed(2),
        upcomingPayments: upcoming.map((row) => ({
          id: row.id,
          name: row.name,
          amount: row.amount.toFixed(2),
          dueDate: row.nextDueDate,
          daysRemaining: Math.round((row.nextDueDate.getTime() - today.getTime()) / 86_400_000),
        })),
        upcomingTotal: sum(upcoming.map((row) => row.amount)).toFixed(2),
      },
      owner: {
        withdrawalsThisMonth: withdrawals.toFixed(2),
        contributionsThisMonth: contributions.toFixed(2),
        netExtracted: round2(withdrawals.minus(contributions)).toFixed(2),
      },
      budget: {
        limit: budgetLimit.toFixed(2),
        spent: budgetSpent.toFixed(2),
        remaining: round2(budgetLimit.minus(budgetSpent)).toFixed(2),
        percentUsed: percentOf(budgetSpent, budgetLimit).toFixed(2),
      },
      closings: {
        today: todayClosing.map((closing) => ({
          entityId: closing.entityId,
          status: closing.status,
          closed: closing.closedAt !== null,
          difference: closing.difference?.toFixed(2) ?? null,
        })),
        pendingDays: pendingClosingsCount,
      },
      dataQuality: {
        ...dataQuality,
        /** El libro y la suma por tipo deberían coincidir; si no, se dice. */
        resultFromLedger: round2(rangeIncome.minus(rangeExpense)).toFixed(2),
        resultDifference: resultDifference.toFixed(2),
        resultNote:
          resultDifference.isZero()
            ? 'El resultado del período coincide con el libro mayor.'
            : `El libro incluye ${resultDifference.abs().toFixed(2)} que no son movimientos de ingreso ni gasto (intereses de préstamos, ajustes de gasto, etc.). El resultado mostrado YA los incluye.`,
      },
    };
  }

  /**
   * Series para las gráficas: ingresos vs gastos por día, gastos por categoría,
   * evolución del saldo y comparación entre unidades financieras.
   */
  async charts(user: AuthenticatedUser, params: { entityId?: string; days?: number }) {
    const entityIds = await this.access.resolveScope(user.userId, params.entityId);
    const days = Math.min(180, Math.max(7, params.days ?? 30));
    const today = businessToday();
    const from = addBusinessDays(today, -(days - 1));

    const [transactions, categories, entities, accounts, transfers] = await Promise.all([
      this.prisma.financialTransaction.findMany({
        where: this.movementWhere(entityIds, from, today, params.entityId ? [params.entityId] : undefined),
        select: { businessDate: true, kind: true, amount: true, categoryId: true, entityId: true },
      }),
      this.prisma.transactionCategory.findMany({ select: { id: true, name: true, kind: true } }),
      this.prisma.financialEntity.findMany({
        where: { id: { in: entityIds } },
        select: { id: true, code: true, name: true },
      }),
      this.prisma.financialAccount.findMany({
        where: { entityId: { in: entityIds }, status: { not: 'CLOSED' } },
        select: { id: true, name: true, openingBalance: true, openingDate: true, ledgerAccount: { select: { normalBalance: true } } },
      }),
      this.prisma.transfer.findMany({
        where: { businessDate: { gte: from, lte: today }, OR: [{ entityId: { in: entityIds } }, { toAccount: { entityId: { in: entityIds } } }] },
        select: { businessDate: true, amount: true, isCrossEntity: true },
      }),
    ]);

    const categoryName = new Map(categories.map((category) => [category.id, category.name]));
    const entityName = new Map(entities.map((entity) => [entity.id, entity.name]));

    // Ingresos y gastos REALES por día y por unidad, tomados del libro mayor.
    const ledgerSeries = await ledgerResultByDay(this.prisma, { entityIds, from, to: today });

    // Serie diaria (se rellenan los días sin movimientos con 0).
    const dailySeries: Array<{ date: string; income: string; expense: string; result: string; movements: number }> = [];
    const dayMap = new Map<string, { income: ReturnType<typeof dec>; expense: ReturnType<typeof dec>; count: number }>();

    for (let index = 0; index < days; index += 1) {
      dayMap.set(businessDateToIso(addBusinessDays(from, index)), { income: dec(0), expense: dec(0), count: 0 });
    }

    for (const [key, row] of ledgerSeries.entries()) {
      const bucket = dayMap.get(key.split('|')[1]);
      if (bucket) {
        bucket.income = bucket.income.plus(row.income);
        bucket.expense = bucket.expense.plus(row.expense);
      }
    }

    // El contador de movimientos sí sale de los movimientos (es un dato físico).
    for (const transaction of transactions) {
      const bucket = dayMap.get(businessDateToIso(transaction.businessDate));
      if (bucket) {
        bucket.count += 1;
      }
    }

    for (const [date, bucket] of [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      dailySeries.push({
        date,
        income: bucket.income.toFixed(2),
        expense: bucket.expense.toFixed(2),
        result: round2(bucket.income.minus(bucket.expense)).toFixed(2),
        movements: bucket.count,
      });
    }

    // Gastos por categoría (detalle de los movimientos de gasto registrados).
    const byCategory = new Map<string, ReturnType<typeof dec>>();
    for (const transaction of transactions) {
      if (transaction.kind !== 'EXPENSE' || !transaction.categoryId) {
        continue;
      }
      byCategory.set(transaction.categoryId, (byCategory.get(transaction.categoryId) ?? dec(0)).plus(transaction.amount));
    }

    // El gasto del libro puede incluir partidas SIN movimiento de tipo gasto
    // (intereses de préstamos, sobre todo). Se añaden como partida propia para
    // que el desglose sume EXACTAMENTE lo mismo que el indicador de gastos.
    const ledgerExpenseTotal = sum([...ledgerSeries.values()].map((row) => row.expense));
    const categorizedTotal = sum([...byCategory.values()]);
    const uncategorizedByLedger = round2(ledgerExpenseTotal.minus(categorizedTotal));
    if (uncategorizedByLedger.greaterThan(0)) {
      byCategory.set('__ledger_other__', uncategorizedByLedger);
    }

    const expenseByCategory = [...byCategory.entries()]
      .map(([categoryId, amount]) => ({
        categoryId,
        categoryName:
          categoryId === '__ledger_other__'
            ? 'Intereses y otros gastos financieros'
            : (categoryName.get(categoryId) ?? 'Sin categoría'),
        amount: amount.toFixed(2),
        share: percentOf(amount, sum([...byCategory.values()])).toFixed(2),
      }))
      .sort((a, b) => Number(b.amount) - Number(a.amount));

    // Comparación entre unidades financieras.
    const byEntity = new Map<string, { income: ReturnType<typeof dec>; expense: ReturnType<typeof dec>; withdrawals: ReturnType<typeof dec> }>();
    for (const entity of entities) {
      byEntity.set(entity.id, { income: dec(0), expense: dec(0), withdrawals: dec(0) });
    }
    for (const [key, row] of ledgerSeries.entries()) {
      const bucket = byEntity.get(key.split('|')[0]);
      if (bucket) {
        bucket.income = bucket.income.plus(row.income);
        bucket.expense = bucket.expense.plus(row.expense);
      }
    }
    for (const transaction of transactions) {
      const bucket = byEntity.get(transaction.entityId);
      if (!bucket) {
        continue;
      }
      if (transaction.kind === 'OWNER_WITHDRAWAL') {
        bucket.withdrawals = bucket.withdrawals.plus(transaction.amount);
      }
    }
    const entitiesComparison = [...byEntity.entries()].map(([entityId, bucket]) => ({
      entityId,
      entityName: entityName.get(entityId) ?? '',
      income: bucket.income.toFixed(2),
      expense: bucket.expense.toFixed(2),
      result: round2(bucket.income.minus(bucket.expense)).toFixed(2),
      withdrawals: bucket.withdrawals.toFixed(2),
    }));

    // Evolución del saldo de efectivo/banco (a partir del libro mayor).
    const balances = await balancesForAccounts(this.prisma, {
      financialAccountIds: accounts.map((account) => account.id),
    });
    let totalCash = dec(0);
    let totalLiabilities = dec(0);
    const accountBreakdown = accounts.map((account) => {
      const balance = dec(balances.get(account.id)?.balance ?? 0);
      if (account.ledgerAccount.normalBalance === 'CREDIT') {
        totalLiabilities = totalLiabilities.plus(balance);
      } else {
        totalCash = totalCash.plus(balance);
      }
      return {
        accountId: account.id,
        name: account.name,
        balance: balance.toFixed(2),
        isLiability: account.ledgerAccount.normalBalance === 'CREDIT',
      };
    });

    // Tendencia mensual (últimos 6 meses).
    const monthly: Array<{ month: string; income: string; expense: string; result: string }> = [];
    for (let offset = 5; offset >= 0; offset -= 1) {
      const monthStart = startOfBusinessMonth(addBusinessMonths(today, -offset));
      const monthEnd = addBusinessMonths(monthStart, 1);
      const rows = await this.prisma.financialTransaction.groupBy({
        by: ['kind'],
        where: { entityId: { in: entityIds }, status: 'POSTED', businessDate: { gte: monthStart, lt: monthEnd } },
        _sum: { amount: true },
      });
      const income = dec(rows.find((row) => row.kind === 'INCOME')?._sum.amount ?? 0);
      const expense = dec(rows.find((row) => row.kind === 'EXPENSE')?._sum.amount ?? 0);
      monthly.push({
        month: businessDateToIso(monthStart).slice(0, 7),
        income: income.toFixed(2),
        expense: expense.toFixed(2),
        result: round2(income.minus(expense)).toFixed(2),
      });
    }

    const internalTransfers = transfers.filter((transfer) => !transfer.isCrossEntity);

    return {
      range: { from: businessDateToIso(from), to: businessDateToIso(today), days },
      dailySeries,
      expenseByCategory,
      entitiesComparison,
      cashEvolution: {
        totalCash: totalCash.toFixed(2),
        totalLiabilities: totalLiabilities.toFixed(2),
        accounts: accountBreakdown,
        note: 'Saldos calculados desde el libro mayor, no introducidos a mano.',
      },
      monthlyTrend: monthly,
      transfers: {
        count: transfers.length,
        internalCount: internalTransfers.length,
        total: sum(transfers.map((transfer) => transfer.amount)).toFixed(2),
        note: 'Las transferencias no son ingresos: sólo cambian el dinero de sitio.',
      },
    };
  }

  /**
   * Días con movimientos que aún no tienen cierre. Es la medida honesta del
   * atraso: NO se cuentan los días sin movimientos.
   */
  private async countPendingClosings(entityIds: string[], today: Date): Promise<number> {
    const daysWithMovements = await this.prisma.financialTransaction.findMany({
      where: { entityId: { in: entityIds }, status: 'POSTED', businessDate: { lte: today } },
      select: { entityId: true, businessDate: true },
      distinct: ['entityId', 'businessDate'],
    });

    if (daysWithMovements.length === 0) {
      return 0;
    }

    const closings = await this.prisma.dailyClosing.findMany({
      where: {
        entityId: { in: entityIds },
        businessDate: { lte: today },
        closedAt: { not: null },
      },
      select: { entityId: true, businessDate: true },
    });

    const closed = new Set(
      closings.map((closing) => `${closing.entityId}:${businessDateToIso(closing.businessDate)}`),
    );

    return daysWithMovements.filter(
      (day) => !closed.has(`${day.entityId}:${businessDateToIso(day.businessDate)}`),
    ).length;
  }
}
