import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import { businessToday } from '../domain/business-date.js';
import { dec } from '../domain/money.js';
import {
  balancesForAccounts,
  reverseEntry,
  trialBalance,
  ledgerIntegrityReport,
  type TrialBalanceRow,
} from './ledger-core.js';

@Injectable()
export class LedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /** Catálogo contable completo, para pantallas de configuración y ajustes. */
  async listLedgerAccounts() {
    return this.prisma.ledgerAccount.findMany({
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        normalBalance: true,
        isPostable: true,
        isSystem: true,
        description: true,
      },
    });
  }

  /**
   * Saldos calculados de todas las cuentas de la unidad (o de todas las
   * accesibles). El saldo de una tarjeta de crédito se devuelve aparte y
   * marcado como pasivo: NUNCA se suma al dinero disponible.
   */
  async accountBalances(user: AuthenticatedUser, entityId?: string, asOf?: Date) {
    const entityIds = await this.access.resolveScope(user.userId, entityId);

    const accounts = await this.prisma.financialAccount.findMany({
      where: { entityId: { in: entityIds }, status: { not: 'CLOSED' } },
      orderBy: [{ entityId: 'asc' }, { name: 'asc' }],
      include: {
        entity: { select: { id: true, code: true, name: true, currency: true } },
        ledgerAccount: { select: { code: true, name: true, normalBalance: true, type: true } },
      },
    });

    const balances = await balancesForAccounts(this.prisma, {
      financialAccountIds: accounts.map((account) => account.id),
      asOf,
    });

    const data = accounts.map((account) => {
      const balance = balances.get(account.id);
      return {
        id: account.id,
        name: account.name,
        type: account.type,
        currency: account.currency,
        isCreditCard: account.isCreditCard,
        status: account.status,
        openingBalance: dec(account.openingBalance).toFixed(2),
        openingDate: account.openingDate,
        balance: dec(balance?.balance ?? 0).toFixed(2),
        movementCount: balance?.movementCount ?? 0,
        isLiability: account.ledgerAccount.normalBalance === 'CREDIT',
        ledgerCode: account.ledgerAccount.code,
        entity: account.entity,
      };
    });

    const availableCash = data
      .filter((account) => !account.isLiability && account.type !== 'CREDIT_CARD')
      .reduce((acc, account) => acc.plus(dec(account.balance)), dec(0));

    const liabilities = data
      .filter((account) => account.isLiability || account.type === 'CREDIT_CARD')
      .reduce((acc, account) => acc.plus(dec(account.balance)), dec(0));

    return {
      asOf: asOf ? asOf.toISOString() : null,
      accounts: data,
      totals: {
        // Dinero realmente disponible: NO incluye tarjetas de crédito ni
        // cuentas por cobrar (que no son efectivo hasta que se cobran).
        availableCash: availableCash.toFixed(2),
        creditCardAndLiabilityBalances: liabilities.toFixed(2),
      },
    };
  }

  async trialBalance(
    user: AuthenticatedUser,
    params: { entityId?: string; from?: Date; to?: Date },
  ): Promise<{
    rows: TrialBalanceRow[];
    totalDebit: string;
    totalCredit: string;
    balanced: boolean;
  }> {
    const entityIds = await this.access.resolveScope(user.userId, params.entityId);
    return trialBalance(this.prisma, { entityIds, from: params.from, to: params.to });
  }

  async listEntries(
    user: AuthenticatedUser,
    filters: {
      entityId?: string;
      from?: Date;
      to?: Date;
      sourceType?: string;
      accountId?: string;
      skip: number;
      take: number;
    },
  ) {
    const entityIds = await this.access.resolveScope(user.userId, filters.entityId);

    const where: Prisma.JournalEntryWhereInput = {
      entityId: { in: entityIds },
      sourceType: filters.sourceType,
      businessDate:
        filters.from || filters.to
          ? {
              gte: filters.from,
              lte: filters.to,
            }
          : undefined,
      lines: filters.accountId ? { some: { financialAccountId: filters.accountId } } : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.journalEntry.findMany({
        where,
        orderBy: [{ businessDate: 'desc' }, { sequence: 'desc' }],
        skip: filters.skip,
        take: filters.take,
        include: {
          entity: { select: { code: true, name: true } },
          lines: {
            include: {
              ledgerAccount: { select: { code: true, name: true } },
              financialAccount: { select: { name: true } },
            },
          },
        },
      }),
      this.prisma.journalEntry.count({ where }),
    ]);

    return { data, total };
  }

  async getEntry(user: AuthenticatedUser, entryId: string) {
    const entry = await this.prisma.journalEntry.findUnique({
      where: { id: entryId },
      include: {
        entity: { select: { id: true, code: true, name: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        lines: {
          include: {
            ledgerAccount: { select: { code: true, name: true, type: true } },
            financialAccount: { select: { id: true, name: true } },
          },
        },
        reverses: { select: { id: true, description: true } },
        reversedBy: { select: { id: true, description: true } },
      },
    });

    if (!entry) {
      throw new NotFoundError('Asiento contable', entryId);
    }
    await this.access.assertCanRead(user.userId, entry.entityId);
    return entry;
  }

  /**
   * Reverso de un asiento. Exige motivo: sin explicación no hay corrección.
   * El original queda marcado y aparece enlazado al reverso.
   */
  async reverseEntryManually(
    user: AuthenticatedUser,
    entryId: string,
    reason: string,
    meta: RequestMetaInfo,
  ) {
    const entry = await this.prisma.journalEntry.findUnique({
      where: { id: entryId },
      select: { id: true, entityId: true, status: true, description: true },
    });
    if (!entry) {
      throw new NotFoundError('Asiento contable', entryId);
    }
    await this.access.assertCanWrite(user.userId, entry.entityId);

    if (!reason || reason.trim().length < 5) {
      throw new ValidationError('El motivo del reverso debe explicar por qué se corrige (mínimo 5 caracteres)');
    }
    if (entry.status === 'REVERSED') {
      throw new ConflictError('Este asiento ya fue reversado');
    }

    return this.prisma.inMoneyTransaction(async (tx) => {
      const reversal = await reverseEntry(tx, {
        entryId,
        reason: reason.trim(),
        businessDate: businessToday(),
        createdByUserId: user.userId,
      });

      await this.audit.record(
        {
          userId: user.userId,
          action: 'ledger.entry.reversed',
          entityType: 'JournalEntry',
          entityId: entryId,
          before: { status: entry.status, description: entry.description },
          after: { reversalEntryId: reversal.id, reason: reason.trim() },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return reversal;
    });
  }

  /** Informe de integridad contable: cuadre de asientos y cuenta puente. */
  async integrity(user: AuthenticatedUser, entityId?: string) {
    const entityIds = await this.access.resolveScope(user.userId, entityId);
    return ledgerIntegrityReport(this.prisma, { entityIds });
  }
}
