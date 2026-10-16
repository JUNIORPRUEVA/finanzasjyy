import { Injectable } from '@nestjs/common';
import type { PaymentFrequency } from '../generated/prisma/enums.js';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import { LEDGER } from '../domain/chart-of-accounts.js';
import { toBusinessDate, businessToday, addBusinessDays } from '../domain/business-date.js';
import { dec, eq, round2, validateMoney, type DecimalInput } from '../domain/money.js';
import {
  allocatePayment,
  buildSchedule,
  nextDueDate,
  today,
} from '../domain/amortization.js';
import { postEntry, type Tx } from '../ledger/ledger-core.js';
import { hashToken, stableStringify } from '../auth/tokens.js';
import type { CreateLoanDto, ListLoansQuery, RegisterLoanPaymentDto } from './loans.dto.js';

/**
 * PRÉSTAMOS Y DEUDAS
 * ------------------
 * Distingue con claridad:
 *  · direction = PAYABLE   → FINANZA DEBE (préstamo recibido, tarjeta, etc.)
 *  · direction = RECEIVABLE → A FINANZA LE DEBEN (préstamo otorgado)
 *
 * Un préstamo recibido NUNCA es un ingreso: entra dinero (activo) y sube la
 * deuda (pasivo). Un pago separa CAPITAL de INTERESES, porque el capital baja
 * la deuda y los intereses son gasto del período.
 */
@Injectable()
export class LoansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async create(user: AuthenticatedUser, input: CreateLoanDto, meta: RequestMetaInfo) {
    await this.access.assertCanWrite(user.userId, input.entityId);

    const principal = validateMoney(input.principalAmount, { field: 'capital del préstamo' });
    const startDate = toBusinessDate(input.startDate);
    const firstDueDate = input.firstDueDate ? toBusinessDate(input.firstDueDate) : null;
    const frequency = (input.paymentFrequency ?? 'MONTHLY') as PaymentFrequency;
    const interestType = input.interestType ?? 'NONE';

    if (interestType !== 'NONE' && !input.annualRatePct) {
      throw new ValidationError(
        'Indicó un tipo de interés pero no la tasa anual. FINANZA no inventa la tasa: complétela o registre el préstamo sin intereses.',
      );
    }

    const annualRatePct = input.annualRatePct ? round2(input.annualRatePct) : null;
    const installmentAmount = input.installmentAmount
      ? validateMoney(input.installmentAmount, { field: 'cuota' })
      : firstDueDate && input.installmentCount
        ? null
        : null;

    const account = input.accountId
      ? await this.prisma.financialAccount.findUnique({
          where: { id: input.accountId },
          include: { ledgerAccount: { select: { code: true } } },
        })
      : null;

    if (input.accountId && !account) {
      throw new NotFoundError('Cuenta financiera', input.accountId);
    }
    if (account && account.entityId !== input.entityId) {
      throw new ValidationError('La cuenta indicada pertenece a otra unidad financiera');
    }

    const currentBalance = principal;
    const nextDue = firstDueDate ?? (input.installmentCount ? nextDueDate(startDate, frequency) : null);

    const clientOperationId =
      input.clientOperationId ?? `loan_${hashToken(stableStringify({ t: Date.now(), r: Math.random() })).slice(0, 40)}`;

