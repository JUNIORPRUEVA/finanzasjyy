import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { PaymentFrequency } from '../generated/prisma/enums.js';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import { addBusinessDays, businessToday, toBusinessDate } from '../domain/business-date.js';
import { addPeriods } from '../domain/amortization.js';
import { dec, gt, gte, min, round2, validateMoney, type DecimalInput } from '../domain/money.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import {
  CreatePayableDto,
  CreateReceivableDto,
  CreateRecurringDto,
  ListObligationsQuery,
  UpdateObligationDto,
} from './obligations.dto.js';
import { PayRecurringDto, SettleObligationDto } from './obligations.payments.dto.js';

/**
 * OBLIGACIONES
 * ------------
 * Tres cosas distintas que el usuario necesita ver juntas:
 *  · CUENTAS POR COBRAR (Receivable): a FINANZA le deben dinero.
 *  · CUENTAS POR PAGAR (Payable):    FINANZA debe dinero.
 *  · OBLIGACIONES RECURRENTES:       alquiler, internet, nómina... con aviso
 *                                    antes del vencimiento.
 *
 * El saldo pendiente NO se escribe a mano: se recalcula desde los cobros/pagos
 * registrados como movimientos (así no puede desincronizarse de la caja).
 *
 * Los vencimientos vencidos se marcan OVERDUE sin que nadie tenga que abrir la app.
 */
