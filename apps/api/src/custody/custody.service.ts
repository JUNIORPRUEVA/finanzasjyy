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
  openingCustodyPostings,
  settlementPostings,
  fundStatus,
} from '../domain/custody-rules.js';
import { toBusinessDate } from '../domain/business-date.js';
import { dec, round2, validateMoney } from '../domain/money.js';
import { accountBalance, balancesForAccounts, postEntry, reverseEntry } from '../ledger/ledger-core.js';
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

export interface OpenCustodyInput {
  beneficiaryEntityId: string;
  holdingAccountId: string;
  amount: string;
  businessDate?: string;
  description: string;
  clientOperationId?: string;
}

/** Fila del panel: una cuenta real con su dinero real y de quién es. */
export interface CustodySummaryAccount {
  accountId: string;
  accountName: string;
  entityId: string;
  entityName: string;
  ledgerCode: string;
  currency: string;
  /** Saldo que dice el banco (calculado del libro, incluye el saldo inicial). */
  realBalance: string;
  /** Parte de ese saldo que pertenece a empresas y sigue bajo custodia. */
  custody: string;
  /** Lo que de verdad es del propietario: real − custodia. */
  personalNet: string;
  custodyByBeneficiary: Array<{ entityId: string; entityName: string; pending: string; funds: number }>;
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
        pending: yaExiste.custodySource
          ? await this.pendingFor(yaExiste.custodySource.beneficiaryEntityId, yaExiste.custodySource.holdingAccountId)
          : null,
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
  // 2. Apertura: dinero de la empresa que YA estaba depositado antes de FINANZA
  // -------------------------------------------------------------------------
  /**
   * Registra como custodia un dinero que ya estaba en la cuenta personal: no es
   * una venta nueva ni un cobro nuevo, así que NO crea ingresos ni recobra
   * facturas. Sólo reasigna la propiedad del dinero que ya está en el banco:
   *
   *   · el banco no se mueve (su saldo sigue coincidiendo con el extracto),
   *   · la empresa reconoce su activo (1130) contra patrimonio de apertura (3400),
   *   · el propietario deja de deberlo a sí mismo y se lo debe a la empresa (2150).
   *
   * Se niega a declarar más custodia que dinero hay realmente libre en la cuenta:
   * si el banco tiene 10.000 y ya hay 8.000 declarados, sólo se pueden declarar
   * 2.000 más. Así el neto personal nunca sale de la nada.
   */
  async openExistingFunds(user: AuthenticatedUser, input: OpenCustodyInput, meta: RequestMetaInfo) {
    const amount = validateMoney(input.amount, { field: 'importe de los fondos ya depositados' });
    const businessDate = toBusinessDate(input.businessDate);
    const clientOperationId =
      input.clientOperationId ?? `cusap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

    const yaExiste = await this.prisma.financialTransaction.findUnique({
      where: { clientOperationId },
      include: { custodySource: true },
    });
    if (yaExiste) {
      return {
        transactionId: yaExiste.id,
        custodyFundId: yaExiste.custodySource?.id ?? null,
        duplicate: true,
        pending: yaExiste.custodySource
          ? await this.pendingFor(yaExiste.custodySource.beneficiaryEntityId, yaExiste.custodySource.holdingAccountId)
          : null,
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

    const holding = await this.loadHoldingAccount(
      user,
      input.holdingAccountId,
      input.beneficiaryEntityId,
      beneficiary.currency,
    );

    // ¿Cuánto dinero hay de verdad en la cuenta y cuánto ya está asignado?
    const balance = await accountBalance(this.prisma, { financialAccountId: holding.id });
    const yaAsignado = await this.totalPendingInAccount(holding.id);
    const libre = round2(balance.balance).minus(yaAsignado);
    if (amount.gt(libre)) {
      throw new ValidationError(
        `En "${holding.name}" sólo quedan ${libre.gt(0) ? libre.toFixed(2) : '0.00'} sin asignar de un saldo de ` +
          `${round2(balance.balance).toFixed(2)} y se intentaron declarar ${amount.toFixed(2)}. ` +
          'Registre primero el saldo real de la cuenta (Cuentas → saldo inicial) o indique una cantidad menor.',
      );
    }

    const postings = openingCustodyPostings({ amount, memo: input.description });

    const created = await this.prisma.inMoneyTransaction(async (tx) => {
      const beneficiaryEntry = await postEntry(tx, {
        entityId: input.beneficiaryEntityId,
        businessDate,
        description: `Fondos ya depositados: ${input.description}`,
        sourceType: 'CUSTODY',
        lines: postings.beneficiary,
        createdByUserId: user.userId,
      });
      const holdingEntry = await postEntry(tx, {
        entityId: holding.entityId,
        businessDate,
        description: `Fondos de ${beneficiary.name} que ya estaban en ${holding.name}: ${input.description}`,
        sourceType: 'CUSTODY',
        lines: postings.holding,
        createdByUserId: user.userId,
      });

      // Movimiento de la empresa: es dinero suyo desde antes (no un ingreso).
      const transaction = await tx.financialTransaction.create({
        data: {
          entityId: input.beneficiaryEntityId,
          kind: 'CUSTODY_OPENING',
          status: 'POSTED',
          accountId: holding.id,
          journalEntryId: beneficiaryEntry.id,
          amount,
          currency: holding.currency,
          businessDate,
          description: input.description,
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
          description: `Fondos de ${beneficiary.name} ya depositados (apertura): ${input.description}`,
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

      await this.audit.record(
        {
          userId: user.userId,
          action: 'custody.opening_recorded',
          entityType: 'CustodyFund',
          entityId: fund.id,
          after: {
            beneficiary: beneficiary.name,
            holdingAccount: holding.name,
            amount: amount.toFixed(2),
            realBalance: round2(balance.balance).toFixed(2),
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
  // 3. Liquidación (total, parcial o agrupada) a una cuenta de la empresa
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
  // 4. Gasto de la empresa pagado con dinero que estaba en custodia
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
  // 5. Consulta de lo que hay pendiente de liquidar
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
  // 6. Panel: saldo real, fondos de empresas y neto personal de cada cuenta
  // -------------------------------------------------------------------------
  /**
   * Responde a la pregunta que el propietario hace de verdad: «en mi BHD y mi
   * Banreservas, ¿cuánto es mío y cuánto es de Fulltech o de APPYRA?».
   *
   *   saldo real    = lo que dice el banco (libro mayor, incluye saldo inicial)
   *   en custodia   = lo que sigue pendiente de liquidar de empresas
   *   neto personal = saldo real − en custodia
   *
   * Las tarjetas y las cuentas cerradas no entran: una tarjeta no custodia dinero.
   */
  async summary(user: AuthenticatedUser, query: { holdingAccountId?: string }) {
    const entityIds = await this.access.listAccessibleEntityIds(user.userId);
    if (entityIds.length === 0) {
      return {
        generatedAt: new Date().toISOString(),
        totals: { realBalance: '0.00', custody: '0.00', personalNet: '0.00' },
        byBeneficiary: [] as Array<{ entityId: string; entityName: string; pending: string }>,
        accounts: [] as CustodySummaryAccount[],
      };
    }

    const accounts = await this.prisma.financialAccount.findMany({
      where: {
        entityId: { in: entityIds },
        status: { not: 'CLOSED' },
        isCreditCard: false,
        type: { not: 'CREDIT_CARD' },
        ...(query.holdingAccountId ? { id: query.holdingAccountId } : {}),
      },
      select: {
        id: true,
        name: true,
        currency: true,
        entityId: true,
        entity: { select: { name: true } },
        ledgerAccount: { select: { code: true } },
      },
      orderBy: [{ entityId: 'asc' }, { name: 'asc' }],
    });

    if (accounts.length === 0) {
      return {
        generatedAt: new Date().toISOString(),
        totals: { realBalance: '0.00', custody: '0.00', personalNet: '0.00' },
        byBeneficiary: [] as Array<{ entityId: string; entityName: string; pending: string }>,
        accounts: [] as CustodySummaryAccount[],
      };
    }

    const accountIds = accounts.map((account) => account.id);
    const [balances, funds] = await Promise.all([
      balancesForAccounts(this.prisma, { financialAccountIds: accountIds }),
      this.prisma.custodyFund.findMany({
        where: { holdingAccountId: { in: accountIds }, status: { in: ['OPEN', 'PARTIAL'] } },
        select: {
          holdingAccountId: true,
          beneficiaryEntityId: true,
          originalAmount: true,
          appliedAmount: true,
          beneficiaryEntity: { select: { name: true } },
        },
      }),
    ]);

    // Custodia pendiente por (cuenta, empresa).
    const custody = new Map<string, Map<string, { name: string; pending: ReturnType<typeof dec>; funds: number }>>();
    const porEmpresa = new Map<string, { entityName: string; pending: ReturnType<typeof dec> }>();
    for (const fund of funds) {
      const remaining = round2(fund.originalAmount).minus(round2(fund.appliedAmount));
      if (remaining.lte(0)) {
        continue;
      }
      const porCuenta = custody.get(fund.holdingAccountId) ?? new Map();
      const actual = porCuenta.get(fund.beneficiaryEntityId) ?? {
        name: fund.beneficiaryEntity.name,
        pending: dec(0),
        funds: 0,
      };
      actual.pending = actual.pending.plus(remaining);
      actual.funds += 1;
      porCuenta.set(fund.beneficiaryEntityId, actual);
      custody.set(fund.holdingAccountId, porCuenta);

      const global = porEmpresa.get(fund.beneficiaryEntityId) ?? {
        entityName: fund.beneficiaryEntity.name,
        pending: dec(0),
      };
      global.pending = global.pending.plus(remaining);
      porEmpresa.set(fund.beneficiaryEntityId, global);
    }

    let totalReal = dec(0);
    let totalCustody = dec(0);
    const rows: CustodySummaryAccount[] = accounts.map((account) => {
      const realBalance = round2(balances.get(account.id)?.balance ?? 0);
      const porCuenta = custody.get(account.id) ?? new Map();
      const custodyByBeneficiary = [...porCuenta.entries()]
        .map(([entityId, value]) => ({
          entityId,
          entityName: value.name,
          pending: round2(value.pending).toFixed(2),
          funds: value.funds,
        }))
        .sort((a, b) => Number(b.pending) - Number(a.pending));
      const enCustodia = [...porCuenta.values()].reduce((acc, value) => acc.plus(round2(value.pending)), dec(0));

      totalReal = totalReal.plus(realBalance);
      totalCustody = totalCustody.plus(enCustodia);

      return {
        accountId: account.id,
        accountName: account.name,
        entityId: account.entityId,
        entityName: account.entity.name,
        ledgerCode: account.ledgerAccount.code,
        currency: account.currency,
        realBalance: realBalance.toFixed(2),
        custody: round2(enCustodia).toFixed(2),
        personalNet: round2(realBalance).minus(round2(enCustodia)).toFixed(2),
        custodyByBeneficiary,
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      totals: {
        realBalance: round2(totalReal).toFixed(2),
        custody: round2(totalCustody).toFixed(2),
        personalNet: round2(totalReal).minus(round2(totalCustody)).toFixed(2),
      },
      byBeneficiary: [...porEmpresa.entries()]
        .map(([entityId, value]) => ({
          entityId,
          entityName: value.entityName,
          pending: round2(value.pending).toFixed(2),
        }))
        .sort((a, b) => Number(b.pending) - Number(a.pending)),
      accounts: rows,
    };
  }

  // -------------------------------------------------------------------------
  // 6b. Historial: cobros, aperturas, liquidaciones y gastos
  // -------------------------------------------------------------------------
  async movements(user: AuthenticatedUser, query: { beneficiaryEntityId?: string; holdingAccountId?: string; limit?: string }) {
    const scopeIds = query.beneficiaryEntityId
      ? [query.beneficiaryEntityId]
      : await this.access.listAccessibleEntityIds(user.userId);
    if (query.beneficiaryEntityId) {
      await this.access.assertCanRead(user.userId, query.beneficiaryEntityId);
    }
    const limite = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    if (scopeIds.length === 0) {
      return { funds: [], movements: [] };
    }

    const filtroCuenta = query.holdingAccountId ? { holdingAccountId: query.holdingAccountId } : {};

    const [funds, movements] = await Promise.all([
      this.prisma.custodyFund.findMany({
        where: { beneficiaryEntityId: { in: scopeIds }, ...filtroCuenta },
        include: {
          beneficiaryEntity: { select: { name: true } },
          holdingAccount: { select: { name: true, entity: { select: { name: true } } } },
          sourceTransaction: { select: { kind: true } },
        },
        orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
        take: limite,
      }),
      this.prisma.custodyMovement.findMany({
        where: { beneficiaryEntityId: { in: scopeIds }, ...filtroCuenta },
        include: {
          beneficiaryEntity: { select: { name: true } },
          holdingAccount: { select: { name: true, entity: { select: { name: true } } } },
          targetAccount: { select: { name: true } },
          _count: { select: { allocations: true } },
        },
        orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
        take: limite,
      }),
    ]);

    return {
      funds: funds.map((fund) => {
        const original = round2(fund.originalAmount);
        const applied = round2(fund.appliedAmount);
        return {
          id: fund.id,
          kind: fund.sourceTransaction.kind,
          beneficiaryEntityId: fund.beneficiaryEntityId,
          beneficiaryEntityName: fund.beneficiaryEntity.name,
          holdingAccountId: fund.holdingAccountId,
          holdingAccountName: fund.holdingAccount.name,
          holdingEntityName: fund.holdingAccount.entity.name,
          businessDate: fund.businessDate.toISOString().slice(0, 10),
          description: fund.description,
          originalAmount: original.toFixed(2),
          appliedAmount: applied.toFixed(2),
          remaining: original.minus(applied).toFixed(2),
          status: fund.status,
        };
      }),
      movements: movements.map((movement) => ({
        id: movement.id,
        type: movement.type,
        status: movement.status,
        beneficiaryEntityId: movement.beneficiaryEntityId,
        beneficiaryEntityName: movement.beneficiaryEntity.name,
        holdingAccountId: movement.holdingAccountId,
        holdingAccountName: movement.holdingAccount.name,
        holdingEntityName: movement.holdingAccount.entity.name,
        targetAccountName: movement.targetAccount?.name ?? null,
        amount: round2(movement.amount).toFixed(2),
        businessDate: movement.businessDate.toISOString().slice(0, 10),
        description: movement.description,
        fundsCovered: movement._count.allocations,
        voidedAt: movement.voidedAt ? movement.voidedAt.toISOString() : null,
        voidReason: movement.voidReason,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // 7. Anulación de una liquidación o de un gasto pagado con custodia
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

  /** Custodia pendiente de TODAS las empresas en una cuenta (para la guarda de apertura). */
  private async totalPendingInAccount(holdingAccountId: string) {
    const funds = await this.prisma.custodyFund.findMany({
      where: { holdingAccountId, status: { in: ['OPEN', 'PARTIAL'] } },
      select: { originalAmount: true, appliedAmount: true },
    });
    return funds.reduce(
      (acc, fund) => acc.plus(round2(fund.originalAmount).minus(round2(fund.appliedAmount))),
      round2(0),
    );
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
