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
import type { CreateLegalEntityDto, EntityStructureDto } from './entities.dto.js';
import { validarVinculo } from '../domain/legal-structure.js';

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

  // ==========================================================================
  // PERSONAS JURÍDICAS Y ESTRUCTURA
  // ==========================================================================

  /**
   * Personas jurídicas con las unidades que cuelgan de cada una.
   *
   * Sirve para responder, de un vistazo, la pregunta que hasta ahora no tenía
   * respuesta en FINANZA: ¿qué unidades son la misma sociedad y cuáles no?
   */
  async listLegalEntities(user: AuthenticatedUser) {
    const entityIds = await this.access.listAccessibleEntityIds(user.userId);

    const legalEntities = await this.prisma.legalEntity.findMany({
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      include: {
        entities: {
          where: { id: { in: entityIds } },
          select: {
            id: true,
            code: true,
            name: true,
            type: true,
            isActive: true,
            parentEntityId: true,
            _count: { select: { accounts: true } },
          },
          orderBy: { name: 'asc' },
        },
      },
    });

    // Unidades cuya relación jurídica sigue sin confirmar: el sistema no las
    // trata como de nadie, las deja aparte para que se puedan confirmar.
    const sinConfirmar = await this.prisma.financialEntity.findMany({
      where: { id: { in: entityIds }, legalEntityId: null },
      select: { id: true, code: true, name: true, type: true, isActive: true, parentEntityId: true },
      orderBy: { name: 'asc' },
    });

    return {
      legalEntities: legalEntities.map((legalEntity) => ({
        id: legalEntity.id,
        code: legalEntity.code,
        name: legalEntity.name,
        kind: legalEntity.kind,
        taxId: legalEntity.taxId,
        notes: legalEntity.notes,
        entities: legalEntity.entities,
      })),
      unconfirmed: sinConfirmar,
      /** Explicación para la interfaz: no es un mensaje de error, es un estado. */
      explanation:
        sinConfirmar.length > 0
          ? 'Estas unidades no tienen la relación jurídica confirmada. Mover dinero hacia o desde ellas está bloqueado hasta confirmarla.'
          : 'Todas las unidades tienen su persona jurídica confirmada.',
    };
  }

  async createLegalEntity(user: AuthenticatedUser, dto: CreateLegalEntityDto, meta: RequestMetaInfo) {
    const code = this.slugifyCode(dto.code ?? dto.name);
    if (!code) {
      throw new ValidationError('No se pudo derivar un código válido para la persona jurídica');
    }
    const existing = await this.prisma.legalEntity.findUnique({ where: { code } });
    if (existing) {
      throw new ConflictError(`Ya existe una persona jurídica con el código ${code}`);
    }

    const created = await this.prisma.legalEntity.create({
      data: {
        code,
        name: dto.name.trim(),
        kind: dto.kind ?? 'COMPANY',
        taxId: dto.taxId ?? null,
        notes: dto.notes ?? null,
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'legalEntity.created',
      entityType: 'LegalEntity',
      entityId: created.id,
      after: { code: created.code, name: created.name, kind: created.kind },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return created;
  }

  /**
   * Fija a qué persona jurídica pertenece una unidad y de qué unidad depende.
   *
   * Se valida TODO aquí, en un solo sitio, porque un vínculo mal puesto cambia
   * la contabilidad de las operaciones futuras:
   *
   *  · La persona jurídica tiene que existir.
   *  · No puede haber ciclos (A depende de B que depende de A).
   *  · El padre no puede ser la propia unidad.
   *  · Los vínculos incompatibles se rechazan: finanzas personales dentro de una
   *    sociedad, un negocio colgando de las finanzas personales, o un padre de
   *    otra persona jurídica.
   *  · Los hijos que ya dependen de esta unidad no pueden quedar en otra persona
   *    jurídica distinta de la suya.
   */
  async setStructure(user: AuthenticatedUser, entityId: string, dto: EntityStructureDto, meta: RequestMetaInfo) {
    await this.access.assertCanAdminister(user.userId, entityId);

    const entity = await this.prisma.financialEntity.findUnique({ where: { id: entityId } });
    if (!entity) {
      throw new NotFoundError('Unidad financiera', entityId);
    }

    // `undefined` = no tocar; `null` = quitar la relación. No se confunden.
    const legalEntityId = dto.legalEntityId === undefined ? entity.legalEntityId : dto.legalEntityId;
    const parentEntityId = dto.parentEntityId === undefined ? entity.parentEntityId : dto.parentEntityId;

    const legalEntity = legalEntityId
      ? await this.prisma.legalEntity.findUnique({ where: { id: legalEntityId } })
      : null;
    if (legalEntityId && !legalEntity) {
      throw new NotFoundError('Persona jurídica', legalEntityId);
    }

    let parent: { id: string; name: string; type: string; legalEntityId: string | null; parentEntityId: string | null } | null =
      null;
    if (parentEntityId) {
      if (parentEntityId === entityId) {
        throw new ValidationError('Una unidad no puede depender de sí misma');
      }
      parent = await this.prisma.financialEntity.findUnique({
        where: { id: parentEntityId },
        select: { id: true, name: true, type: true, legalEntityId: true, parentEntityId: true },
      });
      if (!parent) {
        throw new NotFoundError('Unidad de la que depende', parentEntityId);
      }

      // Recorrido hacia arriba: si volvemos a esta unidad, hay un ciclo.
      const vistas = new Set<string>([entityId]);
      let actual: typeof parent | null = parent;
      for (let salto = 0; salto < 50 && actual; salto += 1) {
        if (vistas.has(actual.id)) {
          throw new ValidationError('Ese vínculo crearía un ciclo entre unidades: una unidad acabaría dependiendo de sí misma.');
        }
        vistas.add(actual.id);
        actual = actual.parentEntityId
          ? await this.prisma.financialEntity.findUnique({
              where: { id: actual.parentEntityId },
              select: { id: true, name: true, type: true, legalEntityId: true, parentEntityId: true },
            })
          : null;
      }
    }

    const motivo = validarVinculo({
      entityType: entity.type,
      legalEntityId,
      legalEntityKind: legalEntity?.kind ?? null,
      parentEntityId,
      parentEntityType: parent?.type ?? null,
      parentLegalEntityId: parent?.legalEntityId ?? null,
    });
    if (motivo) {
      throw new ValidationError(motivo);
    }

    // Si se declara de quién depende y esa unidad ya tiene persona jurídica, la
    // unidad la hereda: es la relación que se acaba de declarar, no una suposición.
    let legalEntityFinal = legalEntityId;
    if (!legalEntityFinal && parent?.legalEntityId) {
      legalEntityFinal = parent.legalEntityId;
    }

    if (legalEntityFinal) {
      const hijos = await this.prisma.financialEntity.findMany({
        where: { parentEntityId: entityId },
        select: { id: true, name: true, legalEntityId: true },
      });
      const incompatible = hijos.find((hijo) => hijo.legalEntityId && hijo.legalEntityId !== legalEntityFinal);
      if (incompatible) {
        throw new ValidationError(
          `La unidad «${incompatible.name}» depende de ésta y pertenece a otra persona jurídica. Corrija primero esa relación.`,
        );
      }
    }

    const updated = await this.prisma.financialEntity.update({
      where: { id: entityId },
      data: { legalEntityId: legalEntityFinal, parentEntityId },
      select: { id: true, code: true, name: true, type: true, legalEntityId: true, parentEntityId: true },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'entity.structure.updated',
      entityType: 'FinancialEntity',
      entityId,
      before: { legalEntityId: entity.legalEntityId, parentEntityId: entity.parentEntityId },
      after: { legalEntityId: updated.legalEntityId, parentEntityId: updated.parentEntityId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return updated;
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
