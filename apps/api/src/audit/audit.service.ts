import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface AuditRecordInput {
  userId?: string | null;
  actorType?: 'USER' | 'SYSTEM' | 'SCHEDULER' | 'SYNC';
  action: string;
  entityType: string;
  entityId?: string | null;
  businessId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
}

/**
 * AUDITORÍA
 * ---------
 * Toda operación que cambia dinero deja rastro: quién, qué, antes y después.
 * Los asientos contables son inmutables por trigger; la auditoría es el
 * complemento que explica POR QUÉ cambió cada cosa.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditRecordInput, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        userId: input.userId ?? null,
        actorType: input.actorType ?? (input.userId ? 'USER' : 'SYSTEM'),
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        businessId: input.businessId ?? null,
        beforeJson: this.toJson(input.before),
        afterJson: this.toJson(input.after),
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  async list(params: {
    entityType?: string;
    entityId?: string;
    action?: string;
    userId?: string;
    from?: Date;
    to?: Date;
    skip: number;
    take: number;
  }): Promise<{ data: unknown[]; total: number }> {
    const where: Prisma.AuditLogWhereInput = {
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      userId: params.userId,
      createdAt:
        params.from || params.to
          ? {
              gte: params.from,
              lte: params.to,
            }
          : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data, total };
  }

  private toJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    // Se redondea a JSON puro para que Prisma lo acepte sin sorpresas.
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