    return this.prisma.inMoneyTransaction(async (tx) => {
      const loan = await tx.loan.create({
        data: {
          entityId: input.entityId,
          direction: input.direction,
          counterpartyId: input.counterpartyId ?? null,
          name: input.name.trim(),
          principalAmount: principal,
          currentBalance,
          currency: account?.currency ?? 'DOP',
          annualRatePct,
          interestType,
          paymentFrequency: frequency,
          installmentAmount,
          installmentCount: input.installmentCount ?? null,
          startDate,
          firstDueDate,
          nextDueDate: nextDue,
          accountId: account?.id ?? null,
          status: 'ACTIVE',
          notes: input.notes ?? null,
        },
      });

      // Desembolso: sólo si se indicó la cuenta donde se movió el dinero.
      if (account) {
        const debtCode = input.direction === 'PAYABLE' ? LEDGER.LOAN_PAYABLE : LEDGER.LOAN_GIVEN;
        const lines =
          input.direction === 'PAYABLE'
            ? [
                {
                  ledgerCode: account.ledgerAccount.code,
                  financialAccountId: account.id,
                  debit: principal,
                  memo: `Desembolso del préstamo ${loan.name}`,
                },
                { ledgerCode: debtCode, credit: principal, memo: `Deuda por ${loan.name}` },
              ]
            : [
                { ledgerCode: debtCode, debit: principal, memo: `Préstamo otorgado: ${loan.name}` },
                {
                  ledgerCode: account.ledgerAccount.code,
                  financialAccountId: account.id,
                  credit: principal,
                  memo: `Salida de fondos por ${loan.name}`,
                },
              ];

        const entry = await postEntry(tx, {
          entityId: input.entityId,
          businessDate: startDate,
          description:
            input.direction === 'PAYABLE'
              ? `Préstamo recibido: ${loan.name}`
              : `Préstamo otorgado: ${loan.name}`,
          sourceType: 'LOAN',
          sourceId: loan.id,
          lines,
          createdByUserId: user.userId,
        });

        await tx.financialTransaction.create({
          data: {
            entityId: input.entityId,
            kind: 'LOAN_DISBURSEMENT',
            status: 'POSTED',
            accountId: account.id,
            loanId: loan.id,
            journalEntryId: entry.id,
            amount: principal,
            currency: account.currency,
            businessDate: startDate,
            description:
              input.direction === 'PAYABLE'
                ? `Desembolso de préstamo recibido: ${loan.name}`
                : `Desembolso de préstamo otorgado: ${loan.name}`,
            clientOperationId,
            syncStatus: 'CONFIRMED',
            syncedAt: new Date(),
            createdByUserId: user.userId,
          },
        });
      }

      await this.audit.record(
        {
          userId: user.userId,
          action: 'loan.created',
          entityType: 'Loan',
          entityId: loan.id,
          after: {
            direction: loan.direction,
            principal: principal.toFixed(2),
            annualRatePct: annualRatePct?.toFixed(4) ?? null,
            interestType,
            paymentFrequency: frequency,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return this.presentLoan(loan);
    });
  }

  /**
   * Registra un pago. Separa CAPITAL, INTERESES, COMISIONES y MORA; sólo el
   * capital reduce la deuda y sólo los intereses/comisiones son gasto.
   */
  async registerPayment(
    user: AuthenticatedUser,
    loanId: string,
    input: RegisterLoanPaymentDto,
    meta: RequestMetaInfo,
  ) {
    const loan = await this.prisma.loan.findUnique({
      where: { id: loanId },
      include: { counterparty: { select: { id: true, name: true } } },
    });
    if (!loan) {
      throw new NotFoundError('Préstamo', loanId);
    }
    await this.access.assertCanWrite(user.userId, loan.entityId);

    if (loan.status === 'CANCELLED') {
      throw new ConflictError('El préstamo está cancelado');
    }
    if (dec(loan.currentBalance).isZero()) {
      throw new ConflictError('Este préstamo ya está saldado: no admite más pagos');
    }

    if (input.clientOperationId) {
      const existing = await this.prisma.loanPayment.findUnique({
        where: { clientOperationId: input.clientOperationId },
      });
      if (existing) {
        return { duplicate: true, paymentId: existing.id };
      }
    }

    const account = await this.prisma.financialAccount.findUnique({
      where: { id: input.accountId },
      include: { ledgerAccount: { select: { code: true } } },
    });
    if (!account) {
      throw new NotFoundError('Cuenta financiera', input.accountId);
    }
    if (account.entityId !== loan.entityId) {
      throw new ValidationError('La cuenta del pago pertenece a otra unidad financiera');
    }

    const total = validateMoney(input.totalAmount, { field: 'importe del pago' });
    const businessDate = toBusinessDate(input.businessDate);

    const lastPayment = await this.prisma.loanPayment.findFirst({
      where: { loanId },
      orderBy: { businessDate: 'desc' },
      select: { businessDate: true },
    });

    const allocation = allocatePayment({
      currentBalance: loan.currentBalance,
      totalAmount: total,
      annualRatePct: loan.annualRatePct,
      interestFromDate: lastPayment?.businessDate ?? loan.startDate,
      paymentDate: businessDate,
      explicitPrincipal: input.principalAmount,
      explicitInterest: input.interestAmount,
      feeAmount: input.feeAmount,
      penaltyAmount: input.penaltyAmount,
    });

    // Un pago NO puede superar lo que se debe: el exceso no se aplica en
    // silencio (sería dinero sin identificar). Es preferible rechazarlo y que
    // el usuario decida qué es ese dinero.
    const maxApplicable = round2(
      dec(loan.currentBalance)
        .plus(allocation.interest)
        .plus(allocation.fees)
        .plus(allocation.penalties),
    );
    if (dec(total).greaterThan(maxApplicable)) {
      throw new ValidationError(
        `El pago (${total.toFixed(2)}) supera lo que queda por pagar (${maxApplicable.toFixed(2)}: ` +
          `capital ${dec(loan.currentBalance).toFixed(2)} + intereses ${allocation.interest.toFixed(2)} + ` +
          `comisiones ${allocation.fees.toFixed(2)} + mora ${allocation.penalties.toFixed(2)}). ` +
          'Registre sólo el importe que cancela la deuda; el exceso, si existe, se registra como otro concepto.',
      );
    }

    const newBalance = round2(dec(loan.currentBalance).minus(allocation.principal));
    if (newBalance.isNegative()) {
      throw new ValidationError(
        `El capital aplicado (${allocation.principal.toFixed(2)}) supera el saldo pendiente (${dec(
          loan.currentBalance,
        ).toFixed(2)})`,
      );
    }

    const clientOperationId =
      input.clientOperationId ?? `pay_${hashToken(stableStringify({ t: Date.now(), r: Math.random() })).slice(0, 40)}`;

    const result = await this.prisma.inMoneyTransaction(async (tx) => {
      const isPayable = loan.direction === 'PAYABLE';
      const principalLedger = isPayable ? LEDGER.LOAN_PAYABLE : LEDGER.LOAN_GIVEN;

      // Un solo asiento con varias líneas: capital e intereses separados.
      const lines = isPayable
        ? [
            ...(allocation.principal.isZero()
              ? []
              : [{ ledgerCode: principalLedger, debit: allocation.principal, memo: 'Abono a capital' }]),
            ...(allocation.interest.isZero()
              ? []
              : [{ ledgerCode: LEDGER.INTEREST_EXPENSE, debit: allocation.interest, memo: 'Intereses' }]),
            ...(allocation.fees.isZero()
              ? []
              : [{ ledgerCode: LEDGER.BANK_FEES, debit: allocation.fees, memo: 'Comisiones' }]),
            ...(allocation.penalties.isZero()
              ? []
              : [{ ledgerCode: LEDGER.PENALTIES, debit: allocation.penalties, memo: 'Mora' }]),
            {
              ledgerCode: account.ledgerAccount.code,
              financialAccountId: account.id,
              credit: total,
              memo: `Pago de ${loan.name}`,
            },
          ]
        : [
            {
              ledgerCode: account.ledgerAccount.code,
              financialAccountId: account.id,
              debit: total,
              memo: `Cobro de ${loan.name}`,
            },
            ...(allocation.principal.isZero()
              ? []
              : [{ ledgerCode: principalLedger, credit: allocation.principal, memo: 'Abono a capital' }]),
            ...(allocation.interest.isZero()
              ? []
              : [{ ledgerCode: LEDGER.INTEREST_INCOME, credit: allocation.interest, memo: 'Intereses ganados' }]),
          ];

      const entry = await postEntry(tx, {
        entityId: loan.entityId,
        businessDate,
        description: `${isPayable ? 'Pago' : 'Cobro'} de ${loan.name}`,
        sourceType: 'LOAN_PAYMENT',
        sourceId: loan.id,
        lines,
        createdByUserId: user.userId,
      });

      const payment = await tx.loanPayment.create({
        data: {
          loanId: loan.id,
          businessDate,
          totalAmount: total,
          principalAmount: allocation.principal,
          interestAmount: allocation.interest,
          feeAmount: allocation.fees,
          penaltyAmount: allocation.penalties,
          accountId: account.id,
          notes: input.notes ?? null,
          clientOperationId,
          createdByUserId: user.userId,
        },
      });

      await tx.financialTransaction.create({
        data: {
          entityId: loan.entityId,
          kind: 'LOAN_PAYMENT',
          status: 'POSTED',
          accountId: account.id,
          loanId: loan.id,
          loanPaymentId: payment.id,
          journalEntryId: entry.id,
          amount: total,
          currency: account.currency,
          businessDate,
          description: `${isPayable ? 'Pago' : 'Cobro'} de ${loan.name} (capital ${allocation.principal.toFixed(2)} / intereses ${allocation.interest.toFixed(2)})`,
          clientOperationId: `${clientOperationId}:txn`,
          syncStatus: 'CONFIRMED',
          syncedAt: new Date(),
          createdByUserId: user.userId,
        },
      });

      const paidOff = newBalance.isZero();
      const updatedLoan = await tx.loan.update({
        where: { id: loan.id },
        data: {
          currentBalance: newBalance,
          status: paidOff ? 'PAID_OFF' : loan.status,
          closedAt: paidOff ? new Date() : null,
          nextDueDate: paidOff ? null : nextDueDate(businessDate, loan.paymentFrequency),
        },
      });

      await this.audit.record(
        {
          userId: user.userId,
          action: 'loan.payment.registered',
          entityType: 'LoanPayment',
          entityId: payment.id,
          businessId: entry.id,
          after: {
            total: total.toFixed(2),
            principal: allocation.principal.toFixed(2),
            interest: allocation.interest.toFixed(2),
            fees: allocation.fees.toFixed(2),
            penalties: allocation.penalties.toFixed(2),
            newBalance: newBalance.toFixed(2),
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return { payment, loan: updatedLoan, entryId: entry.id };
    });

    return {
      paymentId: result.payment.id,
      journalEntryId: result.entryId,
      allocation: {
        total: allocation.total.toFixed(2),
        principal: allocation.principal.toFixed(2),
        interest: allocation.interest.toFixed(2),
        fees: allocation.fees.toFixed(2),
        penalties: allocation.penalties.toFixed(2),
      },
      currentBalance: dec(result.loan.currentBalance).toFixed(2),
      status: result.loan.status,
      warnings: allocation.warnings,
    };
  }

  /** Cuadro de amortización proyectado (informativo, NO modifica nada). */
  async schedule(user: AuthenticatedUser, loanId: string) {
    const loan = await this.prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) {
      throw new NotFoundError('Préstamo', loanId);
    }
    await this.access.assertCanRead(user.userId, loan.entityId);

    const count = loan.installmentCount ?? 12;
    const firstDue = loan.firstDueDate ?? loan.startDate;

    const rows = buildSchedule({
      principal: loan.currentBalance,
      annualRatePct: loan.annualRatePct,
      installmentAmount: loan.installmentAmount,
      installmentCount: count,
      frequency: loan.paymentFrequency,
      firstDueDate: firstDue,
      interestType: loan.interestType,
    });

    return {
      loanId: loan.id,
      direction: loan.direction,
      currentBalance: dec(loan.currentBalance).toFixed(2),
      annualRatePct: loan.annualRatePct ? dec(loan.annualRatePct).toFixed(4) : null,
      interestType: loan.interestType,
      disclaimer:
        'Cuadro informativo calculado con las condiciones registradas. No genera movimientos ni modifica el saldo.',
      rows: rows.map((row) => ({
        period: row.period,
        dueDate: row.dueDate,
        payment: row.payment.toFixed(2),
        interest: row.interest.toFixed(2),
        principal: row.principal.toFixed(2),
        balance: row.balance.toFixed(2),
      })),
      totals: {
        interest: rows.reduce((acc, row) => acc.plus(row.interest), dec(0)).toFixed(2),
        principal: rows.reduce((acc, row) => acc.plus(row.principal), dec(0)).toFixed(2),
        payments: rows.reduce((acc, row) => acc.plus(row.payment), dec(0)).toFixed(2),
      },
    };
  }

  async list(user: AuthenticatedUser, query: ListLoansQuery) {
    const entityIds = await this.access.resolveScope(user.userId, query.entityId);
    const limit = Math.min(200, query.limit ?? 50);
    const page = query.page ?? 1;

    const dueLimit = query.dueWithinDays ? addBusinessDays(businessToday(), Number(query.dueWithinDays)) : null;

    const loans = await this.prisma.loan.findMany({
      where: {
        entityId: { in: entityIds },
        direction: query.direction,
        status: query.status,
        nextDueDate: dueLimit ? { lte: dueLimit } : undefined,
      },
      orderBy: [{ status: 'asc' }, { nextDueDate: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        counterparty: { select: { id: true, name: true, type: true } },
        entity: { select: { id: true, code: true, name: true } },
        _count: { select: { payments: true } },
      },
    });

    const total = await this.prisma.loan.count({
      where: {
        entityId: { in: entityIds },
        direction: query.direction,
        status: query.status,
        nextDueDate: dueLimit ? { lte: dueLimit } : undefined,
      },
    });

    const todayRef = today();
    return {
      data: loans.map((loan) => ({
        ...this.presentLoan(loan),
        daysToDue: loan.nextDueDate
          ? Math.round((loan.nextDueDate.getTime() - todayRef.getTime()) / 86_400_000)
          : null,
        isOverdue: loan.nextDueDate ? loan.nextDueDate.getTime() < todayRef.getTime() && loan.status === 'ACTIVE' : false,
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit), hasNext: page * limit < total },
    };
  }

  async get(user: AuthenticatedUser, loanId: string) {
    const loan = await this.prisma.loan.findUnique({
      where: { id: loanId },
      include: {
        counterparty: { select: { id: true, name: true } },
        entity: { select: { id: true, code: true, name: true } },
        payments: { orderBy: { businessDate: 'desc' }, take: 100 },
      },
    });
    if (!loan) {
      throw new NotFoundError('Préstamo', loanId);
    }
    await this.access.assertCanRead(user.userId, loan.entityId);

    const paidPrincipal = loan.payments.reduce((acc, payment) => acc.plus(payment.principalAmount), dec(0));
    const paidInterest = loan.payments.reduce((acc, payment) => acc.plus(payment.interestAmount), dec(0));

    return {
      ...this.presentLoan(loan),
      counterparty: loan.counterparty,
      entity: loan.entity,
      progress: {
        paidPrincipal: paidPrincipal.toFixed(2),
        paidInterest: paidInterest.toFixed(2),
        remaining: dec(loan.currentBalance).toFixed(2),
        percentPaid: dec(loan.principalAmount).isZero()
          ? '0.00'
          : paidPrincipal.dividedBy(dec(loan.principalAmount)).times(100).toFixed(2),
      },
      payments: loan.payments.map((payment) => ({
        id: payment.id,
        businessDate: payment.businessDate,
        totalAmount: payment.totalAmount.toFixed(2),
        principalAmount: payment.principalAmount.toFixed(2),
        interestAmount: payment.interestAmount.toFixed(2),
        feeAmount: payment.feeAmount.toFixed(2),
        penaltyAmount: payment.penaltyAmount.toFixed(2),
        notes: payment.notes,
      })),
    };
  }

  /** Resumen de deuda y por cobrar, con lo que vence en los próximos días. */
  async summary(user: AuthenticatedUser, entityId?: string, dueWithinDays = 30) {
    const entityIds = await this.access.resolveScope(user.userId, entityId);
    const todayRef = today();
    const dueLimit = addBusinessDays(todayRef, dueWithinDays);

    const loans = await this.prisma.loan.findMany({
      where: { entityId: { in: entityIds }, status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        direction: true,
        currentBalance: true,
        nextDueDate: true,
        installmentAmount: true,
        entityId: true,
        annualRatePct: true,
      },
    });

    const payable = loans.filter((loan) => loan.direction === 'PAYABLE');
    const receivable = loans.filter((loan) => loan.direction === 'RECEIVABLE');

    const totalPayable = payable.reduce((acc, loan) => acc.plus(loan.currentBalance), dec(0));
    const totalReceivable = receivable.reduce((acc, loan) => acc.plus(loan.currentBalance), dec(0));

    const overdue = loans.filter(
      (loan) => loan.nextDueDate !== null && loan.nextDueDate.getTime() < todayRef.getTime(),
    );
    const dueSoon = loans.filter(
      (loan) =>
        loan.nextDueDate !== null &&
        loan.nextDueDate.getTime() >= todayRef.getTime() &&
        loan.nextDueDate.getTime() <= dueLimit.getTime(),
    );

    return {
      totalDebt: totalPayable.toFixed(2),
      totalReceivable: totalReceivable.toFixed(2),
      netPosition: totalReceivable.minus(totalPayable).toFixed(2),
      activeLoans: loans.length,
      overdueCount: overdue.length,
      dueSoonCount: dueSoon.length,
      dueSoon: dueSoon.map((loan) => ({
        id: loan.id,
        name: loan.name,
        direction: loan.direction,
        amount: loan.installmentAmount ? loan.installmentAmount.toFixed(2) : loan.currentBalance.toFixed(2),
        dueDate: loan.nextDueDate,
        daysRemaining: loan.nextDueDate
          ? Math.round((loan.nextDueDate.getTime() - todayRef.getTime()) / 86_400_000)
          : null,
      })),
      overdue: overdue.map((loan) => ({
        id: loan.id,
        name: loan.name,
        direction: loan.direction,
        amount: loan.currentBalance.toFixed(2),
        dueDate: loan.nextDueDate,
        daysOverdue: loan.nextDueDate
          ? Math.round((todayRef.getTime() - loan.nextDueDate.getTime()) / 86_400_000)
          : null,
      })),
    };
  }

  private presentLoan(loan: {
    id: string;
    entityId: string;
    direction: string;
    name: string;
    principalAmount: DecimalInput;
    currentBalance: DecimalInput;
    currency: string;
    annualRatePct: DecimalInput | null;
    interestType: string;
    paymentFrequency: string;
    installmentAmount: DecimalInput | null;
    installmentCount: number | null;
    startDate: Date;
    firstDueDate: Date | null;
    nextDueDate: Date | null;
    status: string;
    notes?: string | null;
    counterpartyId?: string | null;
    _count?: { payments: number };
    entity?: unknown;
  }) {
    return {
      id: loan.id,
      entityId: loan.entityId,
      entity: loan.entity,
      direction: loan.direction,
      name: loan.name,
      principalAmount: dec(loan.principalAmount).toFixed(2),
      currentBalance: dec(loan.currentBalance).toFixed(2),
      currency: loan.currency,
      annualRatePct: loan.annualRatePct ? dec(loan.annualRatePct).toFixed(4) : null,
      interestType: loan.interestType,
      paymentFrequency: loan.paymentFrequency,
      installmentAmount: loan.installmentAmount ? dec(loan.installmentAmount).toFixed(2) : null,
      installmentCount: loan.installmentCount,
      startDate: loan.startDate,
      firstDueDate: loan.firstDueDate,
      nextDueDate: loan.nextDueDate,
      status: loan.status,
      notes: loan.notes ?? null,
      counterpartyId: loan.counterpartyId ?? null,
      paymentCount: loan._count?.payments ?? 0,
      /** El capital pendiente es deuda o crédito, nunca ingreso ni gasto. */
      isLiability: loan.direction === 'PAYABLE',
    };
  }
}
