import { Injectable } from '@nestjs/common';
import type { CategoryKind } from '../generated/prisma/enums.js';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import { CHART_OF_ACCOUNTS, LEDGER } from '../domain/chart-of-accounts.js';
import { isExpenseAccount, isIncomeAccount } from '../ledger/posting-rules.js';

/**
 * CATEGORÍAS
 * ----------
 * Clasifican ingresos y gastos y determinan LA CUENTA CONTABLE que se usa al
 * registrar. Una categoría no puede apuntar a una cuenta del signo contrario:
 * así es imposible que un gasto acabe inflando los ingresos.
 *
 * El usuario puede crear sus propias categorías sin tocar código.
 */
@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  private assertLedgerCodeMatchesKind(kind: CategoryKind, code: string): void {
    const account = CHART_OF_ACCOUNTS.find((item) => item.code === code);
    if (!account) {
      throw new ValidationError(`La cuenta contable ${code} no existe en el catálogo`);
    }
    const valid = kind === 'INCOME' ? isIncomeAccount(code) : isExpenseAccount(code);
    if (!valid) {
      throw new ValidationError(
        kind === 'INCOME'
          ? `La cuenta ${code} (${account.name}) no es una cuenta de ingresos`
          : `La cuenta ${code} (${account.name}) no es una cuenta de gastos`,
      );
    }
  }

  /** Categorías aplicables: las globales más las propias de la unidad. */
  async list(user: AuthenticatedUser, params: { entityId?: string; kind?: CategoryKind; includeInactive?: boolean }) {
    let entityIds: string[] = [];
    if (params.entityId) {
      await this.access.assertCanRead(user.userId, params.entityId);
      entityIds = [params.entityId];
    } else {
      entityIds = await this.access.listAccessibleEntityIds(user.userId);
    }

    return this.prisma.transactionCategory.findMany({
      where: {
        kind: params.kind,
        isActive: params.includeInactive ? undefined : true,
        OR: [{ entityId: null }, { entityId: { in: entityIds } }],
      },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      include: {
        entity: { select: { id: true, code: true, name: true } },
        _count: { select: { transactions: true, allocations: true } },
      },
    });
  }

  async create(
    user: AuthenticatedUser,
    input: {
      entityId?: string | null;
      name: string;
      kind: CategoryKind;
      defaultLedgerCode?: string;
      color?: string;
      parentId?: string;
    },
    meta: RequestMetaInfo,
  ) {
    if (input.entityId) {
      await this.access.assertCanWrite(user.userId, input.entityId);
    }

    const defaultLedgerCode =
      input.defaultLedgerCode ?? (input.kind === 'INCOME' ? LEDGER.OTHER_INCOME : LEDGER.OTHER_OPERATING_EXPENSE);

    this.assertLedgerCodeMatchesKind(input.kind, defaultLedgerCode);

    const duplicate = await this.prisma.transactionCategory.findFirst({
      where: { entityId: input.entityId ?? null, name: input.name.trim(), kind: input.kind },
    });
    if (duplicate) {
      throw new ConflictError(`Ya existe una categoría "${input.name}" de ese tipo`);
    }

    if (input.parentId) {
      const parent = await this.prisma.transactionCategory.findUnique({ where: { id: input.parentId } });
      if (!parent) {
        throw new NotFoundError('Categoría padre', input.parentId);
      }
      if (parent.kind !== input.kind) {
        throw new ValidationError('La categoría padre debe ser del mismo tipo (ingreso o gasto)');
      }
    }

    const category = await this.prisma.transactionCategory.create({
      data: {
        entityId: input.entityId ?? null,
        name: input.name.trim(),
        kind: input.kind,
        defaultLedgerCode,
        color: input.color ?? null,
        parentId: input.parentId ?? null,
        isSystem: false,
        isActive: true,
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'category.created',
      entityType: 'TransactionCategory',
      entityId: category.id,
      after: { name: category.name, kind: category.kind, defaultLedgerCode },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return category;
  }

  async update(
    user: AuthenticatedUser,
    categoryId: string,
    input: { name?: string; defaultLedgerCode?: string; color?: string; isActive?: boolean },
    meta: RequestMetaInfo,
  ) {
    const existing = await this.prisma.transactionCategory.findUnique({ where: { id: categoryId } });
    if (!existing) {
      throw new NotFoundError('Categoría', categoryId);
    }
    if (existing.entityId) {
      await this.access.assertCanWrite(user.userId, existing.entityId);
    }

    if (input.defaultLedgerCode) {
      this.assertLedgerCodeMatchesKind(existing.kind, input.defaultLedgerCode);
    }

    const updated = await this.prisma.transactionCategory.update({
      where: { id: categoryId },
      data: {
        name: input.name?.trim(),
        defaultLedgerCode: input.defaultLedgerCode,
        color: input.color,
        isActive: input.isActive,
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'category.updated',
      entityType: 'TransactionCategory',
      entityId: categoryId,
      before: { name: existing.name, defaultLedgerCode: existing.defaultLedgerCode, isActive: existing.isActive },
      after: { name: updated.name, defaultLedgerCode: updated.defaultLedgerCode, isActive: updated.isActive },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return updated;
  }

  /**
   * "Elimina" una categoría desactivándola. Si tiene movimientos, borrarla
   * dejaría movimientos huérfanos; si no los tiene, se puede desactivar igual.
   */
  async deactivate(user: AuthenticatedUser, categoryId: string, meta: RequestMetaInfo) {
    const category = await this.prisma.transactionCategory.findUnique({
      where: { id: categoryId },
      include: { _count: { select: { transactions: true } } },
    });
    if (!category) {
      throw new NotFoundError('Categoría', categoryId);
    }
    if (category.entityId) {
      await this.access.assertCanWrite(user.userId, category.entityId);
    }
    if (category.isSystem) {
      throw new ValidationError('Las categorías del sistema no se pueden desactivar');
    }

    const updated = await this.prisma.transactionCategory.update({
      where: { id: categoryId },
      data: { isActive: false },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'category.deactivated',
      entityType: 'TransactionCategory',
      entityId: categoryId,
      after: { isActive: false, transactionCount: category._count.transactions },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      ...updated,
      note:
        category._count.transactions > 0
          ? `La categoría conserva ${category._count.transactions} movimientos históricos.`
          : 'Categoría desactivada.',
    };
  }
}
