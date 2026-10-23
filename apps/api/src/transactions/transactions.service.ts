import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { TxnKind } from '../generated/prisma/enums.js';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import {
  ConflictError,
  IdempotencyConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import { toBusinessDate } from '../domain/business-date.js';
import { dec, eq, min, round2, sum, validateMoney, type DecimalInput } from '../domain/money.js';
import { defaultPaymentMethod } from '../domain/payment-method.js';
import { postEntry, reverseEntry, type JournalLineInput, type Tx } from '../ledger/ledger-core.js';
import { buildPostingLines } from '../ledger/posting-rules.js';
import { hashToken, stableStringify } from '../auth/tokens.js';
import type { CreateTransactionDto, ListTransactionsQuery } from './transactions.dto.js';

export interface TransactionResult {
  id: string;
  kind: TxnKind;
  status: string;
  amount: string;
  currency: string;
  businessDate: Date;
  description: string;
  accountId: string;
  categoryId: string | null;
  journalEntryId: string | null;
  clientOperationId: string;
  recordedOffline: boolean;
  syncStatus: string;
  /** ¿Este movimiento altera el resultado (ingreso/gasto) o es sólo caja? */
  affectsProfitAndLoss: boolean;
  isCashMovement: boolean;
  duplicate?: boolean;
}

/**
 * MOVIMIENTOS FINANCIEROS
 * -----------------------
 * Punto ÚNICO por el que entran ingresos, gastos, retiros, aportes, ajustes y
 * liquidaciones. Cada movimiento:
 *   1. se valida (importe, fecha, cuenta, categoría coherente),
 *   2. genera un asiento de partida doble,
 *   3. se guarda con su `clientOperationId` (idempotencia),
 *   4. deja rastro de auditoría.
 *
 * Un movimiento POSTED nunca se modifica ni se borra: se ANULA (con reverso del
 * asiento y motivo obligatorio).
 */
@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async create(
    user: AuthenticatedUser,
    input: CreateTransactionDto,
    meta: RequestMetaInfo,
  ): Promise<TransactionResult> {
    // --- Idempotencia -----------------------------------------------------
    if (input.clientOperationId) {
      const existing = await this.prisma.financialTransaction.findUnique({
        where: { clientOperationId: input.clientOperationId },
      });
      if (existing) {
        const sameContent =
          existing.entityId === input.entityId &&
          existing.kind === input.kind &&
          existing.accountId === input.accountId &&
          eq(existing.amount, input.amount) &&
          existing.description === input.description;

        if (!sameContent) {
          throw new IdempotencyConflictError(input.clientOperationId, {
            existingId: existing.id,
          });
        }
        return this.toResult(existing, true);
      }
    }

    await this.access.assertCanWrite(user.userId, input.entityId);

    const account = await this.prisma.financialAccount.findUnique({
      where: { id: input.accountId },
      include: { ledgerAccount: { select: { code: true, name: true } } },
    });
    if (!account) {
      throw new NotFoundError('Cuenta financiera', input.accountId);
    }
    if (account.entityId !== input.entityId) {
      throw new ValidationError('La cuenta seleccionada no pertenece a esta unidad financiera');
    }
    if (account.status === 'CLOSED') {
      throw new ConflictError(`La cuenta "${account.name}" está cerrada y no admite movimientos`);
    }

    const amount = validateMoney(input.amount, { field: 'importe' });
    const businessDate = toBusinessDate(input.businessDate);

    // --- Categoría --------------------------------------------------------
    let categoryLedgerCode: string | null = null;
    if (input.categoryId) {
      const category = await this.prisma.transactionCategory.findUnique({
        where: { id: input.categoryId },
        select: { id: true, name: true, kind: true, defaultLedgerCode: true, entityId: true, isActive: true },
      });
      if (!category) {
        throw new NotFoundError('Categoría', input.categoryId);
      }
      if (category.entityId && category.entityId !== input.entityId) {
        throw new ValidationError('La categoría no pertenece a esta unidad financiera');
      }
      if (!category.isActive) {
        throw new ConflictError(`La categoría "${category.name}" está desactivada`);
      }

      const expectedKind = this.expectedCategoryKind(input.kind);
      if (expectedKind && category.kind !== expectedKind) {
        throw new ValidationError(
          `La categoría "${category.name}" es de ${category.kind === 'INCOME' ? 'ingresos' : 'gastos'} ` +
            `y no se puede usar en un movimiento de tipo ${input.kind}`,
        );
      }
      categoryLedgerCode = category.defaultLedgerCode;
    }

    this.assertKindRequirements(input);

    const lines = buildPostingLines({
      kind: input.kind,
      amount,
      financialLedgerCode: account.ledgerAccount.code,
      categoryLedgerCode,
      counterpartyLedgerCode: await this.resolveCounterpartyLedger(input, account.isCreditCard),
      adjustmentDebitCode: input.adjustmentDebitCode,
      adjustmentCreditCode: input.adjustmentCreditCode,
      financialAccountId: account.id,
      memo: input.description,
    }).map((line) =>
      // Cualquier línea que toque la cuenta contable de esta cuenta financiera
      // queda vinculada a la cuenta: así el saldo calculado siempre la incluye
      // (importante en los ajustes manuales por diferencia de caja).
      line.financialAccountId || line.ledgerCode !== account.ledgerAccount.code
        ? line
        : { ...line, financialAccountId: account.id },
    );

    const clientOperationId =
      input.clientOperationId ?? `srv_${hashToken(stableStringify({ t: Date.now(), r: Math.random() })).slice(0, 40)}`;

    // Sin forma de pago explícita se deduce de la cuenta: un gasto pagado desde
    // el banco es una transferencia, no efectivo. Antes quedaba «EFECTIVO» por
    // defecto y el cierre del día no cuadraba con el banco.
    const method =
      input.method ??
      (input.kind === 'INCOME' || input.kind === 'EXPENSE' ? defaultPaymentMethod(account.type) : null);

    const created = await this.prisma.inMoneyTransaction(async (tx) => {
      const entry = await postEntry(tx, {
        entityId: input.entityId,
        businessDate,
        description: input.description.trim(),
        sourceType: 'TRANSACTION',
        lines: lines as JournalLineInput[],
        createdByUserId: user.userId,
      });

      const transaction = await tx.financialTransaction.create({
        data: {
          entityId: input.entityId,
          kind: input.kind,
          status: 'POSTED',
          accountId: account.id,
          categoryId: input.categoryId ?? null,
          counterpartyId: input.counterpartyId ?? null,
          receivableId: input.receivableId ?? null,
          payableId: input.payableId ?? null,
          loanId: input.loanId ?? null,
          attachmentId: input.attachmentId ?? null,
          journalEntryId: entry.id,
          amount,
          currency: account.currency,
          businessDate,
          occurredAt: new Date(),
          description: input.description.trim(),
          reference: input.reference ?? null,
          method,
          clientOperationId,
          deviceId: input.deviceId ?? meta.deviceId ?? null,
          recordedOffline: input.recordedOffline ?? false,
          syncStatus: 'CONFIRMED',
          syncedAt: new Date(),
          createdByUserId: user.userId,
        },
      });

      // Efectos sobre cuentas por cobrar / pagar.
      if (input.receivableId) {
        await this.recomputeReceivable(tx, input.receivableId);
      }
      if (input.payableId) {
        await this.recomputePayable(tx, input.payableId);
      }

      await this.audit.record(
        {
          userId: user.userId,
          actorType: input.recordedOffline ? 'SYNC' : 'USER',
          action: 'transaction.created',
          entityType: 'FinancialTransaction',
          entityId: transaction.id,
          businessId: entry.id,
          after: {
            kind: transaction.kind,
            amount: transaction.amount.toFixed(2),
            accountId: transaction.accountId,
            entityId: transaction.entityId,
            businessDate: businessDate.toISOString().slice(0, 10),
            journalEntryId: entry.id,
            recordedOffline: transaction.recordedOffline,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return transaction;
    });

    return this.toResult(created);
  }

  async list(user: AuthenticatedUser, query: ListTransactionsQuery) {
    const entityIds = await this.access.resolveScope(user.userId, query.entityId);

    const kinds = query.kinds
      ? (query.kinds.split(',').map((kind) => kind.trim()).filter(Boolean) as TxnKind[])
      : undefined;

    const where: Prisma.FinancialTransactionWhereInput = {
      entityId: { in: entityIds },
      kind: kinds && kinds.length > 0 ? { in: kinds } : undefined,
      accountId: query.accountId,
      categoryId: query.categoryId,
      counterpartyId: query.counterpartyId,
      status: (query.status as 'POSTED' | 'VOIDED' | undefined) ?? 'POSTED',
      businessDate:
        query.from || query.to
          ? {
              gte: query.from ? toBusinessDate(query.from) : undefined,
              lte: query.to ? toBusinessDate(query.to) : undefined,
            }
          : undefined,
      amount:
        query.minAmount || query.maxAmount
          ? {
              gte: query.minAmount ? validateMoney(query.minAmount, { field: 'importe mínimo', allowZero: true }) : undefined,
              lte: query.maxAmount ? validateMoney(query.maxAmount, { field: 'importe máximo', allowZero: true }) : undefined,
            }
          : undefined,
      OR: query.search
        ? [
            { description: { contains: query.search, mode: 'insensitive' } },
            { reference: { contains: query.search, mode: 'insensitive' } },
          ]
        : undefined,
    };

    const { skip, take, page, limit } = {
      skip: ((query.page ?? 1) - 1) * (query.limit ?? 50),
      take: Math.min(200, query.limit ?? 50),
      page: query.page ?? 1,
      limit: query.limit ?? 50,
    };

    const [rows, total] = await Promise.all([
      this.prisma.financialTransaction.findMany({
        where,
        orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
        skip,
        take,
        include: {
          account: { select: { id: true, name: true, type: true, isCreditCard: true } },
          category: { select: { id: true, name: true, kind: true } },
          counterparty: { select: { id: true, name: true } },
          entity: { select: { id: true, code: true, name: true } },
          transfer: { select: { id: true, fromAccountId: true, toAccountId: true } },
          loan: { select: { id: true, name: true, direction: true } },
          // LA FIRMA: quién registró el movimiento. Es lo que permite saber, en
          // una cuenta compartida, de quién fue cada gasto.
          createdBy: { select: { id: true, name: true, email: true } },
        },
      }),
      this.prisma.financialTransaction.count({ where }),
    ]);

    return {
      data: rows.map((row) => this.present(row)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit), hasNext: page * limit < total },
    };
  }

  async get(user: AuthenticatedUser, transactionId: string) {
    const transaction = await this.prisma.financialTransaction.findUnique({
      where: { id: transactionId },
      include: {
        account: { select: { id: true, name: true, type: true } },
        category: { select: { id: true, name: true, kind: true } },
        counterparty: { select: { id: true, name: true } },
        entity: { select: { id: true, code: true, name: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        journalEntry: {
          include: {
            lines: {
              include: {
                ledgerAccount: { select: { code: true, name: true } },
                financialAccount: { select: { name: true } },
              },
            },
          },
        },
        attachment: true,
      },
    });

    if (!transaction) {
      throw new NotFoundError('Movimiento', transactionId);
    }
    await this.access.assertCanRead(user.userId, transaction.entityId);
    return this.present(transaction);
  }

  /**
   * ANULACIÓN de un movimiento confirmado.
   * No se edita ni se borra: se revierte su asiento contable y el movimiento
   * queda marcado como VOIDED con el motivo. Es la única corrección admitida.
   */
  async void(user: AuthenticatedUser, transactionId: string, reason: string, meta: RequestMetaInfo) {
    const transaction = await this.prisma.financialTransaction.findUnique({
      where: { id: transactionId },
      select: {
        id: true,
        entityId: true,
        status: true,
        description: true,
        amount: true,
        journalEntryId: true,
        receivableId: true,
        payableId: true,
        kind: true,
      },
    });

    if (!transaction) {
      throw new NotFoundError('Movimiento', transactionId);
    }
    await this.access.assertCanWrite(user.userId, transaction.entityId);

    if (transaction.status !== 'POSTED') {
      throw new ConflictError(`Este movimiento ya está en estado ${transaction.status} y no se puede anular`);
    }
    if (!reason || reason.trim().length < 5) {
      throw new ValidationError('El motivo de anulación debe explicar qué pasó (mínimo 5 caracteres)');
    }

    const result = await this.prisma.inMoneyTransaction(async (tx) => {
      if (transaction.journalEntryId) {
        await reverseEntry(tx, {
          entryId: transaction.journalEntryId,
          reason: reason.trim(),
          businessDate: toBusinessDate(),
          createdByUserId: user.userId,
        });
      }

      const updated = await tx.financialTransaction.update({
        where: { id: transactionId },
        data: {
          status: 'VOIDED',
          voidedAt: new Date(),
          voidReason: reason.trim(),
        },
      });

      if (transaction.receivableId) {
        await this.recomputeReceivable(tx, transaction.receivableId);
      }
      if (transaction.payableId) {
        await this.recomputePayable(tx, transaction.payableId);
      }

      await this.audit.record(
        {
          userId: user.userId,
          action: 'transaction.voided',
          entityType: 'FinancialTransaction',
          entityId: transactionId,
          businessId: transaction.journalEntryId,
          before: { status: 'POSTED', description: transaction.description },
          after: { status: 'VOIDED', reason: reason.trim() },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return updated;
    });

    return this.toResult(result, false);
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  private expectedCategoryKind(kind: TxnKind): 'INCOME' | 'EXPENSE' | null {
    switch (kind) {
      case 'INCOME':
        return 'INCOME';
      case 'EXPENSE':
        return 'EXPENSE';
      default:
        return null;
    }
  }

  private assertKindRequirements(input: CreateTransactionDto): void {
    if (input.kind === 'RECEIVABLE_SETTLEMENT' && !input.receivableId) {
      throw new ValidationError('Para cobrar una cuenta por cobrar debe indicar cuál (receivableId)');
    }
    if (input.kind === 'PAYABLE_SETTLEMENT' && !input.payableId) {
      throw new ValidationError('Para pagar una cuenta por pagar debe indicar cuál (payableId)');
    }
    if (input.kind === 'LOAN_DISBURSEMENT' && !input.loanId) {
      throw new ValidationError('Un desembolso de préstamo debe indicar el préstamo (loanId)');
    }
    if (input.kind === 'ADJUSTMENT') {
      if (!input.adjustmentDebitCode || !input.adjustmentCreditCode) {
        throw new ValidationError(
          'Un ajuste exige indicar la cuenta que se carga y la que se abona (no se ajustan saldos "a ojo")',
        );
      }
      if (!input.adjustmentReason || input.adjustmentReason.trim().length < 5) {
        throw new ValidationError('Un ajuste exige un motivo registrado (mínimo 5 caracteres)');
      }
      if (input.adjustmentDebitCode === input.adjustmentCreditCode) {
        throw new ValidationError('La cuenta que se carga y la que se abona deben ser distintas');
      }
    }
  }

  private async resolveCounterpartyLedger(
    input: CreateTransactionDto,
    isCreditCard: boolean,
  ): Promise<string | null> {
    if (input.kind === 'RECEIVABLE_SETTLEMENT' && input.receivableId) {
      const receivable = await this.prisma.receivable.findUnique({
        where: { id: input.receivableId },
        select: { id: true, entityId: true, originalAmount: true, settledAmount: true, currency: true },
      });
      if (!receivable) {
        throw new NotFoundError('Cuenta por cobrar', input.receivableId);
      }
      if (receivable.entityId !== input.entityId) {
        throw new ValidationError('La cuenta por cobrar pertenece a otra unidad financiera');
      }
      return '1210';
    }
    if (input.kind === 'PAYABLE_SETTLEMENT') {
      return '2100';
    }
    if (input.kind === 'CREDIT_CARD_PAYMENT') {
      return '2210';
    }
    return null;
  }

  /** Recalcula el saldo pendiente de una cuenta por cobrar desde sus cobros. */
  private async recomputeReceivable(tx: Tx, receivableId: string): Promise<void> {
    const receivable = await tx.receivable.findUnique({
      where: { id: receivableId },
      select: { id: true, originalAmount: true, issueDate: true, dueDate: true },
    });
    if (!receivable) {
      return;
    }

    const settlements = await tx.financialTransaction.findMany({
      where: { receivableId, status: 'POSTED', kind: 'RECEIVABLE_SETTLEMENT' },
      select: { amount: true },
    });

    const settled = min(sum(settlements.map((row) => row.amount)), dec(receivable.originalAmount));
    const status =
      settled.isZero() ? 'PENDING' : eq(settled, receivable.originalAmount) ? 'SETTLED' : 'PARTIAL';

    await tx.receivable.update({
      where: { id: receivableId },
      data: { settledAmount: round2(settled), status },
    });
  }

  private async recomputePayable(tx: Tx, payableId: string): Promise<void> {
    const payable = await tx.payable.findUnique({
      where: { id: payableId },
      select: { id: true, originalAmount: true },
    });
    if (!payable) {
      return;
    }

    const settlements = await tx.financialTransaction.findMany({
      where: { payableId, status: 'POSTED', kind: 'PAYABLE_SETTLEMENT' },
      select: { amount: true },
    });

    const settled = min(sum(settlements.map((row) => row.amount)), dec(payable.originalAmount));
    const status = settled.isZero() ? 'PENDING' : eq(settled, payable.originalAmount) ? 'SETTLED' : 'PARTIAL';

    await tx.payable.update({
      where: { id: payableId },
      data: { settledAmount: round2(settled), status },
    });
  }

  private toResult(
    transaction: {
      id: string;
      kind: TxnKind;
      status: string;
      amount: DecimalInput;
      currency: string;
      businessDate: Date;
      description: string;
      accountId: string;
      categoryId: string | null;
      journalEntryId: string | null;
      clientOperationId: string;
      recordedOffline: boolean;
      syncStatus: string;
    },
    duplicate = false,
  ): TransactionResult {
    return {
      id: transaction.id,
      kind: transaction.kind,
      status: transaction.status,
      amount: dec(transaction.amount).toFixed(2),
      currency: transaction.currency,
      businessDate: transaction.businessDate,
      description: transaction.description,
      accountId: transaction.accountId,
      categoryId: transaction.categoryId,
      journalEntryId: transaction.journalEntryId,
      clientOperationId: transaction.clientOperationId,
      recordedOffline: transaction.recordedOffline,
      syncStatus: transaction.syncStatus,
      /** Deja claro si el movimiento altera el resultado (ingreso/gasto) o no. */
      affectsProfitAndLoss: transaction.kind === 'INCOME' || transaction.kind === 'EXPENSE',
      isCashMovement: true,
      ...(duplicate ? { duplicate: true } : {}),
    };
  }

  private present(row: {
    id: string;
    kind: TxnKind;
    status: string;
    amount: DecimalInput;
    currency: string;
    businessDate: Date;
    occurredAt: Date;
    description: string;
    reference: string | null;
    method: string | null;
    accountId: string;
    categoryId: string | null;
    counterpartyId: string | null;
    journalEntryId: string | null;
    clientOperationId: string;
    recordedOffline: boolean;
    syncStatus: string;
    voidedAt?: Date | null;
    voidReason?: string | null;
    account?: unknown;
    category?: unknown;
    counterparty?: unknown;
    entity?: unknown;
    transfer?: unknown;
    loan?: unknown;
    journalEntry?: unknown;
    attachment?: unknown;
  }) {
    return {
      ...row,
      amount: dec(row.amount).toFixed(2),
      /** Marca de resultado: los movimientos que NO son ingreso/gasto no alteran la ganancia. */
      affectsProfitAndLoss: row.kind === 'INCOME' || row.kind === 'EXPENSE',
      isCashMovement: true,
    };
  }
}
