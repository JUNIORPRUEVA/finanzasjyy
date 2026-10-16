import { Injectable } from '@nestjs/common';
import type { BudgetPeriod } from '../generated/prisma/enums.js';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import {
  addBusinessMonths,
  addBusinessDays,
  businessToday,
  toBusinessDate,
} from '../domain/business-date.js';
import { addPeriods } from '../domain/amortization.js';
import { dec, percentOf, round2, validateMoney, type DecimalInput } from '../domain/money.js';
import { CreateBudgetDto, ListBudgetsQuery, UpdateBudgetDto, UpsertAllocationDto } from './budgets.dto.js';

export type BudgetHealth = 'OK' | 'WARNING' | 'EXCEEDED';

/**
 * PRESUPUESTOS
 * ------------
 * Un presupuesto es un límite por categoría y período. FINANZA compara el
 * gasto REAL (movimientos contabilizados) contra el límite y avisa con
 * umbrales configurables (por defecto 80% advertencia, 100% alerta).
 *
 * IMPORTANTE: el presupuesto NO bloquea gastos. Un gasto necesario se registra
 * siempre; lo que hace el sistema es advertir y dejar constancia del exceso.
 * Bloquear un gasto real dejaría la contabilidad mintiendo.
 */
@Injectable()
export class BudgetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /** Rango efectivo del período de un presupuesto. */
  private resolvePeriodRange(budget: {
    period: BudgetPeriod;
    startDate: Date;
    endDate: Date | null;
  }): { from: Date; to: Date } {
    if (budget.endDate) {
      return { from: budget.startDate, to: budget.endDate };
    }

    switch (budget.period) {
      case 'WEEKLY':
        return { from: budget.startDate, to: addBusinessDays(budget.startDate, 6) };
      case 'MONTHLY':
        return { from: budget.startDate, to: new Date(addBusinessMonths(budget.startDate, 1).getTime() - 86_400_000) };
      case 'QUARTERLY':
        return { from: budget.startDate, to: new Date(addBusinessMonths(budget.startDate, 3).getTime() - 86_400_000) };
      case 'ANNUAL':
        return { from: budget.startDate, to: new Date(addBusinessMonths(budget.startDate, 12).getTime() - 86_400_000) };
      case 'CUSTOM':
      default:
        return { from: budget.startDate, to: addBusinessDays(businessToday(), 365) };
    }
  }

  async create(user: AuthenticatedUser, input: CreateBudgetDto, meta: RequestMetaInfo) {
    await this.access.assertCanWrite(user.userId, input.entityId);

    const budgetsServiceEntity = await this.prisma.financialEntity.findUnique({
      where: { id: input.entityId },
      select: { id: true, currency: true },
    });
    if (!budgetsServiceEntity) {
      throw new NotFoundError('Unidad financiera', input.entityId);
    }

    const categoryIds = input.allocations.map((allocation) => allocation.categoryId);
    const categories = await this.prisma.transactionCategory.findMany({
      where: {
        id: { in: categoryIds },
        kind: 'EXPENSE',
        OR: [{ entityId: null }, { entityId: input.entityId }],
      },
      select: { id: true, name: true },
    });

    if (categories.length !== new Set(categoryIds).size) {
      throw new ValidationError(
        'Alguna categoría no existe, no pertenece a esta unidad o no es de gastos. Un presupuesto sólo limita gastos.',
      );
    }

    const duplicate = await this.prisma.budget.findFirst({
      where: { entityId: input.entityId, name: input.name.trim(), status: 'ACTIVE' },
    });
    if (duplicate) {
      throw new ConflictError(`Ya existe un presupuesto activo llamado "${input.name}" en esta unidad`);
    }

    const budget = await this.prisma.budget.create({
      data: {
        entityId: input.entityId,
        name: input.name.trim(),
        period: input.period,
        startDate: toBusinessDate(input.startDate),
        endDate: input.endDate ? toBusinessDate(input.endDate) : null,
        status: 'ACTIVE',
        currency: budgetsServiceEntity.currency,
        notes: input.notes ?? null,
        allocations: {
          create: input.allocations.map((allocation) => ({
            categoryId: allocation.categoryId,
            limitAmount: validateMoney(allocation.limitAmount, {
              field: `límite de ${categories.find((c) => c.id === allocation.categoryId)?.name ?? 'la categoría'}`,
              allowZero: true,
            }),
            warnPct: allocation.warnPct ?? 80,
            alertPct: allocation.alertPct ?? 100,
          })),
        },
      },
      include: { allocations: { include: { category: { select: { id: true, name: true } } } } },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'budget.created',
      entityType: 'Budget',
      entityId: budget.id,
      after: {
        name: budget.name,
        period: budget.period,
        allocations: input.allocations.map((allocation) => ({
          categoryId: allocation.categoryId,
          limitAmount: allocation.limitAmount,
        })),
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.withUsage(budget);
  }

  async list(user: AuthenticatedUser, query: ListBudgetsQuery) {
    const entityIds = await this.access.resolveScope(user.userId, query.entityId);

    const budgets = await this.prisma.budget.findMany({
      where: { entityId: { in: entityIds }, status: query.status },
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
      take: Math.min(200, query.limit ?? 50),
      include: {
        entity: { select: { id: true, code: true, name: true, currency: true } },
        allocations: { include: { category: { select: { id: true, name: true, kind: true } } } },
      },
    });

    return Promise.all(budgets.map((budget) => this.withUsage(budget)));
  }

  async get(user: AuthenticatedUser, budgetId: string) {
    const budget = await this.prisma.budget.findUnique({
      where: { id: budgetId },
      include: {
        entity: { select: { id: true, code: true, name: true, currency: true } },
        allocations: { include: { category: { select: { id: true, name: true, kind: true } } } },
      },
    });
    if (!budget) {
      throw new NotFoundError('Presupuesto', budgetId);
    }
    await this.access.assertCanRead(user.userId, budget.entityId);
    return this.withUsage(budget);
  }

  async update(user: AuthenticatedUser, budgetId: string, dto: UpdateBudgetDto, meta: RequestMetaInfo) {
    const existing = await this.prisma.budget.findUnique({ where: { id: budgetId } });
    if (!existing) {
      throw new NotFoundError('Presupuesto', budgetId);
    }
    await this.access.assertCanWrite(user.userId, existing.entityId);

    const updated = await this.prisma.budget.update({
      where: { id: budgetId },
      data: {
        name: dto.name?.trim(),
        endDate: dto.endDate ? toBusinessDate(dto.endDate) : undefined,
        status: dto.status,
        notes: dto.notes,
      },
      include: { allocations: { include: { category: { select: { id: true, name: true, kind: true } } } } },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'budget.updated',
      entityType: 'Budget',
      entityId: budgetId,
      before: { name: existing.name, status: existing.status, endDate: existing.endDate },
      after: { name: updated.name, status: updated.status, endDate: updated.endDate },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.withUsage(updated);
  }

  async upsertAllocation(
    user: AuthenticatedUser,
    budgetId: string,
    dto: UpsertAllocationDto,
    meta: RequestMetaInfo,
  ) {
    const budget = await this.prisma.budget.findUnique({ where: { id: budgetId } });
    if (!budget) {
      throw new NotFoundError('Presupuesto', budgetId);
    }
    await this.access.assertCanWrite(user.userId, budget.entityId);

    const category = await this.prisma.transactionCategory.findUnique({ where: { id: dto.categoryId } });
    if (!category || category.kind !== 'EXPENSE') {
      throw new ValidationError('Sólo se pueden presupuestar categorías de gastos');
    }

    const limitAmount = validateMoney(dto.limitAmount, { field: 'límite', allowZero: true });

    const allocation = await this.prisma.budgetAllocation.upsert({
      where: { budgetId_categoryId: { budgetId, categoryId: dto.categoryId } },
      create: {
        budgetId,
        categoryId: dto.categoryId,
        limitAmount,
        warnPct: dto.warnPct ?? 80,
        alertPct: dto.alertPct ?? 100,
      },
      update: {
        limitAmount,
        warnPct: dto.warnPct ?? undefined,
        alertPct: dto.alertPct ?? undefined,
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'budget.allocation.upserted',
      entityType: 'BudgetAllocation',
      entityId: allocation.id,
      after: { budgetId, categoryId: dto.categoryId, limitAmount: limitAmount.toFixed(2) },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return allocation;
  }

  /**
   * Alertas de presupuesto para el panel de disciplina financiera.
   * Se calculan sobre el gasto REAL del período, no sobre estimaciones.
   */
  async alerts(user: AuthenticatedUser, entityId?: string) {
    const budgets = await this.list(user, { entityId, status: 'ACTIVE' } as ListBudgetsQuery);
    const alerts: Array<{
      budgetId: string;
      budgetName: string;
      entityId: string;
      categoryId: string;
      categoryName: string;
      limit: string;
      spent: string;
      remaining: string;
      percentUsed: string;
      health: BudgetHealth;
      message: string;
    }> = [];

    for (const budget of budgets) {
      for (const allocation of budget.allocations ?? []) {
        if (allocation.health === 'OK') {
          continue;
        }
        alerts.push({
          budgetId: budget.id,
          budgetName: budget.name,
          entityId: budget.entityId,
          categoryId: allocation.categoryId,
          categoryName: allocation.categoryName,
          limit: allocation.limitAmount,
          spent: allocation.spentAmount,
          remaining: allocation.remainingAmount,
          percentUsed: allocation.percentUsed,
          health: allocation.health,
          message:
            allocation.health === 'EXCEEDED'
              ? `Presupuesto excedido en ${allocation.categoryName}: ${allocation.spentAmount} de ${allocation.limitAmount}`
              : `Presupuesto al ${allocation.percentUsed}% en ${allocation.categoryName}`,
        });
      }
    }

    return {
      count: alerts.length,
      exceeded: alerts.filter((alert) => alert.health === 'EXCEEDED').length,
      warning: alerts.filter((alert) => alert.health === 'WARNING').length,
      alerts,
    };
  }

  /** Calcula el consumo real de cada categoría del presupuesto. */
  private async withUsage<
    T extends {
      id: string;
      entityId: string;
      name: string;
      period: BudgetPeriod;
      startDate: Date;
      endDate: Date | null;
      status: string;
      currency: string;
      notes: string | null;
      entity?: unknown;
      allocations: Array<{
        id: string;
        categoryId: string;
        limitAmount: DecimalInput;
        warnPct: number | null;
        alertPct: number | null;
        category?: { id: string; name: string; kind?: string };
      }>;
    },
  >(budget: T) {
    const range = this.resolvePeriodRange(budget);
    const categoryIds = budget.allocations.map((allocation) => allocation.categoryId);

    // Gasto real por categoría en el período: sólo movimientos POSTED de tipo
    // EXPENSE. Una transferencia o un pago de préstamo NO consume presupuesto.
    const grouped = categoryIds.length
      ? await this.prisma.financialTransaction.groupBy({
          by: ['categoryId'],
          where: {
            entityId: budget.entityId,
            categoryId: { in: categoryIds },
            kind: 'EXPENSE',
            status: 'POSTED',
            businessDate: { gte: range.from, lte: range.to },
          },
          _sum: { amount: true },
        })
      : [];

    const spentByCategory = new Map(
      grouped.map((row) => [row.categoryId as string, dec(row._sum.amount ?? 0)]),
    );

    const allocations = budget.allocations.map((allocation) => {
      const limit = dec(allocation.limitAmount);
      const spent = spentByCategory.get(allocation.categoryId) ?? dec(0);
      const remaining = round2(limit.minus(spent));
      const percent = percentOf(spent, limit);
      const warnPct = allocation.warnPct ?? 80;
      const alertPct = allocation.alertPct ?? 100;

      let health: BudgetHealth = 'OK';
      if (limit.greaterThan(0)) {
        if (percent.greaterThanOrEqualTo(alertPct) || spent.greaterThan(limit)) {
          health = 'EXCEEDED';
        } else if (percent.greaterThanOrEqualTo(warnPct)) {
          health = 'WARNING';
        }
      }

      return {
        id: allocation.id,
        categoryId: allocation.categoryId,
        categoryName: allocation.category?.name ?? '',
        categoryKind: allocation.category?.kind ?? 'EXPENSE',
        limitAmount: limit.toFixed(2),
        spentAmount: spent.toFixed(2),
        remainingAmount: remaining.toFixed(2),
        percentUsed: percent.toFixed(2),
        warnPct,
        alertPct,
        health,
        /** El exceso se señala, no se bloquea: el gasto real ya ocurrió. */
        overLimit: spent.greaterThan(limit),
      };
    });

    const totalLimit = allocations.reduce((acc, allocation) => acc.plus(dec(allocation.limitAmount)), dec(0));
    const totalSpent = allocations.reduce((acc, allocation) => acc.plus(dec(allocation.spentAmount)), dec(0));

    return {
      id: budget.id,
      entityId: budget.entityId,
      entity: budget.entity,
      name: budget.name,
      period: budget.period,
      status: budget.status,
      currency: budget.currency,
      notes: budget.notes,
      range: { from: range.from, to: range.to },
      allocations,
      totals: {
        limit: totalLimit.toFixed(2),
        spent: totalSpent.toFixed(2),
        remaining: round2(totalLimit.minus(totalSpent)).toFixed(2),
        percentUsed: percentOf(totalSpent, totalLimit).toFixed(2),
      },
      health: allocations.some((allocation) => allocation.health === 'EXCEEDED')
        ? ('EXCEEDED' as BudgetHealth)
        : allocations.some((allocation) => allocation.health === 'WARNING')
          ? ('WARNING' as BudgetHealth)
          : ('OK' as BudgetHealth),
    };
  }
}
