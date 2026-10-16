import { Injectable } from '@nestjs/common';
import type { CounterpartyType } from '../generated/prisma/enums.js';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { ConflictError, NotFoundError } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';

export interface CounterpartyInput {
  entityId?: string | null;
  type: CounterpartyType;
  name: string;
  taxId?: string;
  phone?: string;
  email?: string;
  notes?: string;
}

/**
 * CONTRAPARTES
 * ------------
 * Clientes, proveedores, prestamistas y prestatarios. Son opcionales: el
 * objetivo es poder registrar un gasto en dos segundos, no obligar a crear
 * fichas. Pero cuando existen, permiten responder "¿cuánto le debo a X?".
 */
@Injectable()
export class CounterpartiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthenticatedUser,
    params: { entityId?: string; type?: CounterpartyType; search?: string; includeInactive?: boolean },
  ) {
    const entityIds = await this.access.resolveScope(user.userId, params.entityId);

    return this.prisma.counterparty.findMany({
      where: {
        OR: [{ entityId: null }, { entityId: { in: entityIds } }],
        type: params.type,
        isActive: params.includeInactive ? undefined : true,
        name: params.search ? { contains: params.search, mode: 'insensitive' } : undefined,
      },
      orderBy: { name: 'asc' },
      take: 300,
      include: { _count: { select: { transactions: true, loans: true, receivables: true, payables: true } } },
    });
  }

  async create(user: AuthenticatedUser, input: CounterpartyInput, meta: RequestMetaInfo) {
    if (input.entityId) {
      await this.access.assertCanWrite(user.userId, input.entityId);
    }

    const duplicate = await this.prisma.counterparty.findFirst({
      where: { entityId: input.entityId ?? null, name: input.name.trim() },
    });
    if (duplicate) {
      throw new ConflictError(`Ya existe una contraparte llamada "${input.name}"`);
    }

    const counterparty = await this.prisma.counterparty.create({
      data: {
        entityId: input.entityId ?? null,
        type: input.type,
        name: input.name.trim(),
        taxId: input.taxId ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        notes: input.notes ?? null,
        isActive: true,
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'counterparty.created',
      entityType: 'Counterparty',
      entityId: counterparty.id,
      after: { name: counterparty.name, type: counterparty.type },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return counterparty;
  }

  async update(
    user: AuthenticatedUser,
    counterpartyId: string,
    input: Partial<CounterpartyInput> & { isActive?: boolean },
    meta: RequestMetaInfo,
  ) {
    const existing = await this.prisma.counterparty.findUnique({ where: { id: counterpartyId } });
    if (!existing) {
      throw new NotFoundError('Contraparte', counterpartyId);
    }
    if (existing.entityId) {
      await this.access.assertCanWrite(user.userId, existing.entityId);
    }

    const updated = await this.prisma.counterparty.update({
      where: { id: counterpartyId },
      data: {
        name: input.name?.trim(),
        type: input.type,
        taxId: input.taxId,
        phone: input.phone,
        email: input.email,
        notes: input.notes,
        isActive: input.isActive,
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'counterparty.updated',
      entityType: 'Counterparty',
      entityId: counterpartyId,
      before: { name: existing.name, type: existing.type, isActive: existing.isActive },
      after: { name: updated.name, type: updated.type, isActive: updated.isActive },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return updated;
  }

  /** Desactiva (no borra): conserva el histórico de deudas y movimientos. */
  async deactivate(user: AuthenticatedUser, counterpartyId: string, meta: RequestMetaInfo) {
    const counterparty = await this.prisma.counterparty.findUnique({
      where: { id: counterpartyId },
      include: { _count: { select: { transactions: true, loans: true } } },
    });
    if (!counterparty) {
      throw new NotFoundError('Contraparte', counterpartyId);
    }
    if (counterparty.entityId) {
      await this.access.assertCanWrite(user.userId, counterparty.entityId);
    }

    const updated = await this.prisma.counterparty.update({
      where: { id: counterpartyId },
      data: { isActive: false },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'counterparty.deactivated',
      entityType: 'Counterparty',
      entityId: counterpartyId,
      after: { isActive: false },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { ...updated, retainedRecords: counterparty._count };
  }
}
