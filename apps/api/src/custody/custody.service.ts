import { Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors.js';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { AuditService } from '../audit/audit.service.js';
import { LEDGER } from '../domain/chart-of-accounts.js';
import {
  allocateToFunds,
  collectionPostings,
  expenseFromCustodyPostings,
  settlementPostings,
  fundStatus,
} from '../domain/custody-rules.js';
import { toBusinessDate } from '../domain/business-date.js';
import { dec, round2, validateMoney } from '../domain/money.js';
import { postEntry, reverseEntry } from '../ledger/ledger-core.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';

/**
 * FONDOS EMPRESARIALES EN CUENTAS PERSONALES (CUSTODIA)
 * =====================================================
 * El propietario cobra para FULLTECH o APPYRA en su cuenta personal. Este
 * servicio permite registrarlo sin mentir en ningún lado:
 *
 *   · el banco personal sube lo que de verdad entró,
 *   · la empresa reconoce su ingreso (o cobra su factura) UNA vez,
 *   · el propietario no aparece ganando ese dinero (es un pasivo con la empresa),
 *   · y queda un pendiente de liquidar que se puede ir bajando cuando se
 *     transfiere o se paga un gasto, sin duplicar nada.
 *
 * Reglas duras (todas se comprueban aquí, no en la interfaz):
 *  · La cuenta que custodia debe ser de OTRA unidad y no ser tarjeta de crédito.
 *  · Se exige permiso de escritura en LAS DOS unidades implicadas.
 *  · Nunca se liquida más de lo pendiente ni se deja un pendiente negativo.
 *  · Todo va en una transacción de base de datos: o se registran los dos asientos
 *    y el pendiente, o no se registra nada.
 *  · Es idempotente por `clientOperationId`: reintentar no duplica.
 */

export interface CollectIntoCustodyInput {
  beneficiaryEntityId: string;
  holdingAccountId: string;
  /** INCOME = venta/servicio nuevo. RECEIVABLE_SETTLEMENT = cobro de factura ya contabilizada. */
  kind: 'INCOME' | 'RECEIVABLE_SETTLEMENT';
  amount: string;
  businessDate?: string;
  description: string;
  categoryId?: string;
  receivableId?: string;
  method?: string;
  clientOperationId?: string;
}

export interface SettleCustodyInput {
  beneficiaryEntityId: string;
  holdingAccountId: string;
  /** Cuenta de la empresa que recibe el dinero (banco o caja). */
  targetAccountId: string;
  amount: string;
  businessDate?: string;
  description?: string;
  clientOperationId?: string;
}

export interface PayExpenseFromCustodyInput {
  beneficiaryEntityId: string;
  holdingAccountId: string;
  /** Categoría del gasto (define la cuenta contable 5xxx/6xxx). */
  categoryId: string;
  amount: string;
  businessDate?: string;
  description: string;
  method?: string;
  clientOperationId?: string;
}

export interface PendingCustodyRow {
  beneficiaryEntityId: string;
  beneficiaryEntityName: string;
  holdingAccountId: string;
  holdingAccountName: string;
  holdingEntityName: string;
  currency: string;
  pending: string;
  funds: Array<{
    id: string;
    businessDate: string;
    description: string;
    originalAmount: string;
    appliedAmount: string;
    remaining: string;
    status: string;
  }>;
}

@Injectable()
export class CustodyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // 1. Cobro de una empresa que entra en una cuenta de otra unidad
  // -------------------------------------------------------------------------
  async collect(user: AuthenticatedUser, input: CollectIntoCustodyInput, meta: RequestMetaInfo) {
    const amount = validateMoney(input.amount, { field: 'importe del cobro' });
    const businessDate = toBusinessDate(input.businessDate);
    const clientOperationId =
      input.clientOperationId ?? `cus_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

    // Idempotencia: si ese identificador ya existe, se devuelve lo mismo.
    const yaExiste = await this.prisma.financialTransaction.findUnique({
      where: { clientOperationId },
      include: { custodySource: true },
    });
    if (yaExiste) {
      return {
        transactionId: yaExiste.id,
        custodyFundId: yaExiste.custodySource?.id ?? null,
        duplicate: true,
      };
    }

    await this.access.assertCanWrite(user.userId, input.beneficiaryEntityId);

    const beneficiary = await this.prisma.financialEntity.findUnique({
      where: { id: input.beneficiaryEntityId },
      select: { id: true, name: true, currency: true },
    });
    if (!beneficiary) {
      throw new NotFoundError('Unidad financiera', input.beneficiaryEntityId);
    }

    const holding = await this.loadHoldingAccount(user, input.holdingAccountId, input.beneficiaryEntityId, beneficiary.currency);

    // ¿Ingreso nuevo o cobro de una factura ya contabilizada?
    let contrapartidaCode: string;
    if (input.kind === 'RECEIVABLE_SETTLEMENT') {
      if (!input.receivableId) {
        throw new ValidationError('Para cobrar una factura indique cuál (receivableId)');
      }
      const receivable = await this.prisma.receivable.findUnique({
        where: { id: input.receivableId },
        select: { id: true, entityId: true, originalAmount: true, settledAmount: true },
      });
      if (!receivable) {
        throw new NotFoundError('Cuenta por cobrar', input.receivableId);
      }
      if (receivable.entityId !== input.beneficiaryEntityId) {
        throw new ValidationError('La factura pertenece a otra unidad financiera');
      }
      const pendiente = round2(receivable.originalAmount).minus(round2(receivable.settledAmount));
      if (amount.gt(pendiente)) {
        throw new ValidationError(
          `La factura sólo tiene ${pendiente.toFixed(2)} pendiente de cobro y se intentó cobrar ${amount.toFixed(2)}.`,
        );
      }
      contrapartidaCode = LEDGER.RECEIVABLE;
    } else {
      const category = await this.loadCategory(input.categoryId, input.beneficiaryEntityId, 'INCOME');
      contrapartidaCode = category?.defaultLedgerCode ?? LEDGER.OTHER_INCOME;
    }

    const postings = collectionPostings({
      amount,
      holdingLedgerCode: holding.ledgerAccount.code,
      contrapartidaCode,
      holdingAccountId: holding.id,
      memo: input.description,
    });

    const created = await this.prisma.inMoneyTransaction(async (tx) => {
      // Asiento de la empresa dueña: el dinero es suyo (activo 1130).
      const beneficiaryEntry = await postEntry(tx, {
        entityId: input.beneficiaryEntityId,
        businessDate,
        description: input.description,
        sourceType: 'CUSTODY',
        lines: postings.beneficiary,
        createdByUserId: user.userId,
      });

      // Asiento de quien tiene el dinero: el banco sube y debe ese dinero (2150).
      const holdingEntry = await postEntry(tx, {
        entityId: holding.entityId,
        businessDate,
        description: `${input.description} (cobro de ${beneficiary.name}, en custodia)`,
        sourceType: 'CUSTODY',
        lines: postings.holding,
        createdByUserId: user.userId,
      });

      const transaction = await tx.financialTransaction.create({
        data: {
          entityId: input.beneficiaryEntityId,
          kind: input.kind,
          status: 'POSTED',
          accountId: holding.id,
          categoryId: input.categoryId ?? null,
          receivableId: input.receivableId ?? null,
          journalEntryId: beneficiaryEntry.id,
          amount,
          currency: holding.currency,
          businessDate,
          description: input.description,
          method: input.method ?? null,
          clientOperationId,
          syncStatus: 'CONFIRMED',
          syncedAt: new Date(),
          createdByUserId: user.userId,
        },
      });

      await tx.financialTransaction.create({
        data: {
          entityId: holding.entityId,
          kind: 'CUSTODY_IN',
          status: 'POSTED',
          accountId: holding.id,
          journalEntryId: holdingEntry.id,
          amount,
          currency: holding.currency,
          businessDate,
          description: `Dinero de ${beneficiary.name} en custodia: ${input.description}`,
          clientOperationId: `${clientOperationId}:hold`,
          syncStatus: 'CONFIRMED',
          syncedAt: new Date(),
          createdByUserId: user.userId,
        },
      });

      const fund = await tx.custodyFund.create({
        data: {
          beneficiaryEntityId: input.beneficiaryEntityId,
          holdingAccountId: holding.id,
          sourceTransactionId: transaction.id,
          originalAmount: amount,
          appliedAmount: dec(0),
          status: 'OPEN',
          businessDate,
          description: input.description,
          createdByUserId: user.userId,
        },
      });

      if (input.receivableId) {
        await this.recomputeReceivable(tx, input.receivableId);
      }

      await this.audit.record(
        {
          userId: user.userId,
          action: 'custody.collected',
          entityType: 'CustodyFund',
          entityId: fund.id,
          after: {
            beneficiary: beneficiary.name,
            holdingAccount: holding.name,
            amount: amount.toFixed(2),
            kind: input.kind,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return { transactionId: transaction.id, custodyFundId: fund.id };
    });

    return { ...created, duplicate: false, pending: await this.pendingFor(input.beneficiaryEntityId, holding.id) };
  }

  // -------------------------------------------------------------------------
  // 2. Liquidación (total, parcial o agrupada) a una cuenta de la empresa
  // -------------------------------------------------------------------------
  async settle(user: AuthenticatedUser, input: SettleCustodyInput, meta: RequestMetaInfo) {
    const amount = validateMoney(input.amount, { field: 'importe de la liquidación' });
    const businessDate = toBusinessDate(input.businessDate);
    const clientOperationId =
      input.clientOperationId ?? `cusliq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

    const duplicado = await this.prisma.custodyMovement.findUnique({ where: { clientOperationId } });
    if (duplicado) {
      return { settlementId: duplicado.id, duplicate: true };
    }

    await this.access.assertCanWrite(user.userId, input.beneficiaryEntityId);
    const beneficiary = await this.prisma.financialEntity.findUnique({
      where: { id: input.beneficiaryEntityId },
      select: { id: true, name: true, currency: true },
    });
    if (!beneficiary) {
      throw new NotFoundError('Unidad financiera', input.beneficiaryEntityId);
    }

    const holding = await this.loadHoldingAccount(user, input.holdingAccountId, input.beneficiaryEntityId, beneficiary.currency);

    const target = await this.prisma.financialAccount.findUnique({
      where: { id: input.targetAccountId },
      include: { ledgerAccount: { select: { code: true } }, entity: { select: { name: true } } },
    });
    if (!target) {
      throw new NotFoundError('Cuenta financiera', input.targetAccountId);
    }
    if (target.entityId !== input.beneficiaryEntityId) {
      throw new ValidationError(
        `El dinero de ${beneficiary.name} sólo puede liquidarse en una cuenta de ${beneficiary.name}: la elegida es de ${target.entity.name}.`,
      );
    }
    if (target.status === 'CLOSED') {
      throw new ConflictError(`La cuenta "${target.name}" está cerrada`);
    }

    const funds = await this.pendingFunds(input.beneficiaryEntityId, holding.id);
    // Reparte (y falla si se intenta liquidar más de lo pendiente).
    const allocations = allocateToFunds(funds, amount);

    const postings = settlementPostings({
      amount,
      holdingLedgerCode: holding.ledgerAccount.code,
      targetLedgerCode: target.ledgerAccount.code,
      holdingAccountId: holding.id,
      targetAccountId: target.id,
      memo: input.description ?? `Liquidación a ${target.name}`,
    });

    const created = await this.prisma.inMoneyTransaction(async (tx) => {
      const holdingEntry = await postEntry(tx, {
        entityId: holding.entityId,
        businessDate,
        description: `Liquidación a ${beneficiary.name}: ${target.name}`,
        sourceType: 'CUSTODY',
        lines: postings.holding,
        createdByUserId: user.userId,
      });
      const beneficiaryEntry = await postEntry(tx, {
        entityId: input.beneficiaryEntityId,
        businessDate,
        description: `Liquidación recibida de ${holding.entityName} (${holding.name})`,
        sourceType: 'CUSTODY',
        lines: postings.beneficiary,
        createdByUserId: user.userId,
      });

      const movement = await tx.custodyMovement.create({
        data: {
          beneficiaryEntityId: input.beneficiaryEntityId,
          holdingAccountId: holding.id,
          targetAccountId: target.id,
          type: 'SETTLEMENT',
          amount,
          businessDate,
          description: input.description ?? `Liquidación a ${target.name}`,
          clientOperationId,
          holdingEntryId: holdingEntry.id,
          beneficiaryEntryId: beneficiaryEntry.id,
          createdByUserId: user.userId,
        },
      });

      for (const allocation of allocations) {
        await tx.custodyAllocation.create({
          data: { movementId: movement.id, fundId: allocation.fundId, amount: allocation.amount },
        });
        await tx.custodyFund.update({
          where: { id: allocation.fundId },
          data: { appliedAmount: allocation.newApplied, status: allocation.status },
        });
      }

      // Los dos movimientos visibles: salida de la cuenta que custodiaba y
      // entrada en la cuenta de la empresa. No hay ingreso ni gasto nuevo.
      await tx.financialTransaction.create({
        data: {
          entityId: holding.entityId,
          kind: 'CUSTODY_OUT',
          status: 'POSTED',
          accountId: holding.id,
          journalEntryId: holdingEntry.id,
          amount,
          currency: holding.currency,
          businessDate,
          description: `Liquidación a ${beneficiary.name} (${target.name})`,
          clientOperationId: `${clientOperationId}:out`,
          syncStatus: 'CONFIRMED',
          syncedAt: new Date(),
          createdByUserId: user.userId,
        },
      });
      await tx.financialTransaction.create({
        data: {
          entityId: input.beneficiaryEntityId,
          kind: 'CUSTODY_SETTLEMENT',
          status: 'POSTED',
          accountId: target.id,
          journalEntryId: beneficiaryEntry.id,
          amount,
          currency: target.currency,
          businessDate,
          description: `Liquidación de fondos en custodia (${holding.name})`,
          clientOperationId: `${clientOperationId}:in`,
          syncStatus: 'CONFIRMED',
          syncedAt: new Date(),
          createdByUserId: user.userId,
        },
      });

      await this.audit.record(
        {
          userId: user.userId,
          action: 'custody.settled',
          entityType: 'CustodyMovement',
          entityId: movement.id,
          after: {
            beneficiary: beneficiary.name,
            targetAccount: target.name,
            amount: amount.toFixed(2),
            funds: allocations.map((a) => ({ fundId: a.fundId, amount: a.amount.toFixed(2) })),
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return { settlementId: movement.id };
    });

    return {
      ...created,
      duplicate: false,
      pendingAfter: await this.pendingFor(input.beneficiaryEntityId, holding.id),
    };
  }

  // -------------------------------------------------------------------------
  // 3. Gasto de la empresa pagado con dinero que estaba en custodia
  // -------------------------------------------------------------------------
  async payExpenseFromCustody(user: AuthenticatedUser, input: PayExpenseFromCustodyInput, meta: RequestMetaInfo) {
    const amount = validateMoney(input.amount, { field: 'importe del gasto' });
    const businessDate = toBusinessDate(input.businessDate);
    const clientOperationId =
      input.clientOperationId ?? `cusgas_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

    const duplicado = await this.prisma.custodyMovement.findUnique({ where: { clientOperationId } });
    if (duplicado) {
      return { expenseMovementId: duplicado.id, duplicate: true };
    }

    await this.access.assertCanWrite(user.userId, input.beneficiaryEntityId);
    const beneficiary = await this.prisma.financialEntity.findUnique({
      where: { id: input.beneficiaryEntityId },
      select: { id: true, name: true, currency: true },
    });
    if (!beneficiary) {
      throw new NotFoundError('Unidad financiera', input.beneficiaryEntityId);
    }

    const holding = await this.loadHoldingAccount(user, input.holdingAccountId, input.beneficiaryEntityId, beneficiary.currency);
    const category = await this.loadCategory(input.categoryId, input.beneficiaryEntityId, 'EXPENSE');
    if (!category) {
      throw new ValidationError('Indique la categoría del gasto');
    }

    const funds = await this.pendingFunds(input.beneficiaryEntityId, holding.id);
    const allocations = allocateToFunds(funds, amount);

    const postings = expenseFromCustodyPostings({
      amount,
      expenseLedgerCode: category.defaultLedgerCode ?? LEDGER.OTHER_OPERATING_EXPENSE,
      holdingLedgerCode: holding.ledgerAccount.code,
      holdingAccountId: holding.id,
      memo: input.description,
    });

    const created = await this.prisma.inMoneyTransaction(async (tx) => {
      const beneficiaryEntry = await postEntry(tx, {
        entityId: input.beneficiaryEntityId,
        businessDate,
        description: input.description,
        sourceType: 'CUSTODY',
        lines: postings.beneficiary,
        createdByUserId: user.userId,
      });
      const holdingEntry = await postEntry(tx, {
        entityId: holding.entityId,
        businessDate,
        description: `${input.description} (gasto de ${beneficiary.name} pagado con fondos en custodia)`,
        sourceType: 'CUSTODY',
        lines: postings.holding,
        createdByUserId: user.userId,
      });

      const expenseTransaction = await tx.financialTransaction.create({
        data: {
          entityId: input.beneficiaryEntityId,
          kind: 'EXPENSE',
          status: 'POSTED',
          accountId: holding.id,
          categoryId: input.categoryId,
          journalEntryId: beneficiaryEntry.id,
          amount,
          currency: holding.currency,
          businessDate,
          description: input.description,
          method: input.method ?? null,
          clientOperationId,
          syncStatus: 'CONFIRMED',
          syncedAt: new Date(),
          createdByUserId: user.userId,
        },
      });

      await tx.financialTransaction.create({
        data: {
          entityId: holding.entityId,
          kind: 'CUSTODY_OUT',
          status: 'POSTED',
          accountId: holding.id,
          journalEntryId: holdingEntry.id,
          amount,
          currency: holding.currency,
          businessDate,
          description: `Pago de gasto de ${beneficiary.name} con fondos en custodia`,
          clientOperationId: `${clientOperationId}:out`,
          syncStatus: 'CONFIRMED',
          syncedAt: new Date(),
          createdByUserId: user.userId,
        },
      });

      const movement = await tx.custodyMovement.create({
        data: {
          beneficiaryEntityId: input.beneficiaryEntityId,
          holdingAccountId: holding.id,
          expenseTransactionId: expenseTransaction.id,
          type: 'EXPENSE',
          amount,
          businessDate,
          description: input.description,
          clientOperationId,
          holdingEntryId: holdingEntry.id,
          beneficiaryEntryId: beneficiaryEntry.id,
          createdByUserId: user.userId,
        },
      });

      for (const allocation of allocations) {
        await tx.custodyAllocation.create({
          data: { movementId: movement.id, fundId: allocation.fundId, amount: allocation.amount },
        });
        await tx.custodyFund.update({
          where: { id: allocation.fundId },
          data: { appliedAmount: allocation.newApplied, status: allocation.status },
        });
      }

      await this.audit.record(
        {
          userId: user.userId,
          action: 'custody.expense_paid',
          entityType: 'CustodyMovement',
          entityId: movement.id,
          after: { beneficiary: beneficiary.name, amount: amount.toFixed(2), category: category.name },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return { expenseMovementId: movement.id, expenseTransactionId: expenseTransaction.id };
    });

    return {
      ...created,
      duplicate: false,
      pendingAfter: await this.pendingFor(input.beneficiaryEntityId, holding.id),
    };
  }

  // -------------------------------------------------------------------------
  // 4. Consulta de lo que hay pendiente de liquidar
  // -------------------------------------------------------------------------
  async pending(user: AuthenticatedUser, query: { beneficiaryEntityId?: string; holdingAccountId?: string }) {
    const scopeIds = query.beneficiaryEntityId
      ? [query.beneficiaryEntityId]
      : await this.access.listAccessibleEntityIds(user.userId);
    if (query.beneficiaryEntityId) {
      await this.access.assertCanRead(user.userId, query.beneficiaryEntityId);
    }
    if (scopeIds.length === 0) {
      return { rows: [] as PendingCustodyRow[], total: '0.00' };
    }

    const funds = await this.prisma.custodyFund.findMany({
      where: {
        beneficiaryEntityId: { in: scopeIds },
        status: { in: ['OPEN', 'PARTIAL'] },
        ...(query.holdingAccountId ? { holdingAccountId: query.holdingAccountId } : {}),
      },
      include: {
        beneficiaryEntity: { select: { name: true } },
        holdingAccount: { select: { name: true, currency: true, entity: { select: { name: true } } } },
      },
      orderBy: [{ businessDate: 'asc' }, { createdAt: 'asc' }],
    });

    const byKey = new Map<string, PendingCustodyRow>();
    for (const fund of funds) {
      const remaining = round2(fund.originalAmount).minus(round2(fund.appliedAmount));
      if (remaining.lte(0)) {
        continue;
      }
      const key = `${fund.beneficiaryEntityId}|${fund.holdingAccountId}`;
      const row =
        byKey.get(key) ??
        ({
          beneficiaryEntityId: fund.beneficiaryEntityId,
          beneficiaryEntityName: fund.beneficiaryEntity.name,
          holdingAccountId: fund.holdingAccountId,
          holdingAccountName: fund.holdingAccount.name,
          holdingEntityName: fund.holdingAccount.entity.name,
          currency: fund.holdingAccount.currency,
          pending: '0.00',
          funds: [],
        } satisfies PendingCustodyRow);
      row.pending = round2(row.pending).plus(remaining).toFixed(2);
      row.funds.push({
        id: fund.id,
        businessDate: fund.businessDate.toISOString().slice(0, 10),
        description: fund.description,
        originalAmount: round2(fund.originalAmount).toFixed(2),
        appliedAmount: round2(fund.appliedAmount).toFixed(2),
        remaining: remaining.toFixed(2),
        status: fund.status,
      });
      byKey.set(key, row);
    }

    const rows = [...byKey.values()];
    const total = rows.reduce((acc, row) => acc.plus(round2(row.pending)), round2(0));
    return { rows, total: total.toFixed(2) };
  }

  // -------------------------------------------------------------------------
  // 5. Anulación de una liquidación o de un gasto pagado con custodia
  // -------------------------------------------------------------------------
  async voidMovement(user: AuthenticatedUser, movementId: string, reason: string, meta: RequestMetaInfo) {
    if (!reason || reason.trim().length < 5) {
      throw new ValidationError('Explique por qué se anula (mínimo 5 caracteres): queda en la auditoría');
    }
    const movement = await this.prisma.custodyMovement.findUnique({
      where: { id: movementId },
      include: { allocations: true },
    });
    if (!movement) {
      throw new NotFoundError('Liquidación de custodia', movementId);
    }
    if (movement.status !== 'POSTED') {
      throw new ConflictError('Esta operación ya está anulada');
    }
    await this.access.assertCanWrite(user.userId, movement.beneficiaryEntityId);

    await this.prisma.inMoneyTransaction(async (tx) => {
      const businessDate = toBusinessDate();
      // Se reversan los dos asientos (no se borra nada).
      if (movement.holdingEntryId) {
        await reverseEntry(tx, {
          entryId: movement.holdingEntryId,
          reason: reason.trim(),
          businessDate,
          createdByUserId: user.userId,
        });
      }
      if (movement.beneficiaryEntryId) {
        await reverseEntry(tx, {
          entryId: movement.beneficiaryEntryId,
          reason: reason.trim(),
          businessDate,
          createdByUserId: user.userId,
        });
      }

      // El pendiente vuelve a su sitio exactamente como estaba.
      for (const allocation of movement.allocations) {
        const fund = await tx.custodyFund.findUnique({ where: { id: allocation.fundId } });
        if (!fund) {
          continue;
        }
        const newApplied = round2(fund.appliedAmount).minus(round2(allocation.amount));
        await tx.custodyFund.update({
          where: { id: fund.id },
          data: {
            appliedAmount: newApplied.isNegative() ? dec(0) : newApplied,
            status: fundStatus(fund.originalAmount, newApplied.isNegative() ? dec(0) : newApplied),
          },
        });
      }

      await tx.custodyMovement.update({
        where: { id: movement.id },
        data: { status: 'VOIDED', voidedAt: new Date(), voidReason: reason.trim() },
      });

      // Los movimientos visibles de esa operación quedan anulados (con su rastro).
      await tx.financialTransaction.updateMany({
        where: {
          OR: [
            { clientOperationId: movement.clientOperationId },
            { clientOperationId: `${movement.clientOperationId}:out` },
            { clientOperationId: `${movement.clientOperationId}:in` },
          ],
          status: 'POSTED',
        },
        data: { status: 'VOIDED', voidedAt: new Date(), voidReason: reason.trim() },
      });

      await this.audit.record(
        {
          userId: user.userId,
          action: 'custody.voided',
          entityType: 'CustodyMovement',
          entityId: movement.id,
          before: { status: 'POSTED', amount: movement.amount.toFixed(2) },
          after: { status: 'VOIDED', reason: reason.trim() },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return { id: movement.id, status: 'VOIDED' as const };
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  /** Carga la cuenta que custodia y comprueba TODO lo que puede salir mal. */
  private async loadHoldingAccount(
    user: AuthenticatedUser,
    holdingAccountId: string,
    beneficiaryEntityId: string,
    beneficiaryCurrency: string,
  ) {
    const account = await this.prisma.financialAccount.findUnique({
      where: { id: holdingAccountId },
      include: {
        ledgerAccount: { select: { code: true } },
        entity: { select: { id: true, name: true, currency: true } },
      },
    });
    if (!account) {
      throw new NotFoundError('Cuenta financiera', holdingAccountId);
    }
    if (account.entityId === beneficiaryEntityId) {
      throw new ValidationError(
        'Esa cuenta es de la propia unidad: registre el cobro como un ingreso normal (no es dinero en custodia).',
      );
    }
    if (account.status === 'CLOSED') {
      throw new ConflictError(`La cuenta "${account.name}" está cerrada`);
    }
    if (account.isCreditCard || account.type === 'CREDIT_CARD') {
      throw new ValidationError('Una tarjeta de crédito no puede custodiar dinero: elija una cuenta bancaria o de caja');
    }
    if (account.currency !== beneficiaryCurrency) {
      throw new ValidationError(
        `La cuenta está en ${account.currency} y la unidad en ${beneficiaryCurrency}: no se mezclan monedas sin tipo de cambio explícito.`,
      );
    }
    // Permiso sobre la unidad que físicamente tiene el dinero.
    await this.access.assertCanWrite(user.userId, account.entityId);

    return Object.assign(account, { entityName: account.entity.name });
  }

  private async loadCategory(categoryId: string | undefined, entityId: string, kind: 'INCOME' | 'EXPENSE') {
    if (!categoryId) {
      return null;
    }
    const category = await this.prisma.transactionCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, name: true, kind: true, defaultLedgerCode: true, entityId: true, isActive: true },
    });
    if (!category) {
      throw new NotFoundError('Categoría', categoryId);
    }
    if (category.entityId && category.entityId !== entityId) {
      throw new ValidationError('La categoría no pertenece a esta unidad financiera');
    }
    if (category.kind !== kind) {
      throw new ValidationError(
        `La categoría "${category.name}" es de ${category.kind === 'INCOME' ? 'ingresos' : 'gastos'} y aquí se necesita de ${kind === 'INCOME' ? 'ingresos' : 'gastos'}.`,
      );
    }
    if (!category.isActive) {
      throw new ConflictError(`La categoría "${category.name}" está desactivada`);
    }
    return category;
  }

  private async pendingFunds(beneficiaryEntityId: string, holdingAccountId: string) {
    return this.prisma.custodyFund.findMany({
      where: { beneficiaryEntityId, holdingAccountId, status: { in: ['OPEN', 'PARTIAL'] } },
      select: { id: true, originalAmount: true, appliedAmount: true, businessDate: true, createdAt: true },
      orderBy: [{ businessDate: 'asc' }, { createdAt: 'asc' }],
    });
  }

  private async pendingFor(beneficiaryEntityId: string, holdingAccountId: string): Promise<string> {
    const funds = await this.pendingFunds(beneficiaryEntityId, holdingAccountId);
    return funds
      .reduce((acc, fund) => acc.plus(round2(fund.originalAmount).minus(round2(fund.appliedAmount))), round2(0))
      .toFixed(2);
  }

  /** Recalcula lo cobrado de una factura (mismo criterio que TransactionsService). */
  private async recomputeReceivable(
    tx: Parameters<Parameters<PrismaService['inMoneyTransaction']>[0]>[0],
    receivableId: string,
  ): Promise<void> {
    const receivable = await tx.receivable.findUnique({
      where: { id: receivableId },
      select: { id: true, originalAmount: true },
    });
    if (!receivable) {
      return;
    }
    const settlements = await tx.financialTransaction.findMany({
      where: { receivableId, status: 'POSTED', kind: 'RECEIVABLE_SETTLEMENT' },
      select: { amount: true },
    });
    const settled = settlements.reduce((acc, row) => acc.plus(round2(row.amount)), round2(0));
    const capped = settled.gt(round2(receivable.originalAmount)) ? round2(receivable.originalAmount) : settled;
    await tx.receivable.update({
      where: { id: receivableId },
      data: {
        settledAmount: capped,
        status: capped.eq(0) ? 'PENDING' : capped.eq(round2(receivable.originalAmount)) ? 'SETTLED' : 'PARTIAL',
      },
    });
  }
}
