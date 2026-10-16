import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import { ValidationError } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import { csvResponse, toCsv, type CsvColumn } from '../common/csv.js';
import {
  addBusinessDays,
  businessDateToIso,
  businessToday,
  startOfBusinessMonth,
  startOfBusinessWeek,
  addBusinessMonths,
} from '../domain/business-date.js';
import { dec, percentOf, round2, sum } from '../domain/money.js';
import { balancesForAccounts, ledgerResultByDay } from '../ledger/ledger-core.js';
import { closingStatusLabel } from '../closings/closing-rules.js';

export const REPORT_TYPES = [
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'BY_ENTITY',
  'CONSOLIDATED',
  'CASH_FLOW',
  'EXPENSES_BY_CATEGORY',
  'OWNER_WITHDRAWALS',
  'ACCOUNT_STATUS',
  'PENDING_OBLIGATIONS',
  'CLOSINGS',
  'BUDGETS',
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

export interface ReportParams {
  entityId?: string;
  from?: string;
  to?: string;
}

export interface ReportColumn {
  key: string;
  header: string;
}

export interface ReportResult {
  type: ReportType;
  title: string;
  period: { from: string; to: string };
  columns: ReportColumn[];
  rows: Array<Record<string, string | number | null>>;
  totals: Record<string, string>;
  /** Advertencias de calidad del dato (por ejemplo, operaciones sin confirmar). */
  warnings: string[];
  generatedAt: string;
}

/**
 * REPORTES Y EXPORTACIONES
 * ------------------------
 * Todos los informes se calculan con MOVIMIENTOS CONFIRMADOS y son
 * REPRODUCIBLES: los mismos datos producen el mismo informe. Cada informe
 * declara su período y avisa si hay operaciones sin confirmar, para que nadie
 * tome una decisión sobre cifras provisionales creyéndolas definitivas.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  private resolveRange(type: ReportType, params: ReportParams): { from: Date; to: Date } {
    const today = businessToday();
    if (params.from) {
      return {
        from: new Date(`${params.from}T00:00:00.000Z`),
        to: params.to ? new Date(`${params.to}T00:00:00.000Z`) : today,
      };
    }
    switch (type) {
      case 'DAILY':
      case 'CASH_FLOW':
        return { from: today, to: today };
      case 'WEEKLY':
        return { from: startOfBusinessWeek(today), to: today };
      case 'MONTHLY':
        return { from: startOfBusinessMonth(today), to: today };
      default:
        return { from: startOfBusinessMonth(today), to: today };
    }
  }

  private async unsyncedCount(userId: string): Promise<number> {
    const [operations, transactions] = await Promise.all([
      this.prisma.syncOperation.count({ where: { userId, status: { in: ['RECEIVED', 'ERROR'] } } }),
      this.prisma.financialTransaction.count({
        where: { createdByUserId: userId, syncStatus: { in: ['PENDING', 'FAILED'] } },
      }),
    ]);
    return operations + transactions;
  }

  async generate(user: AuthenticatedUser, type: ReportType, params: ReportParams): Promise<ReportResult> {
    const entityIds = await this.access.resolveScope(user.userId, params.entityId);
    const range = this.resolveRange(type, params);
    const warnings: string[] = [];

    const unsynced = await this.unsyncedCount(user.userId);
    if (unsynced > 0) {
      warnings.push(
        `${unsynced} operación(es) registradas en el dispositivo NO están confirmadas por el servidor y no se incluyen en este informe.`,
      );
    }

    const base = {
      type,
      period: { from: businessDateToIso(range.from), to: businessDateToIso(range.to) },
      generatedAt: new Date().toISOString(),
      warnings,
    };

    switch (type) {
      case 'DAILY':
      case 'WEEKLY':
      case 'MONTHLY': {
        const rows = await this.incomeExpenseByDay(entityIds, range.from, range.to);
        const totalIncome = sum(rows.map((row) => dec(row.income)));
        const totalExpense = sum(rows.map((row) => dec(row.expense)));
        return {
          ...base,
          title:
            type === 'DAILY' ? 'Reporte diario' : type === 'WEEKLY' ? 'Reporte semanal' : 'Reporte mensual',
          columns: [
            { key: 'date', header: 'Fecha' },
            { key: 'income', header: 'Ingresos' },
            { key: 'expense', header: 'Gastos' },
            { key: 'result', header: 'Resultado' },
            { key: 'movements', header: 'Movimientos' },
          ],
          rows,
          totals: {
            income: totalIncome.toFixed(2),
            expense: totalExpense.toFixed(2),
            result: round2(totalIncome.minus(totalExpense)).toFixed(2),
            movements: String(rows.reduce((acc, row) => acc + Number(row.movements), 0)),
          },
        };
      }

      case 'BY_ENTITY':
      case 'CONSOLIDATED': {
        const entities = await this.prisma.financialEntity.findMany({
          where: { id: { in: entityIds } },
          select: { id: true, code: true, name: true },
        });

        const rows: Array<Record<string, string | number | null>> = [];
        let totalIncome = dec(0);
        let totalExpense = dec(0);
        let totalWithdrawals = dec(0);

        // Ingresos y gastos REALES por unidad, tomados del libro mayor: así el
        // informe coincide con la contabilidad (incluye, por ejemplo, los
        // intereses de un préstamo, que son gasto aunque el movimiento sea de
        // tipo LOAN_PAYMENT).
        const ledgerRows = await ledgerResultByDay(this.prisma, {
          entityIds: entities.map((entity) => entity.id),
          from: range.from,
          to: range.to,
        });
        const ledgerByEntity = new Map<string, { income: ReturnType<typeof dec>; expense: ReturnType<typeof dec> }>();
        for (const [key, row] of ledgerRows.entries()) {
          const entityKey = key.split('|')[0];
          const bucket = ledgerByEntity.get(entityKey) ?? { income: dec(0), expense: dec(0) };
          bucket.income = bucket.income.plus(row.income);
          bucket.expense = bucket.expense.plus(row.expense);
          ledgerByEntity.set(entityKey, bucket);
        }

        for (const entity of entities) {
          const grouped = await this.prisma.financialTransaction.groupBy({
            by: ['kind'],
            where: {
              entityId: entity.id,
              status: 'POSTED',
              businessDate: { gte: range.from, lte: range.to },
            },
            _sum: { amount: true },
          });

          const income = ledgerByEntity.get(entity.id)?.income ?? dec(0);
          const expense = ledgerByEntity.get(entity.id)?.expense ?? dec(0);
          const withdrawals = dec(grouped.find((row) => row.kind === 'OWNER_WITHDRAWAL')?._sum.amount ?? 0);

          totalIncome = totalIncome.plus(income);
          totalExpense = totalExpense.plus(expense);
          totalWithdrawals = totalWithdrawals.plus(withdrawals);

          rows.push({
            entityCode: entity.code,
            entityName: entity.name,
            income: income.toFixed(2),
            expense: expense.toFixed(2),
            result: round2(income.minus(expense)).toFixed(2),
            withdrawals: withdrawals.toFixed(2),
            margin: percentOf(income.minus(expense), income).toFixed(2),
          });
        }

        return {
          ...base,
          title: type === 'CONSOLIDATED' ? 'Reporte consolidado (todas las unidades)' : 'Reporte por negocio',
          columns: [
            { key: 'entityCode', header: 'Código' },
            { key: 'entityName', header: 'Unidad financiera' },
            { key: 'income', header: 'Ingresos' },
            { key: 'expense', header: 'Gastos' },
            { key: 'result', header: 'Resultado' },
            { key: 'withdrawals', header: 'Retiros del propietario' },
            { key: 'margin', header: 'Margen %' },
          ],
          rows,
          totals: {
            income: totalIncome.toFixed(2),
            expense: totalExpense.toFixed(2),
            result: round2(totalIncome.minus(totalExpense)).toFixed(2),
            withdrawals: totalWithdrawals.toFixed(2),
          },
        };
      }

      case 'CASH_FLOW': {
        const grouped = await this.prisma.financialTransaction.groupBy({
          by: ['kind'],
          where: {
            entityId: { in: entityIds },
            status: 'POSTED',
            businessDate: { gte: range.from, lte: range.to },
          },
          _sum: { amount: true },
        });

        const labels: Record<string, string> = {
          INCOME: 'Cobros de ingresos',
          EXPENSE: 'Pagos de gastos',
          TRANSFER_IN: 'Entradas por transferencia (no es ingreso)',
          TRANSFER_OUT: 'Salidas por transferencia (no es gasto)',
          OWNER_WITHDRAWAL: 'Retiros del propietario',
          OWNER_CONTRIBUTION: 'Aportes del propietario',
          LOAN_DISBURSEMENT: 'Préstamos recibidos (no es ingreso)',
          LOAN_PAYMENT: 'Pagos de préstamos',
          CREDIT_CARD_PAYMENT: 'Pagos de tarjeta de crédito',
          RECEIVABLE_SETTLEMENT: 'Cobros de cuentas por cobrar',
          PAYABLE_SETTLEMENT: 'Pagos de cuentas por pagar',
          ADJUSTMENT: 'Ajustes',
        };

        const inflows = ['INCOME', 'TRANSFER_IN', 'OWNER_CONTRIBUTION', 'LOAN_DISBURSEMENT', 'RECEIVABLE_SETTLEMENT'];
        const rows = grouped.map((row) => ({
          kind: labels[row.kind] ?? row.kind,
          direction: inflows.includes(row.kind) ? 'ENTRADA' : 'SALIDA',
          amount: dec(row._sum.amount ?? 0).toFixed(2),
          affectsResult: row.kind === 'INCOME' || row.kind === 'EXPENSE' ? 'Sí' : 'No',
        }));

        const totalIn = sum(
          grouped.filter((row) => inflows.includes(row.kind)).map((row) => dec(row._sum.amount ?? 0)),
        );
        const totalOut = sum(
          grouped.filter((row) => !inflows.includes(row.kind)).map((row) => dec(row._sum.amount ?? 0)),
        );

        return {
          ...base,
          title: 'Flujo de efectivo',
          columns: [
            { key: 'kind', header: 'Concepto' },
            { key: 'direction', header: 'Dirección' },
            { key: 'amount', header: 'Importe' },
            { key: 'affectsResult', header: '¿Afecta al resultado?' },
          ],
          rows,
          totals: {
            inflows: totalIn.toFixed(2),
            outflows: totalOut.toFixed(2),
            net: round2(totalIn.minus(totalOut)).toFixed(2),
          },
        };
      }

      case 'EXPENSES_BY_CATEGORY': {
        const grouped = await this.prisma.financialTransaction.groupBy({
          by: ['categoryId'],
          where: {
            entityId: { in: entityIds },
            status: 'POSTED',
            kind: 'EXPENSE',
            businessDate: { gte: range.from, lte: range.to },
          },
          _sum: { amount: true },
          _count: { _all: true },
        });

        const categories = await this.prisma.transactionCategory.findMany({
          where: { id: { in: grouped.map((row) => row.categoryId as string) } },
          select: { id: true, name: true },
        });
        const nameById = new Map(categories.map((category) => [category.id, category.name]));
        const total = sum(grouped.map((row) => dec(row._sum.amount ?? 0)));

        return {
          ...base,
          title: 'Gastos por categoría',
          columns: [
            { key: 'category', header: 'Categoría' },
            { key: 'amount', header: 'Importe' },
            { key: 'share', header: '% del gasto' },
            { key: 'count', header: 'Movimientos' },
          ],
          rows: grouped
            .map((row) => ({
              category: nameById.get(row.categoryId as string) ?? 'Sin categoría',
              amount: dec(row._sum.amount ?? 0).toFixed(2),
              share: percentOf(row._sum.amount ?? 0, total).toFixed(2),
              count: row._count._all,
            }))
            .sort((a, b) => Number(b.amount) - Number(a.amount)),
          totals: { total: total.toFixed(2) },
        };
      }

      case 'OWNER_WITHDRAWALS': {
        const transactions = await this.prisma.financialTransaction.findMany({
          where: {
            entityId: { in: entityIds },
            status: 'POSTED',
            kind: { in: ['OWNER_WITHDRAWAL', 'OWNER_CONTRIBUTION'] },
            businessDate: { gte: range.from, lte: range.to },
          },
          include: { entity: { select: { code: true, name: true } }, account: { select: { name: true } } },
          orderBy: { businessDate: 'asc' },
        });

        const withdrawals = sum(
          transactions.filter((transaction) => transaction.kind === 'OWNER_WITHDRAWAL').map((transaction) => transaction.amount),
        );
        const contributions = sum(
          transactions.filter((transaction) => transaction.kind === 'OWNER_CONTRIBUTION').map((transaction) => transaction.amount),
        );

        return {
          ...base,
          title: 'Retiros y aportes del propietario',
          columns: [
            { key: 'date', header: 'Fecha' },
            { key: 'entity', header: 'Unidad financiera' },
            { key: 'type', header: 'Tipo' },
            { key: 'account', header: 'Cuenta' },
            { key: 'amount', header: 'Importe' },
            { key: 'description', header: 'Descripción' },
          ],
          rows: transactions.map((transaction) => ({
            date: businessDateToIso(transaction.businessDate),
            entity: transaction.entity.name,
            type: transaction.kind === 'OWNER_WITHDRAWAL' ? 'RETIRO' : 'APORTE',
            account: transaction.account.name,
            amount: transaction.amount.toFixed(2),
            description: transaction.description,
          })),
          totals: {
            withdrawals: withdrawals.toFixed(2),
            contributions: contributions.toFixed(2),
            net: round2(withdrawals.minus(contributions)).toFixed(2),
          },
        };
      }

      case 'ACCOUNT_STATUS': {
        const accounts = await this.prisma.financialAccount.findMany({
          where: { entityId: { in: entityIds } },
          include: {
            entity: { select: { code: true, name: true } },
            ledgerAccount: { select: { code: true, normalBalance: true } },
          },
        });
        const balances = await balancesForAccounts(this.prisma, {
          financialAccountIds: accounts.map((account) => account.id),
          asOf: range.to,
        });

        const rows = accounts.map((account) => {
          const balance = dec(balances.get(account.id)?.balance ?? 0);
          const isLiability = account.ledgerAccount.normalBalance === 'CREDIT';
          return {
            entity: account.entity.name,
            account: account.name,
            type: account.type,
            currency: account.currency,
            nature: isLiability ? 'PASIVO' : 'ACTIVO',
            openingBalance: dec(account.openingBalance).toFixed(2),
            movements: balances.get(account.id)?.movementCount ?? 0,
            balance: balance.toFixed(2),
            status: account.status,
          };
        });

        const assets = sum(
          rows.filter((row) => row.nature === 'ACTIVO').map((row) => dec(row.balance)),
        );
        const liabilities = sum(
          rows.filter((row) => row.nature === 'PASIVO').map((row) => dec(row.balance)),
        );

        return {
          ...base,
          title: 'Estado de cuentas',
          columns: [
            { key: 'entity', header: 'Unidad financiera' },
            { key: 'account', header: 'Cuenta' },
            { key: 'type', header: 'Tipo' },
            { key: 'nature', header: 'Naturaleza' },
            { key: 'openingBalance', header: 'Saldo inicial' },
            { key: 'movements', header: 'Movimientos' },
            { key: 'balance', header: 'Saldo calculado' },
            { key: 'status', header: 'Estado' },
          ],
          rows,
          totals: {
            assets: assets.toFixed(2),
            liabilities: liabilities.toFixed(2),
            net: round2(assets.minus(liabilities)).toFixed(2),
          },
        };
      }

      case 'PENDING_OBLIGATIONS': {
        const [payables, receivables, loans] = await Promise.all([
          this.prisma.payable.findMany({
            where: { entityId: { in: entityIds }, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
            include: { entity: { select: { name: true } }, counterparty: { select: { name: true } } },
          }),
          this.prisma.receivable.findMany({
            where: { entityId: { in: entityIds }, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
            include: { entity: { select: { name: true } }, counterparty: { select: { name: true } } },
          }),
          this.prisma.loan.findMany({
            where: { entityId: { in: entityIds }, status: 'ACTIVE' },
            include: { entity: { select: { name: true } }, counterparty: { select: { name: true } } },
          }),
        ]);

        const rows = [
          ...payables.map((row) => ({
            type: 'POR PAGAR',
            entity: row.entity.name,
            concept: row.description,
            counterparty: row.counterparty?.name ?? '',
            pending: row.originalAmount.minus(row.settledAmount).toFixed(2),
            dueDate: row.dueDate ? businessDateToIso(row.dueDate) : '',
            status: row.status,
          })),
          ...receivables.map((row) => ({
            type: 'POR COBRAR',
            entity: row.entity.name,
            concept: row.description,
            counterparty: row.counterparty?.name ?? '',
            pending: row.originalAmount.minus(row.settledAmount).toFixed(2),
            dueDate: row.dueDate ? businessDateToIso(row.dueDate) : '',
            status: row.status,
          })),
          ...loans.map((row) => ({
            type: row.direction === 'PAYABLE' ? 'PRÉSTAMO (DEUDA)' : 'PRÉSTAMO (A COBRAR)',
            entity: row.entity.name,
            concept: row.name,
            counterparty: row.counterparty?.name ?? '',
            pending: row.currentBalance.toFixed(2),
            dueDate: row.nextDueDate ? businessDateToIso(row.nextDueDate) : '',
            status: row.status,
          })),
        ];

        const toPay = sum(rows.filter((row) => row.type.includes('PAGAR') || row.type.includes('DEUDA')).map((row) => dec(row.pending)));
        const toCollect = sum(rows.filter((row) => row.type.includes('COBRAR')).map((row) => dec(row.pending)));

        return {
          ...base,
          title: 'Obligaciones pendientes',
          columns: [
            { key: 'type', header: 'Tipo' },
            { key: 'entity', header: 'Unidad financiera' },
            { key: 'concept', header: 'Concepto' },
            { key: 'counterparty', header: 'Contraparte' },
            { key: 'pending', header: 'Pendiente' },
            { key: 'dueDate', header: 'Vencimiento' },
            { key: 'status', header: 'Estado' },
          ],
          rows,
          totals: { toPay: toPay.toFixed(2), toCollect: toCollect.toFixed(2), net: round2(toCollect.minus(toPay)).toFixed(2) },
        };
      }

      case 'CLOSINGS': {
        const closings = await this.prisma.dailyClosing.findMany({
          where: { entityId: { in: entityIds }, businessDate: { gte: range.from, lte: range.to } },
          include: { entity: { select: { name: true } }, closedBy: { select: { name: true } } },
          orderBy: { businessDate: 'asc' },
        });

        return {
          ...base,
          title: 'Cierres diarios y diferencias',
          columns: [
            { key: 'date', header: 'Fecha' },
            { key: 'entity', header: 'Unidad financiera' },
            { key: 'status', header: 'Estado' },
            { key: 'expected', header: 'Esperado' },
            { key: 'counted', header: 'Contado' },
            { key: 'difference', header: 'Diferencia' },
            { key: 'version', header: 'Versión' },
            { key: 'reopenCount', header: 'Reaperturas' },
            { key: 'closedBy', header: 'Cerrado por' },
          ],
          rows: closings.map((closing) => ({
            date: businessDateToIso(closing.businessDate),
            entity: closing.entity.name,
            status: closingStatusLabel(closing.status),
            expected: closing.expectedCash?.toFixed(2) ?? '',
            counted: closing.countedCash?.toFixed(2) ?? '',
            difference: closing.difference?.toFixed(2) ?? '',
            version: closing.version,
            reopenCount: closing.reopenCount,
            closedBy: closing.closedBy?.name ?? '',
          })),
          totals: {
            closings: String(closings.length),
            finalized: String(closings.filter((closing) => closing.closedAt !== null).length),
            withDifference: String(closings.filter((closing) => closing.difference && !closing.difference.isZero()).length),
            totalDifference: sum(closings.map((closing) => closing.difference ?? 0)).toFixed(2),
          },
        };
      }

      case 'BUDGETS': {
        const budgets = await this.prisma.budget.findMany({
          where: { entityId: { in: entityIds } },
          include: {
            entity: { select: { name: true } },
            allocations: { include: { category: { select: { name: true } } } },
          },
        });

        const rows: Array<Record<string, string | number | null>> = [];
        for (const budget of budgets) {
          for (const allocation of budget.allocations) {
            const spent = await this.prisma.financialTransaction.aggregate({
              _sum: { amount: true },
              where: {
                entityId: budget.entityId,
                categoryId: allocation.categoryId,
                kind: 'EXPENSE',
                status: 'POSTED',
                businessDate: { gte: budget.startDate },
              },
            });
            const spentAmount = dec(spent._sum.amount ?? 0);
            const limit = dec(allocation.limitAmount);
            const percent = percentOf(spentAmount, limit);
            rows.push({
              entity: budget.entity.name,
              budget: budget.name,
              category: allocation.category?.name ?? '',
              period: budget.period,
              limit: limit.toFixed(2),
              spent: spentAmount.toFixed(2),
              remaining: round2(limit.minus(spentAmount)).toFixed(2),
              percentUsed: percent.toFixed(2),
              health:
                limit.greaterThan(0) && percent.greaterThanOrEqualTo(allocation.alertPct ?? 100)
                  ? 'EXCEDIDO'
                  : limit.greaterThan(0) && percent.greaterThanOrEqualTo(allocation.warnPct ?? 80)
                    ? 'ADVERTENCIA'
                    : 'EN ORDEN',
            });
          }
        }

        return {
          ...base,
          title: 'Presupuestos y consumo real',
          columns: [
            { key: 'entity', header: 'Unidad financiera' },
            { key: 'budget', header: 'Presupuesto' },
            { key: 'category', header: 'Categoría' },
            { key: 'period', header: 'Período' },
            { key: 'limit', header: 'Límite' },
            { key: 'spent', header: 'Gastado' },
            { key: 'remaining', header: 'Disponible' },
            { key: 'percentUsed', header: '% usado' },
            { key: 'health', header: 'Estado' },
          ],
          rows,
          totals: {
            limit: sum(rows.map((row) => dec(row.limit ?? 0))).toFixed(2),
            spent: sum(rows.map((row) => dec(row.spent ?? 0))).toFixed(2),
            exceeded: String(rows.filter((row) => row.health === 'EXCEDIDO').length),
          },
        };
      }

      default:
        throw new ValidationError(`Tipo de informe no soportado: ${type}`);
    }
  }

  /** Exporta un informe a CSV (UTF-8 con BOM para que Excel respete los acentos). */
  async exportCsv(user: AuthenticatedUser, type: ReportType, params: ReportParams) {
    const report = await this.generate(user, type, params);
    const columns: Array<CsvColumn<Record<string, string | number | null>>> = report.columns.map((column) => ({
      header: column.header,
      value: (row) => row[column.key] ?? '',
    }));

    const csv = csvResponse(
      `finanza-${type.toLowerCase()}-${report.period.from}_${report.period.to}.csv`,
      toCsv(report.rows, columns),
    );

    return csv;
  }

  private async incomeExpenseByDay(
    entityIds: string[],
    from: Date,
    to: Date,
  ): Promise<Array<{ date: string; income: string; expense: string; result: string; movements: number }>> {
    const transactions = await this.prisma.financialTransaction.findMany({
      where: { entityId: { in: entityIds }, status: 'POSTED', businessDate: { gte: from, lte: to } },
      select: { businessDate: true, kind: true, amount: true },
    });

    const buckets = new Map<string, { income: ReturnType<typeof dec>; expense: ReturnType<typeof dec>; count: number }>();
    const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1);
    for (let index = 0; index < days; index += 1) {
      buckets.set(businessDateToIso(addBusinessDays(from, index)), { income: dec(0), expense: dec(0), count: 0 });
    }

    // Ingresos y gastos reales por día, desde el libro mayor.
    const ledgerRows = await ledgerResultByDay(this.prisma, { entityIds, from, to });
    for (const [key, row] of ledgerRows.entries()) {
      const bucket = buckets.get(key.split('|')[1]);
      if (bucket) {
        bucket.income = bucket.income.plus(row.income);
        bucket.expense = bucket.expense.plus(row.expense);
      }
    }

    for (const transaction of transactions) {
      const bucket = buckets.get(businessDateToIso(transaction.businessDate));
      if (bucket) {
        bucket.count += 1;
      }
    }

    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, bucket]) => ({
        date,
        income: bucket.income.toFixed(2),
        expense: bucket.expense.toFixed(2),
        result: round2(bucket.income.minus(bucket.expense)).toFixed(2),
        movements: bucket.count,
      }));
  }

  /** Tendencias comparadas de los últimos meses (para el informe mensual). */
  async trends(user: AuthenticatedUser, entityId?: string, months = 6) {
    const entityIds = await this.access.resolveScope(user.userId, entityId);
    const today = businessToday();
    const result: Array<{ month: string; income: string; expense: string; result: string; savingsRate: string }> = [];

    for (let offset = months - 1; offset >= 0; offset -= 1) {
      const start = startOfBusinessMonth(addBusinessMonths(today, -offset));
      const end = addBusinessMonths(start, 1);

      // Desde el libro mayor: el resultado del mes es el de la contabilidad.
      const ledgerRows = await ledgerResultByDay(this.prisma, {
        entityIds,
        from: start,
        to: addBusinessDays(end, -1),
      });
      const income = sum([...ledgerRows.values()].map((row) => row.income));
      const expense = sum([...ledgerRows.values()].map((row) => row.expense));
      result.push({
        month: businessDateToIso(start).slice(0, 7),
        income: income.toFixed(2),
        expense: expense.toFixed(2),
        result: round2(income.minus(expense)).toFixed(2),
        savingsRate: percentOf(income.minus(expense), income).toFixed(2),
      });
    }

    // ¿Los gastos están creciendo peligrosamente? Comparación real mes a mes.
    const growthWarning =
      result.length >= 2
        ? (() => {
            const previous = dec(result[result.length - 2].expense);
            const current = dec(result[result.length - 1].expense);
            if (previous.isZero()) {
              return null;
            }
            const growth = round2(current.minus(previous).dividedBy(previous).times(100));
            return growth.greaterThan(20)
              ? `Los gastos crecieron un ${growth.toFixed(2)}% respecto al mes anterior.`
              : null;
          })()
        : null;

    return { months: result, growthWarning };
  }
}