@Injectable()
export class ObligationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly transactions: TransactionsService,
  ) {}

  // -------------------------------------------------------------------------
  // Cuentas por cobrar
  // -------------------------------------------------------------------------

  async createReceivable(user: AuthenticatedUser, input: CreateReceivableDto, meta: RequestMetaInfo) {
    await this.access.assertCanWrite(user.userId, input.entityId);

    const originalAmount = validateMoney(input.originalAmount, { field: 'importe por cobrar' });

    const receivable = await this.prisma.receivable.create({
      data: {
        entityId: input.entityId,
        counterpartyId: input.counterpartyId ?? null,
        description: input.description.trim(),
        documentRef: input.documentRef ?? null,
        originalAmount,
        settledAmount: dec(0),
        issueDate: toBusinessDate(input.issueDate),
        dueDate: input.dueDate ? toBusinessDate(input.dueDate) : null,
        status: 'PENDING',
        notes: input.notes ?? null,
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'receivable.created',
      entityType: 'Receivable',
      entityId: receivable.id,
      after: { description: receivable.description, originalAmount: originalAmount.toFixed(2) },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.presentReceivable(receivable);
  }

  async listReceivables(user: AuthenticatedUser, query: ListObligationsQuery) {
    const entityIds = await this.access.resolveScope(user.userId, query.entityId);
    const limit = Math.min(200, query.limit ?? 50);
    const page = query.page ?? 1;

    const where: Prisma.ReceivableWhereInput = {
      entityId: { in: entityIds },
      status: query.status ? (query.status as 'PENDING') : { not: 'CANCELLED' },
      counterpartyId: query.counterpartyId,
      dueDate:
        query.dueFrom || query.dueTo
          ? { gte: query.dueFrom ? toBusinessDate(query.dueFrom) : undefined, lte: query.dueTo ? toBusinessDate(query.dueTo) : undefined }
          : undefined,
      description: query.search ? { contains: query.search, mode: 'insensitive' } : undefined,
    };

    const [rows, total] = await Promise.all([
      this.prisma.receivable.findMany({
        where,
        orderBy: [{ dueDate: 'asc' }, { issueDate: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          counterparty: { select: { id: true, name: true, type: true } },
          entity: { select: { id: true, code: true, name: true } },
        },
      }),
      this.prisma.receivable.count({ where }),
    ]);

    const today = businessToday();
    return {
      data: rows.map((row) => ({
        ...this.presentReceivable(row),
        counterparty: row.counterparty,
        entity: row.entity,
        isOverdue:
          row.dueDate !== null && row.dueDate.getTime() < today.getTime() && row.status !== 'SETTLED',
        daysToDue: row.dueDate ? Math.round((row.dueDate.getTime() - today.getTime()) / 86_400_000) : null,
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit), hasNext: page * limit < total },
    };
  }

  async updateReceivable(user: AuthenticatedUser, id: string, dto: UpdateObligationDto, meta: RequestMetaInfo) {
    const existing = await this.prisma.receivable.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError('Cuenta por cobrar', id);
    }
    await this.access.assertCanWrite(user.userId, existing.entityId);

    const updated = await this.prisma.receivable.update({
      where: { id },
      data: {
        description: dto.description?.trim(),
        dueDate: dto.dueDate ? toBusinessDate(dto.dueDate) : undefined,
        notes: dto.notes,
        status: dto.status,
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'receivable.updated',
      entityType: 'Receivable',
      entityId: id,
      before: { description: existing.description, status: existing.status, dueDate: existing.dueDate },
      after: { description: updated.description, status: updated.status, dueDate: updated.dueDate },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.presentReceivable(updated);
  }

  // -------------------------------------------------------------------------
  // Cuentas por pagar
  // -------------------------------------------------------------------------

  async createPayable(user: AuthenticatedUser, input: CreatePayableDto, meta: RequestMetaInfo) {
    await this.access.assertCanWrite(user.userId, input.entityId);

    const originalAmount = validateMoney(input.originalAmount, { field: 'importe por pagar' });

    const payable = await this.prisma.payable.create({
      data: {
        entityId: input.entityId,
        counterpartyId: input.counterpartyId ?? null,
        description: input.description.trim(),
        documentRef: input.documentRef ?? null,
        originalAmount,
        settledAmount: dec(0),
        issueDate: toBusinessDate(input.issueDate),
        dueDate: input.dueDate ? toBusinessDate(input.dueDate) : null,
        status: 'PENDING',
        notes: input.notes ?? null,
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'payable.created',
      entityType: 'Payable',
      entityId: payable.id,
      after: { description: payable.description, originalAmount: originalAmount.toFixed(2) },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.presentPayable(payable);
  }

  async listPayables(user: AuthenticatedUser, query: ListObligationsQuery) {
    const entityIds = await this.access.resolveScope(user.userId, query.entityId);
    const limit = Math.min(200, query.limit ?? 50);
    const page = query.page ?? 1;

    const where: Prisma.PayableWhereInput = {
      entityId: { in: entityIds },
      status: query.status ? (query.status as 'PENDING') : { not: 'CANCELLED' },
      counterpartyId: query.counterpartyId,
      dueDate:
        query.dueFrom || query.dueTo
          ? { gte: query.dueFrom ? toBusinessDate(query.dueFrom) : undefined, lte: query.dueTo ? toBusinessDate(query.dueTo) : undefined }
          : undefined,
      description: query.search ? { contains: query.search, mode: 'insensitive' } : undefined,
    };

    const [rows, total] = await Promise.all([
      this.prisma.payable.findMany({
        where,
        orderBy: [{ dueDate: 'asc' }, { issueDate: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          counterparty: { select: { id: true, name: true, type: true } },
          entity: { select: { id: true, code: true, name: true } },
        },
      }),
      this.prisma.payable.count({ where }),
    ]);

    const today = businessToday();
    return {
      data: rows.map((row) => ({
        ...this.presentPayable(row),
        counterparty: row.counterparty,
        entity: row.entity,
        isOverdue: row.dueDate !== null && row.dueDate.getTime() < today.getTime() && row.status !== 'SETTLED',
        daysToDue: row.dueDate ? Math.round((row.dueDate.getTime() - today.getTime()) / 86_400_000) : null,
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit), hasNext: page * limit < total },
    };
  }

  async updatePayable(user: AuthenticatedUser, id: string, dto: UpdateObligationDto, meta: RequestMetaInfo) {
    const existing = await this.prisma.payable.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError('Cuenta por pagar', id);
    }
    await this.access.assertCanWrite(user.userId, existing.entityId);

    const updated = await this.prisma.payable.update({
      where: { id },
      data: {
        description: dto.description?.trim(),
        dueDate: dto.dueDate ? toBusinessDate(dto.dueDate) : undefined,
        notes: dto.notes,
        status: dto.status,
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'payable.updated',
      entityType: 'Payable',
      entityId: id,
      before: { description: existing.description, status: existing.status },
      after: { description: updated.description, status: updated.status },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.presentPayable(updated);
  }

  // -------------------------------------------------------------------------
  // Obligaciones recurrentes
  // -------------------------------------------------------------------------

  async createRecurring(user: AuthenticatedUser, input: CreateRecurringDto, meta: RequestMetaInfo) {
    await this.access.assertCanWrite(user.userId, input.entityId);
    const amount = validateMoney(input.amount, { field: 'importe de la obligación' });

    const recurring = await this.prisma.recurringObligation.create({
      data: {
        entityId: input.entityId,
        name: input.name.trim(),
        direction: input.direction ?? 'PAYABLE',
        amount,
        frequency: input.frequency as PaymentFrequency,
        nextDueDate: toBusinessDate(input.nextDueDate),
        categoryId: input.categoryId ?? null,
        counterpartyId: input.counterpartyId ?? null,
        autoCreate: input.autoCreate ?? false,
        remindDaysBefore: input.remindDaysBefore ?? 3,
        status: 'ACTIVE',
        notes: input.notes ?? null,
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'recurring.created',
      entityType: 'RecurringObligation',
      entityId: recurring.id,
      after: { name: recurring.name, amount: amount.toFixed(2), frequency: recurring.frequency },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.presentRecurring(recurring);
  }

  async listRecurring(user: AuthenticatedUser, entityId?: string) {
    const entityIds = await this.access.resolveScope(user.userId, entityId);
    const rows = await this.prisma.recurringObligation.findMany({
      where: { entityId: { in: entityIds }, status: { not: 'ENDED' } },
      orderBy: { nextDueDate: 'asc' },
      include: {
        counterparty: { select: { id: true, name: true } },
        entity: { select: { id: true, code: true, name: true } },
      },
    });
    return rows.map((row) => this.presentRecurring(row));
  }

  async updateRecurring(
    user: AuthenticatedUser,
    id: string,
    dto: { name?: string; amount?: string; frequency?: PaymentFrequency; nextDueDate?: string; status?: 'ACTIVE' | 'PAUSED' | 'ENDED'; remindDaysBefore?: number; notes?: string },
    meta: RequestMetaInfo,
  ) {
    const existing = await this.prisma.recurringObligation.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError('Obligación recurrente', id);
    }
    await this.access.assertCanWrite(user.userId, existing.entityId);

    const updated = await this.prisma.recurringObligation.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        amount: dto.amount ? validateMoney(dto.amount, { field: 'importe' }) : undefined,
        frequency: dto.frequency,
        nextDueDate: dto.nextDueDate ? toBusinessDate(dto.nextDueDate) : undefined,
        status: dto.status,
        remindDaysBefore: dto.remindDaysBefore,
        notes: dto.notes,
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'recurring.updated',
      entityType: 'RecurringObligation',
      entityId: id,
      before: { amount: existing.amount.toFixed(2), nextDueDate: existing.nextDueDate, status: existing.status },
      after: {
        amount: updated.amount.toFixed(2),
        nextDueDate: updated.nextDueDate,
        status: updated.status,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.presentRecurring(updated);
  }

  /**
   * Avanza el vencimiento de una obligación recurrente tras registrarla.
   * Lo usa el usuario al marcar "ya la pagué".
   */
  async rollForward(user: AuthenticatedUser, id: string, meta: RequestMetaInfo) {
    const recurring = await this.prisma.recurringObligation.findUnique({ where: { id } });
    if (!recurring) {
      throw new NotFoundError('Obligación recurrente', id);
    }
    await this.access.assertCanWrite(user.userId, recurring.entityId);

    const next = addPeriods(recurring.nextDueDate, recurring.frequency, 1);
    const updated = await this.prisma.recurringObligation.update({
      where: { id },
      data: { nextDueDate: next },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'recurring.rolled_forward',
      entityType: 'RecurringObligation',
      entityId: id,
      before: { nextDueDate: recurring.nextDueDate },
      after: { nextDueDate: updated.nextDueDate },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.presentRecurring(updated);
  }

  /**
   * TODO lo que vence en los próximos días: obligaciones recurrentes, cuentas
   * por pagar y cuotas de préstamos, en una sola lista ordenada.
   */
  async upcoming(user: AuthenticatedUser, entityId?: string, days = 15) {
    const entityIds = await this.access.resolveScope(user.userId, entityId);
    const today = businessToday();
    const limitDate = addBusinessDays(today, days);

    const [recurrings, payables, receivables, loans] = await Promise.all([
      this.prisma.recurringObligation.findMany({
        where: { entityId: { in: entityIds }, status: 'ACTIVE', nextDueDate: { lte: limitDate } },
      }),
      this.prisma.payable.findMany({
        where: {
          entityId: { in: entityIds },
          status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] },
          dueDate: { lte: limitDate },
        },
        include: { counterparty: { select: { name: true } }, entity: { select: { code: true, name: true } } },
      }),
      this.prisma.receivable.findMany({
        where: {
          entityId: { in: entityIds },
          status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] },
          dueDate: { lte: limitDate },
        },
        include: { counterparty: { select: { name: true } }, entity: { select: { code: true, name: true } } },
      }),
      this.prisma.loan.findMany({
        where: { entityId: { in: entityIds }, status: 'ACTIVE', nextDueDate: { lte: limitDate } },
        include: { entity: { select: { code: true, name: true } } },
      }),
    ]);

    const items = [
      ...recurrings.map((row) => ({
        type: 'RECURRING' as const,
        id: row.id,
        title: row.name,
        direction: row.direction,
        amount: row.amount.toFixed(2),
        dueDate: row.nextDueDate,
        daysRemaining: Math.round((row.nextDueDate.getTime() - today.getTime()) / 86_400_000),
        isOverdue: row.nextDueDate.getTime() < today.getTime(),
        detail: null as string | null,
      })),
      ...payables.map((row) => ({
        type: 'PAYABLE' as const,
        id: row.id,
        title: row.description,
        direction: 'PAYABLE' as const,
        amount: row.originalAmount.minus(row.settledAmount).toFixed(2),
        dueDate: row.dueDate ?? today,
        daysRemaining: row.dueDate ? Math.round((row.dueDate.getTime() - today.getTime()) / 86_400_000) : null,
        isOverdue: row.dueDate ? row.dueDate.getTime() < today.getTime() : false,
        detail: row.counterparty?.name ?? null,
      })),
      ...receivables.map((row) => ({
        type: 'RECEIVABLE' as const,
        id: row.id,
        title: row.description,
        direction: 'RECEIVABLE' as const,
        amount: row.originalAmount.minus(row.settledAmount).toFixed(2),
        dueDate: row.dueDate ?? today,
        daysRemaining: row.dueDate ? Math.round((row.dueDate.getTime() - today.getTime()) / 86_400_000) : null,
        isOverdue: row.dueDate ? row.dueDate.getTime() < today.getTime() : false,
        detail: row.counterparty?.name ?? null,
      })),
      ...loans.map((row) => ({
        type: 'LOAN' as const,
        id: row.id,
        title: row.name,
        direction: row.direction,
        amount: row.installmentAmount ? row.installmentAmount.toFixed(2) : row.currentBalance.toFixed(2),
        dueDate: row.nextDueDate ?? today,
        daysRemaining: row.nextDueDate ? Math.round((row.nextDueDate.getTime() - today.getTime()) / 86_400_000) : null,
        isOverdue: row.nextDueDate ? row.nextDueDate.getTime() < today.getTime() : false,
        detail: row.entity?.name ?? null,
      })),
    ];

    items.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

    const payableTotal = items
      .filter((item) => item.direction === 'PAYABLE')
      .reduce((acc, item) => acc.plus(dec(item.amount)), dec(0));
    const receivableTotal = items
      .filter((item) => item.direction === 'RECEIVABLE')
      .reduce((acc, item) => acc.plus(dec(item.amount)), dec(0));

    return {
      range: { from: today, to: limitDate, days },
      totals: {
        toPay: payableTotal.toFixed(2),
        toCollect: receivableTotal.toFixed(2),
        net: round2(receivableTotal.minus(payableTotal)).toFixed(2),
      },
      overdueCount: items.filter((item) => item.isOverdue).length,
      items: items.slice(0, 200),
    };
  }

  /** Marca como OVERDUE lo vencido. Lo invoca el planificador a diario. */
  async refreshOverdueStatus(entityIds: string[]): Promise<{ receivables: number; payables: number }> {
    const today = businessToday();
    const [receivables, payables] = await Promise.all([
      this.prisma.receivable.updateMany({
        where: { entityId: { in: entityIds }, status: { in: ['PENDING', 'PARTIAL'] }, dueDate: { lt: today } },
        data: { status: 'OVERDUE' },
      }),
      this.prisma.payable.updateMany({
        where: { entityId: { in: entityIds }, status: { in: ['PENDING', 'PARTIAL'] }, dueDate: { lt: today } },
        data: { status: 'OVERDUE' },
      }),
    ]);
    return { receivables: receivables.count, payables: payables.count };
  }

  // -------------------------------------------------------------------------
  // Cobros y pagos: SIEMPRE por el servicio de movimientos
  // -------------------------------------------------------------------------

  /**
   * Cobra una cuenta por cobrar (total o parcialmente).
   *
   * El dinero entra por la cuenta indicada y se registra como movimiento
   * financiero normal: eso garantiza el asiento de partida doble, la
   * idempotencia y la auditoría. El saldo pendiente NO se resta a mano: se
   * recalcula sumando los cobros registrados, de modo que anular un cobro
   * devuelve la deuda a su sitio automáticamente.
   */
  async settleReceivable(
    user: AuthenticatedUser,
    id: string,
    dto: SettleObligationDto,
    meta: RequestMetaInfo,
  ) {
    const receivable = await this.prisma.receivable.findUnique({ where: { id } });
    if (!receivable) {
      throw new NotFoundError('Cuenta por cobrar', id);
    }
    await this.access.assertCanWrite(user.userId, receivable.entityId);
    if (receivable.status === 'CANCELLED') {
      throw new ConflictError('Esta cuenta por cobrar está anulada y no admite cobros');
    }

    const amount = validateMoney(dto.amount, { field: 'importe del cobro' });
    const alreadySettled = await this.settledTotal('RECEIVABLE', id);
    const pending = round2(dec(receivable.originalAmount).minus(alreadySettled));
    if (gt(amount, pending)) {
      throw new ValidationError(
        `El cobro de ${amount.toFixed(2)} supera lo pendiente (${pending.toFixed(2)}) de «${receivable.description}». ` +
          'Corrija el importe o ajuste el importe original de la cuenta por cobrar.',
      );
    }

    const movement = await this.transactions.create(
      user,
      {
        clientOperationId: dto.clientOperationId,
        entityId: receivable.entityId,
        kind: 'RECEIVABLE_SETTLEMENT',
        accountId: dto.accountId,
        counterpartyId: receivable.counterpartyId ?? undefined,
        amount: amount.toFixed(2),
        businessDate: dto.businessDate,
        description: dto.description?.trim() || `Cobro: ${receivable.description}`,
        method: dto.method,
        reference: dto.reference,
        attachmentId: dto.attachmentId,
        receivableId: receivable.id,
      },
      meta,
    );

    const updated = await this.syncObligationState('RECEIVABLE', id);

    await this.audit.record({
      userId: user.userId,
      action: 'receivable.settled',
      entityType: 'Receivable',
      entityId: id,
      after: { amount: amount.toFixed(2), settledAmount: dec(updated.settledAmount).toFixed(2), status: updated.status },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      ...this.presentReceivable(updated),
      transaction: movement,
      message: (movement as { duplicate?: boolean }).duplicate
        ? 'Este cobro ya estaba registrado: no se ha duplicado.'
        : `Cobro registrado. Pendiente: ${round2(dec(updated.originalAmount).minus(dec(updated.settledAmount))).toFixed(2)}.`,
    };
  }

  /** Paga una cuenta por pagar (total o parcialmente). El dinero sale de la cuenta indicada. */
  async settlePayable(
    user: AuthenticatedUser,
    id: string,
    dto: SettleObligationDto,
    meta: RequestMetaInfo,
  ) {
    const payable = await this.prisma.payable.findUnique({ where: { id } });
    if (!payable) {
      throw new NotFoundError('Cuenta por pagar', id);
    }
    await this.access.assertCanWrite(user.userId, payable.entityId);
    if (payable.status === 'CANCELLED') {
      throw new ConflictError('Esta cuenta por pagar está anulada y no admite pagos');
    }

    const amount = validateMoney(dto.amount, { field: 'importe del pago' });
    const alreadySettled = await this.settledTotal('PAYABLE', id);
    const pending = round2(dec(payable.originalAmount).minus(alreadySettled));
    if (gt(amount, pending)) {
      throw new ValidationError(
        `El pago de ${amount.toFixed(2)} supera lo pendiente (${pending.toFixed(2)}) de «${payable.description}».`,
      );
    }

    const movement = await this.transactions.create(
      user,
      {
        clientOperationId: dto.clientOperationId,
        entityId: payable.entityId,
        kind: 'PAYABLE_SETTLEMENT',
        accountId: dto.accountId,
        counterpartyId: payable.counterpartyId ?? undefined,
        amount: amount.toFixed(2),
        businessDate: dto.businessDate,
        description: dto.description?.trim() || `Pago: ${payable.description}`,
        method: dto.method,
        reference: dto.reference,
        attachmentId: dto.attachmentId,
        payableId: payable.id,
      },
      meta,
    );

    const updated = await this.syncObligationState('PAYABLE', id);

    await this.audit.record({
      userId: user.userId,
      action: 'payable.settled',
      entityType: 'Payable',
      entityId: id,
      after: { amount: amount.toFixed(2), settledAmount: dec(updated.settledAmount).toFixed(2), status: updated.status },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      ...this.presentPayable(updated),
      transaction: movement,
      message: (movement as { duplicate?: boolean }).duplicate
        ? 'Este pago ya estaba registrado: no se ha duplicado.'
        : `Pago registrado. Pendiente: ${round2(dec(updated.originalAmount).minus(dec(updated.settledAmount))).toFixed(2)}.`,
    };
  }

  /**
   * Marca una obligación recurrente como cumplida por el período en curso:
   * registra el movimiento REAL (gasto o ingreso) y avanza el vencimiento.
   *
   * El identificador de operación es determinista por obligación y período
   * (`recurring_<id>_<vencimiento>`), así que pulsar dos veces —o reintentar sin
   * conexión— no crea dos gastos. Si ya estaba registrado, se devuelve el
   * movimiento existente sin volver a avanzar el período.
   */
  async payRecurring(
    user: AuthenticatedUser,
    id: string,
    dto: PayRecurringDto,
    meta: RequestMetaInfo,
  ) {
    const recurring = await this.prisma.recurringObligation.findUnique({ where: { id } });
    if (!recurring) {
      throw new NotFoundError('Obligación recurrente', id);
    }
    await this.access.assertCanWrite(user.userId, recurring.entityId);
    if (recurring.status === 'ENDED') {
      throw new ConflictError('Esta obligación está finalizada. Reactívela antes de registrar el pago.');
    }

    const dueIso = recurring.nextDueDate.toISOString().slice(0, 10);
    const amount = dto.amount ? validateMoney(dto.amount, { field: 'importe pagado' }) : dec(recurring.amount);
    const clientOperationId = dto.clientOperationId ?? `recurring_${recurring.id}_${dueIso}`;

    const alreadyPaid = await this.prisma.financialTransaction.findUnique({
      where: { clientOperationId },
      select: { id: true },
    });

    const movement = await this.transactions.create(
      user,
      {
        clientOperationId,
        entityId: recurring.entityId,
        kind: recurring.direction === 'PAYABLE' ? 'EXPENSE' : 'INCOME',
        accountId: dto.accountId,
        categoryId: dto.categoryId ?? recurring.categoryId ?? undefined,
        counterpartyId: recurring.counterpartyId ?? undefined,
        amount: amount.toFixed(2),
        businessDate: dto.businessDate ?? dueIso,
        description:
          dto.description?.trim() ||
          `${recurring.direction === 'PAYABLE' ? 'Pago' : 'Cobro'}: ${recurring.name} (${dueIso})`,
        method: dto.method,
        attachmentId: dto.attachmentId,
      },
      meta,
    );

    // El período avanza SÓLO si el movimiento es nuevo: si ya estaba registrado
    // (duplicado), avanzar otra vez dejaría saltarse un mes.
    let advanced: { nextDueDate: Date; status: string } | null = null;
    if (!alreadyPaid) {
      const nextDueDate = addPeriods(recurring.nextDueDate, recurring.frequency, 1);
      const updated = await this.prisma.recurringObligation.update({
        where: { id },
        data: { nextDueDate, status: recurring.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE' },
      });
      advanced = { nextDueDate: updated.nextDueDate, status: updated.status };
    }

    await this.audit.record({
      userId: user.userId,
      action: alreadyPaid ? 'recurring.pay_duplicate' : 'recurring.paid',
      entityType: 'RecurringObligation',
      entityId: id,
      after: {
        periodDue: dueIso,
        amount: amount.toFixed(2),
        nextDueDate: advanced ? advanced.nextDueDate.toISOString().slice(0, 10) : null,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const current = await this.prisma.recurringObligation.findUniqueOrThrow({
      where: { id },
      include: { counterparty: { select: { id: true, name: true, type: true } } },
    });

    return {
      ...this.presentRecurring(current),
      transaction: movement,
      paidPeriod: dueIso,
      alreadyPaid: Boolean(alreadyPaid),
      message: alreadyPaid
        ? `El período ${dueIso} ya estaba registrado: no se ha duplicado.`
        : `Registrado el ${dueIso}. El próximo vencimiento es el ${current.nextDueDate.toISOString().slice(0, 10)}.`,
    };
  }

  /**
   * Suma de los cobros (o pagos) realmente registrados sobre una obligación.
   * Se calcula desde los movimientos: es la única fuente de verdad.
   */
  private async settledTotal(kind: 'RECEIVABLE' | 'PAYABLE', obligationId: string) {
    const result = await this.prisma.financialTransaction.aggregate({
      where:
        kind === 'RECEIVABLE'
          ? { receivableId: obligationId, status: 'POSTED', voidedAt: null }
          : { payableId: obligationId, status: 'POSTED', voidedAt: null },
      _sum: { amount: true },
    });
    return dec(result._sum.amount ?? 0);
  }

  /**
   * Deja el estado guardado de la obligación igual a lo que dicen los
   * movimientos (saldo y estado). Nunca inventa: si no hay cobros, pendiente.
   */
  private async syncObligationState(kind: 'RECEIVABLE' | 'PAYABLE', obligationId: string) {
    if (kind === 'RECEIVABLE') {
      const row = await this.prisma.receivable.findUniqueOrThrow({ where: { id: obligationId } });
      // Se acota al importe original: dos envíos simultáneos del mismo cobro no
      // pueden dejar «pagado» más de lo que se debía.
      const settled = min(await this.settledTotal('RECEIVABLE', obligationId), dec(row.originalAmount));
      const original = dec(row.originalAmount);
      const status =
        row.status === 'CANCELLED'
          ? 'CANCELLED'
          : gte(settled, original)
            ? 'SETTLED'
            : gt(settled, 0)
              ? 'PARTIAL'
              : 'PENDING';
      return this.prisma.receivable.update({
        where: { id: obligationId },
        data: { settledAmount: settled, status },
      });
    }

    const row = await this.prisma.payable.findUniqueOrThrow({ where: { id: obligationId } });
    const settled = min(await this.settledTotal('PAYABLE', obligationId), dec(row.originalAmount));
    const original = dec(row.originalAmount);
    const status =
      row.status === 'CANCELLED'
        ? 'CANCELLED'
        : gte(settled, original)
          ? 'SETTLED'
          : gt(settled, 0)
            ? 'PARTIAL'
            : 'PENDING';
    return this.prisma.payable.update({
      where: { id: obligationId },
      data: { settledAmount: settled, status },
    });
  }

  private presentReceivable(row: {
    id: string;
    entityId: string;
    description: string;
    documentRef: string | null;
    originalAmount: DecimalInput;
    settledAmount: DecimalInput;
    currency: string;
    issueDate: Date;
    dueDate: Date | null;
    status: string;
    notes?: string | null;
    counterpartyId?: string | null;
    counterparty?: unknown;
    entity?: unknown;
  }) {
    return {
      id: row.id,
      entityId: row.entityId,
      entity: row.entity,
      counterpartyId: row.counterpartyId ?? null,
      counterparty: row.counterparty,
      description: row.description,
      documentRef: row.documentRef,
      originalAmount: dec(row.originalAmount).toFixed(2),
      settledAmount: dec(row.settledAmount).toFixed(2),
      pendingAmount: round2(dec(row.originalAmount).minus(dec(row.settledAmount))).toFixed(2),
      currency: row.currency,
      issueDate: row.issueDate,
      dueDate: row.dueDate,
      status: row.status,
      notes: row.notes ?? null,
    };
  }

  private presentPayable(row: {
    id: string;
    entityId: string;
    description: string;
    documentRef: string | null;
    originalAmount: DecimalInput;
    settledAmount: DecimalInput;
    currency: string;
    issueDate: Date;
    dueDate: Date | null;
    status: string;
    notes?: string | null;
    counterpartyId?: string | null;
    counterparty?: unknown;
    entity?: unknown;
  }) {
    return {
      id: row.id,
      entityId: row.entityId,
      entity: row.entity,
      counterpartyId: row.counterpartyId ?? null,
      counterparty: row.counterparty,
      description: row.description,
      documentRef: row.documentRef,
      originalAmount: dec(row.originalAmount).toFixed(2),
      settledAmount: dec(row.settledAmount).toFixed(2),
      pendingAmount: round2(dec(row.originalAmount).minus(dec(row.settledAmount))).toFixed(2),
      currency: row.currency,
      issueDate: row.issueDate,
      dueDate: row.dueDate,
      status: row.status,
      notes: row.notes ?? null,
    };
  }

  private presentRecurring(row: {
    id: string;
    entityId: string;
    name: string;
    direction: string;
    amount: DecimalInput;
    currency: string;
    frequency: string;
    nextDueDate: Date;
    categoryId: string | null;
    counterpartyId: string | null;
    autoCreate: boolean;
    remindDaysBefore: number;
    status: string;
    notes?: string | null;
    counterparty?: unknown;
    entity?: unknown;
  }) {
    const today = businessToday();
    return {
      id: row.id,
      entityId: row.entityId,
      entity: row.entity,
      name: row.name,
      direction: row.direction,
      amount: dec(row.amount).toFixed(2),
      currency: row.currency,
      frequency: row.frequency,
      nextDueDate: row.nextDueDate,
      daysToDue: Math.round((row.nextDueDate.getTime() - today.getTime()) / 86_400_000),
      categoryId: row.categoryId,
      counterpartyId: row.counterpartyId,
      counterparty: row.counterparty,
      autoCreate: row.autoCreate,
      remindDaysBefore: row.remindDaysBefore,
      status: row.status,
      notes: row.notes ?? null,
    };
  }
}
