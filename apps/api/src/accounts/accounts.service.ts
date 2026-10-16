import { Injectable } from '@nestjs/common';
import type { AccountType } from '../generated/prisma/enums.js';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import { ACCOUNT_TYPE_LEDGER, LEDGER } from '../domain/chart-of-accounts.js';
import { toBusinessDate } from '../domain/business-date.js';
import { dec, validateMoney, type DecimalInput } from '../domain/money.js';
import { accountBalance, balancesForAccounts } from '../ledger/ledger-core.js';

export interface CreateAccountInput {
  entityId: string;
  name: string;
  type: AccountType;
  currency?: string;
  openingBalance?: string;
  openingDate?: string;
  isCreditCard?: boolean;
  creditLimit?: string;
  statementDay?: number;
  paymentDueDay?: number;
  notes?: string;
}

export interface UpdateAccountInput {
  name?: string;
  type?: AccountType;
  status?: 'ACTIVE' | 'INACTIVE' | 'CLOSED';
  notes?: string;
  creditLimit?: string | null;
  statementDay?: number | null;
  paymentDueDay?: number | null;
  openingBalance?: string;
  openingDate?: string;
}

/**
 * CUENTAS FINANCIERAS
 * -------------------
 * Representan DÓNDE ESTÁ REALMENTE EL DINERO. Reglas:
 *  · El saldo NO se escribe a mano: se calcula (saldo inicial documentado +
 *    movimientos contables). Cualquier ajuste es un movimiento auditable.
 *  · El saldo inicial sólo puede corregirse mientras la cuenta no tenga
 *    movimientos; después, la corrección sería reescribir la historia.
 *  · Una tarjeta de crédito es un PASIVO, nunca dinero disponible.
 */
