import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import { balancesForAccounts } from '../ledger/ledger-core.js';
import { dec } from '../domain/money.js';
import { CreateEntityDto, EntityMemberDto, UpdateEntityDto } from './entities.dto.js';

/**
 * UNIDADES FINANCIERAS
 * --------------------
 * Cada negocio, alquiler, servicio o las finanzas personales son una unidad
 * independiente con sus cuentas, movimientos, presupuestos y cierres.
 *
 * Crear una fuente de ingresos nueva NO requiere tocar código: es un registro
 * más en esta tabla.
 *
 * Las unidades NO se borran nunca: se desactivan (isActive = false), porque
 * borrarlas arrastraría su historia financiera.
 */
@Injectable()
export class EntitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  private slugifyCode(name: string): string {
    return name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
  }

  async create(user: AuthenticatedUser, dto: CreateEntityDto, meta: RequestMetaInfo) {
    const code = dto.code ? this.slugifyCode(dto.code) : this.slugifyCode(dto.name);

    if (!code) {
      throw new ValidationError('No se pudo derivar un código válido para la unidad financiera');
    }

    const existing = await this.prisma.financialEntity.findUnique({ where: { code } });
    if (existing) {
      throw new ConflictError(`Ya existe una unidad financiera con el código ${code}`);
    }

    const entity = await this.prisma.financialEntity.create({
      data: {
        code,
        name: dto.name.trim(),
        type: dto.type ?? 'BUSINESS',
        description: dto.description ?? null,
        currency: (dto.currency ?? 'DOP').toUpperCase(),
        timezone: dto.timezone ?? process.env.BUSINESS_TIMEZONE ?? 'America/Santo_Domingo',
        color: dto.color ?? null,
        ownerUserId: user.userId,
        members: {
          create: { userId: user.userId, role: 'OWNER' },
        },
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'entity.created',
      entityType: 'FinancialEntity',
      entityId: entity.id,
      after: { code: entity.code, name: entity.name, type: entity.type },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return entity;
  }

  async list(user: AuthenticatedUser, includeInactive = false) {
    const entityIds = await this.access.listAccessibleEntityIds(user.userId);

    const entities = await this.prisma.financialEntity.findMany({
      where: {
        id: { in: entityIds },
        isActive: includeInactive ? undefined : true,
      },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
      include: {
        _count: { select: { accounts: true, transactions: true, closings: true } },
      },
    });

    // Saldo consolidado por unidad: ayuda a ver de un vistazo dónde está el dinero.
    const accounts = await this.prisma.financialAccount.findMany({
      where: { entityId: { in: entities.map((entity) => entity.id) }, status: { not: 'CLOSED' } },
      select: { id: true, entityId: true, isCreditCard: true, ledgerAccount: { select: { normalBalance: true } } },
    });

    const balances = await balancesForAccounts(this.prisma, {
      financialAccountIds: accounts.map((account) => account.id),
    });

    const totalsByEntity = new Map<string, { cash: ReturnType<typeof dec>; liabilities: ReturnType<typeof dec> }>();
    for (const account of accounts) {
      const balance = dec(balances.get(account.id)?.balance ?? 0);
      const current = totalsByEntity.get(account.entityId) ?? { cash: dec(0), liabilities: dec(0) };
      if (account.isCreditCard || account.ledgerAccount.normalBalance === 'CREDIT') {
        current.liabilities = current.liabilities.plus(balance);
      } else {
        current.cash = current.cash.plus(balance);
      }
      totalsByEntity.set(account.entityId, current);
    }

    return entities.map((entity) => {
      const totals = totalsByEntity.get(entity.id) ?? { cash: dec(0), liabilities: dec(0) };
      return {
        ...entity,
        totals: {
          availableCash: totals.cash.toFixed(2),
          liabilities: totals.liabilities.toFixed(2),
        },
      };
    });
  }

  async get(user: AuthenticatedUser, entityId: string) {
    await this.access.assertCanRead(user.userId, entityId);
    const entity = await this.prisma.financialEntity.findUnique({
      where: { id: entityId },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, email: true, role: true } } },
        },
        _count: { select: { accounts: true, transactions: true, closings: true, budgets: true } },
      },
    });
    if (!entity) {
      throw new NotFoundError('Unidad financiera', entityId);
    }
    return entity;
  }

  async update(user: AuthenticatedUser, entityId: string, dto: UpdateEntityDto, meta: RequestMetaInfo) {
    await this.access.assertCanAdminister(user.userId, entityId);

    const before = await this.prisma.financialEntity.findUniqueOrThrow({ where: { id: entityId } });

    const updated = await this.prisma.financialEntity.update({
      where: { id: entityId },
      data: {
        name: dto.name?.trim(),
        description: dto.description,
        type: dto.type,
        color: dto.color,
        isActive: dto.isActive,
        timezone: dto.timezone,
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'entity.updated',
      entityType: 'FinancialEntity',
      entityId,
      before: { name: before.name, type: before.type, isActive: before.isActive },
      after: { name: updated.name, type: updated.type, isActive: updated.isActive },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return updated;
  }

  /**
   * "Eliminar" una unidad financiera = desactivarla. Si tuviera movimientos,
   * borrarla destruiría la historia (y la base de datos lo impediría).
   */
  async deactivate(user: AuthenticatedUser, entityId: string, meta: RequestMetaInfo) {
    await this.access.assertCanAdminister(user.userId, entityId);

    const transactionCount = await this.prisma.financialTransaction.count({ where: { entityId } });
    const updated = await this.prisma.financialEntity.update({
      where: { id: entityId },
      data: { isActive: false },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'entity.deactivated',
      entityType: 'FinancialEntity',
      entityId,
      after: { isActive: false, transactionCount },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      ...updated,
      note:
        transactionCount > 0
          ? `La unidad conserva ${transactionCount} movimientos históricos: se desactiva, no se borra.`
          : 'Unidad desactivada.',
    };
  }

  async addMember(user: AuthenticatedUser, entityId: string, dto: EntityMemberDto, meta: RequestMetaInfo) {
    await this.access.assertCanAdminister(user.userId, entityId);

    const target = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!target) {
      throw new NotFoundError('Usuario', dto.userId);
    }

    const member = await this.prisma.entityMember.upsert({
      where: { entityId_userId: { entityId, userId: dto.userId } },
      create: { entityId, userId: dto.userId, role: dto.role ?? 'OPERATOR' },
      update: { role: dto.role ?? 'OPERATOR' },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'entity.member.added',
      entityType: 'EntityMember',
      entityId: member.id,
      after: { entityId, userId: dto.userId, role: member.role },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return member;
  }

  async removeMember(user: AuthenticatedUser, entityId: string, memberUserId: string, meta: RequestMetaInfo) {
    await this.access.assertCanAdminister(user.userId, entityId);

    const entity = await this.prisma.financialEntity.findUniqueOrThrow({
      where: { id: entityId },
      select: { ownerUserId: true },
    });
    if (entity.ownerUserId === memberUserId) {
      throw new ValidationError('No se puede quitar al propietario de la unidad financiera');
    }

    await this.prisma.entityMember.deleteMany({ where: { entityId, userId: memberUserId } });

    await this.audit.record({
      userId: user.userId,
      action: 'entity.member.removed',
      entityType: 'EntityMember',
      entityId: `${entityId}:${memberUserId}`,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { removed: true };
  }
}