@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async create(user: AuthenticatedUser, input: CreateAccountInput, meta: RequestMetaInfo) {
    await this.access.assertCanWrite(user.userId, input.entityId);

    const entity = await this.prisma.financialEntity.findUnique({
      where: { id: input.entityId },
      select: { id: true, currency: true, name: true },
    });
    if (!entity) {
      throw new NotFoundError('Unidad financiera', input.entityId);
    }

    const existing = await this.prisma.financialAccount.findFirst({
      where: { entityId: input.entityId, name: input.name.trim() },
    });
    if (existing) {
      throw new ConflictError(`Ya existe una cuenta llamada "${input.name}" en ${entity.name}`);
    }

    const isCreditCard = input.isCreditCard === true || input.type === 'CREDIT_CARD';
    if (isCreditCard && input.type !== 'CREDIT_CARD') {
      throw new ValidationError(
        'Una tarjeta de crédito debe registrarse con tipo CREDIT_CARD: es un pasivo, no efectivo disponible.',
      );
    }

    const ledgerCode = ACCOUNT_TYPE_LEDGER[input.type] ?? LEDGER.CASH;
    const ledgerAccount = await this.prisma.ledgerAccount.findUnique({ where: { code: ledgerCode } });
    if (!ledgerAccount) {
      throw new NotFoundError('Cuenta contable', ledgerCode);
    }

    const openingBalance = validateMoney(input.openingBalance ?? '0', {
      field: 'saldo inicial',
      allowZero: true,
      allowNegative: false,
    });

    const account = await this.prisma.financialAccount.create({
      data: {
        entityId: input.entityId,
        name: input.name.trim(),
        type: input.type,
        currency: (input.currency ?? entity.currency).toUpperCase(),
        openingBalance,
        openingDate: toBusinessDate(input.openingDate),
        ledgerAccountId: ledgerAccount.id,
        isCreditCard,
        creditLimit: input.creditLimit ? validateMoney(input.creditLimit, { field: 'límite de crédito', allowZero: true }) : null,
        statementDay: input.statementDay ?? null,
        paymentDueDay: input.paymentDueDay ?? null,
        notes: input.notes ?? null,
        status: 'ACTIVE',
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'account.created',
      entityType: 'FinancialAccount',
      entityId: account.id,
      after: {
        name: account.name,
        type: account.type,
        entityId: account.entityId,
        openingBalance: account.openingBalance.toFixed(2),
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.present(account, dec(account.openingBalance));
  }

  async list(user: AuthenticatedUser, params: { entityId?: string; includeClosed?: boolean; includeBalances?: boolean }) {
    const entityIds = await this.access.resolveScope(user.userId, params.entityId);

    const accounts = await this.prisma.financialAccount.findMany({
      where: {
        entityId: { in: entityIds },
        status: params.includeClosed ? undefined : { not: 'CLOSED' },
      },
      orderBy: [{ entityId: 'asc' }, { name: 'asc' }],
      include: {
        entity: { select: { id: true, code: true, name: true, currency: true } },
        ledgerAccount: { select: { code: true, name: true, normalBalance: true } },
      },
    });

    if (params.includeBalances === false) {
      return accounts;
    }

    const balances = await balancesForAccounts(this.prisma, {
      financialAccountIds: accounts.map((account) => account.id),
    });

    return accounts.map((account) => this.present(account, dec(balances.get(account.id)?.balance ?? 0), balances.get(account.id)?.movementCount ?? 0));
  }

  async get(user: AuthenticatedUser, accountId: string) {
    const account = await this.prisma.financialAccount.findUnique({
      where: { id: accountId },
      include: {
        entity: { select: { id: true, code: true, name: true, currency: true } },
        ledgerAccount: { select: { code: true, name: true, normalBalance: true } },
      },
    });
    if (!account) {
      throw new NotFoundError('Cuenta financiera', accountId);
    }
    await this.access.assertCanRead(user.userId, account.entityId);

    const balance = await accountBalance(this.prisma, { financialAccountId: accountId });
    return {
      ...this.present(account, dec(balance.balance), balance.movementCount),
      ledger: {
        totalDebit: balance.totalDebit,
        totalCredit: balance.totalCredit,
        ledgerCode: balance.ledgerCode,
      },
    };
  }

  async update(user: AuthenticatedUser, accountId: string, input: UpdateAccountInput, meta: RequestMetaInfo) {
    const existing = await this.prisma.financialAccount.findUnique({ where: { id: accountId } });
    if (!existing) {
      throw new NotFoundError('Cuenta financiera', accountId);
    }
    await this.access.assertCanWrite(user.userId, existing.entityId);

    const movementCount = await this.prisma.financialTransaction.count({ where: { accountId } });

    // Corregir el saldo inicial con movimientos ya registrados reescribiría la
    // historia: se exige un ajuste contable en su lugar.
    if ((input.openingBalance !== undefined || input.openingDate !== undefined) && movementCount > 0) {
      throw new ConflictError(
        `No se puede cambiar el saldo inicial: la cuenta ya tiene ${movementCount} movimientos. ` +
          'Registre un ajuste (movimiento auditado) para corregir el saldo.',
      );
    }

    const openingBalance =
      input.openingBalance !== undefined
        ? validateMoney(input.openingBalance, { field: 'saldo inicial', allowZero: true })
        : undefined;

    const updated = await this.prisma.financialAccount.update({
      where: { id: accountId },
      data: {
        name: input.name?.trim(),
        type: input.type,
        status: input.status,
        notes: input.notes,
        creditLimit:
          input.creditLimit === null
            ? null
            : input.creditLimit !== undefined
              ? validateMoney(input.creditLimit, { field: 'límite de crédito', allowZero: true })
              : undefined,
        statementDay: input.statementDay === null ? null : input.statementDay,
        paymentDueDay: input.paymentDueDay === null ? null : input.paymentDueDay,
        openingBalance,
        openingDate: input.openingDate ? toBusinessDate(input.openingDate) : undefined,
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'account.updated',
      entityType: 'FinancialAccount',
      entityId: accountId,
      before: {
        name: existing.name,
        type: existing.type,
        status: existing.status,
        openingBalance: existing.openingBalance.toFixed(2),
      },
      after: {
        name: updated.name,
        type: updated.type,
        status: updated.status,
        openingBalance: updated.openingBalance.toFixed(2),
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.present(updated, dec(updated.openingBalance));
  }

  /**
   * Cierra una cuenta. No se borra: sus movimientos siguen existiendo y los
   * informes históricos siguen siendo válidos.
   */
  async close(user: AuthenticatedUser, accountId: string, meta: RequestMetaInfo) {
    const account = await this.prisma.financialAccount.findUnique({ where: { id: accountId } });
    if (!account) {
      throw new NotFoundError('Cuenta financiera', accountId);
    }
    await this.access.assertCanAdminister(user.userId, account.entityId);

    const balance = await accountBalance(this.prisma, { financialAccountId: accountId });
    if (!dec(balance.balance).isZero()) {
      throw new ConflictError(
        `No se puede cerrar la cuenta con saldo ${balance.balance}. Transfiera o ajuste el saldo a cero primero.`,
      );
    }

    const updated = await this.prisma.financialAccount.update({
      where: { id: accountId },
      data: { status: 'CLOSED' },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'account.closed',
      entityType: 'FinancialAccount',
      entityId: accountId,
      after: { status: 'CLOSED' },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.present(updated, dec(balance.balance), balance.movementCount);
  }

  private present(
    account: {
      id: string;
      entityId: string;
      name: string;
      type: string;
      currency: string;
      openingBalance: DecimalInput;
      openingDate: Date;
      isCreditCard: boolean;
      creditLimit: DecimalInput | null;
      statementDay: number | null;
      paymentDueDay: number | null;
      status: string;
      notes: string | null;
      ledgerAccount?: { code: string; name: string; normalBalance: string };
      entity?: { id: string; code: string; name: string; currency: string };
    },
    balance: ReturnType<typeof dec>,
    movementCount = 0,
  ) {
    return {
      id: account.id,
      entityId: account.entityId,
      entity: account.entity,
      name: account.name,
      type: account.type,
      currency: account.currency,
      status: account.status,
      notes: account.notes,
      isCreditCard: account.isCreditCard,
      // Se marca explícitamente: una tarjeta NO es dinero disponible.
      isLiability: account.ledgerAccount?.normalBalance === 'CREDIT',
      openingBalance: dec(account.openingBalance).toFixed(2),
      openingDate: account.openingDate,
      creditLimit: account.creditLimit === null ? null : dec(account.creditLimit).toFixed(2),
      statementDay: account.statementDay,
      paymentDueDay: account.paymentDueDay,
      balance: dec(balance).toFixed(2),
      movementCount,
      ledgerAccount: account.ledgerAccount,
    };
  }
}
