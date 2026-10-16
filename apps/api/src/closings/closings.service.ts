import { Injectable } from '@nestjs/common';
import type { ClosingStatus, Prisma } from '../generated/prisma/client.js';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { ConflictError, NotFoundError, ValidationError, ClosingStateError } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { businessDateToIso, businessToday, addBusinessDays, startOfBusinessMonth } from '../domain/business-date.js';
import { dec, percentOf, round2, sum } from '../domain/money.js';
import { balancesForAccounts } from '../ledger/ledger-core.js';
import {
  analyzeClosing,
  closingStatusLabel,
  evaluateDiscipline,
  type AccountCount,
  type ClosingAnalysis,
} from './closing-rules.js';
import { FinalizeClosingDto, ReopenClosingDto, SaveClosingDto } from './closings.dto.js';

/** Cuentas que se cuentan a mano al final del día. */
const COUNTABLE_TYPES = ['CASH', 'BUSINESS_CASH', 'DIGITAL_WALLET'] as const;

const CHECKLIST_STEPS: Array<{ key: string; label: string; requiresConfirmation: boolean }> = [
  { key: 'income_registered', label: 'Confirmo que TODOS los ingresos del día están registrados', requiresConfirmation: true },
  { key: 'expenses_registered', label: 'Confirmo que TODOS los gastos del día están registrados', requiresConfirmation: true },
  { key: 'account_movements', label: 'Confirmo que los movimientos de cuentas están completos', requiresConfirmation: true },
  { key: 'cash_counted', label: 'Efectivo contado en cada cuenta', requiresConfirmation: false },
  { key: 'expected_vs_counted', label: 'Comparación entre saldo esperado y contado', requiresConfirmation: false },
  { key: 'transfers_reviewed', label: 'Transferencias y retiros del día revisados', requiresConfirmation: true },
  { key: 'differences_identified', label: 'Diferencias identificadas', requiresConfirmation: false },
  { key: 'differences_explained', label: 'Diferencias explicadas', requiresConfirmation: false },
  { key: 'sync_reviewed', label: 'Movimientos pendientes de sincronizar revisados', requiresConfirmation: false },
  { key: 'closing_confirm', label: 'Confirmo el cierre', requiresConfirmation: true },
];

/**
 * CIERRE FINANCIERO DIARIO
 * ------------------------
 * Es el módulo que sostiene la disciplina: al final del día el sistema calcula
 * el saldo ESPERADO de cada cuenta desde el libro mayor, pide el saldo REAL
 * contado, mide la diferencia y no deja finalizar hasta que cada diferencia
 * tenga explicación y no queden movimientos locales sin confirmar.
 *
 * Un cierre no se puede cerrar dos veces: hay una única fila por
 * (unidad financiera, día de negocio).
 */
@Injectable()
export class ClosingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly transactions: TransactionsService,
  ) {}

  /**
   * Paso 1-2 del asistente: prepara el cierre con TODO lo que el usuario debe
   * revisar. No modifica nada.
   */
  async prepare(user: AuthenticatedUser, entityId: string, dateIso?: string) {
    await this.access.assertCanRead(user.userId, entityId);
    const businessDate = dateIso ? new Date(`${dateIso}T00:00:00.000Z`) : businessToday();

    const entity = await this.prisma.financialEntity.findUnique({
      where: { id: entityId },
      select: { id: true, code: true, name: true, currency: true },
    });
    if (!entity) {
      throw new NotFoundError('Unidad financiera', entityId);
    }

    const accounts = await this.prisma.financialAccount.findMany({
      where: { entityId, status: 'ACTIVE' },
      include: { ledgerAccount: { select: { code: true, normalBalance: true } } },
      orderBy: { name: 'asc' },
    });

    const balances = await balancesForAccounts(this.prisma, {
      financialAccountIds: accounts.map((account) => account.id),
      asOf: businessDate,
    });

    const countable = accounts.filter((account) =>
      (COUNTABLE_TYPES as readonly string[]).includes(account.type),
    );

    const [dayTransactions, transfers, pendingSync, closing] = await Promise.all([
      this.prisma.financialTransaction.findMany({
        where: { entityId, businessDate, status: 'POSTED' },
        select: { id: true, kind: true, amount: true, description: true, recordedOffline: true, syncStatus: true },
      }),
      this.prisma.transfer.findMany({
        where: {
          businessDate,
          OR: [{ entityId }, { fromAccount: { entityId } }, { toAccount: { entityId } }],
        },
        select: { id: true, amount: true, description: true, isCrossEntity: true },
      }),
      this.countPendingSync(entityId),
      this.prisma.dailyClosing.findUnique({
        where: { entityId_businessDate: { entityId, businessDate } },
        include: { reconciliations: true },
      }),
    ]);

    const income = sum(dayTransactions.filter((t) => t.kind === 'INCOME').map((t) => t.amount));
    const expenses = sum(dayTransactions.filter((t) => t.kind === 'EXPENSE').map((t) => t.amount));
    const withdrawals = sum(dayTransactions.filter((t) => t.kind === 'OWNER_WITHDRAWAL').map((t) => t.amount));
    const contributions = sum(dayTransactions.filter((t) => t.kind === 'OWNER_CONTRIBUTION').map((t) => t.amount));

    const counts: AccountCount[] = countable.map((account) => {
      const existing = closing?.reconciliations.find((row) => row.accountId === account.id);
      return {
        accountId: account.id,
        accountName: account.name,
        expected: balances.get(account.id)?.balance ?? dec(0),
        counted: existing ? existing.countedAmount : balances.get(account.id)?.balance ?? dec(0),
        explanation: existing?.explanation ?? null,
      };
    });

    const analysis = analyzeClosing(counts, {
      pendingSyncOperations: pendingSync.total,
      isOffline: false,
      checklistComplete: false,
      missingAccounts: [],
    });

    return {
      entity,
      businessDate,
      businessDateIso: businessDateToIso(businessDate),
      status: closing?.status ?? ('PENDING' as ClosingStatus),
      statusLabel: closingStatusLabel(closing?.status ?? ('PENDING' as ClosingStatus)),
      countsNeeded: countable.map((account) => ({
        accountId: account.id,
        name: account.name,
        type: account.type,
        expectedBalance: dec(balances.get(account.id)?.balance ?? 0).toFixed(2),
        countedAmount: closing?.reconciliations.find((row) => row.accountId === account.id)?.countedAmount.toFixed(2) ?? null,
        explanation: closing?.reconciliations.find((row) => row.accountId === account.id)?.explanation ?? null,
      })),
      otherAccounts: accounts
        .filter((account) => !(COUNTABLE_TYPES as readonly string[]).includes(account.type))
        .map((account) => ({
          accountId: account.id,
          name: account.name,
          type: account.type,
          balance: dec(balances.get(account.id)?.balance ?? 0).toFixed(2),
          isLiability: account.ledgerAccount.normalBalance === 'CREDIT',
        })),
      daySummary: {
        income: income.toFixed(2),
        expenses: expenses.toFixed(2),
        result: round2(income.minus(expenses)).toFixed(2),
        withdrawals: withdrawals.toFixed(2),
        contributions: contributions.toFixed(2),
        transactionCount: dayTransactions.length,
      },
      transfers: transfers.map((transfer) => ({
        id: transfer.id,
        amount: transfer.amount.toFixed(2),
        description: transfer.description,
        isCrossEntity: transfer.isCrossEntity,
      })),
      pendingSync,
      checklist: this.buildChecklist({
        confirmedSteps: [],
        countsProvided: closing !== null,
        allAccountsCounted: closing !== null,
        differencesExplained: analysis.unexplainedDifferences === 0,
        differencesIdentified: closing !== null,
        pendingSyncOperations: pendingSync.total,
      }),
      analysis,
      existingClosing: closing
        ? {
            id: closing.id,
            status: closing.status,
            version: closing.version,
            reopenCount: closing.reopenCount,
            closedAt: closing.closedAt,
            lastReopenReason: closing.lastReopenReason,
            differences: closing.differencesJson,
          }
        : null,
    };
  }

  /**
   * Guarda el conteo. Queda PROVISIONAL si hay diferencia sin explicar o
   * movimientos sin confirmar; nunca se marca FINALIZED desde aquí.
   */
  async saveCount(user: AuthenticatedUser, dto: SaveClosingDto, meta: RequestMetaInfo) {
    await this.access.assertCanWrite(user.userId, dto.entityId);
    const businessDate = dto.businessDate ? new Date(`${dto.businessDate}T00:00:00.000Z`) : businessToday();

    const accounts = await this.prisma.financialAccount.findMany({
      where: { entityId: dto.entityId, status: 'ACTIVE' },
      include: { ledgerAccount: { select: { code: true, normalBalance: true } } },
    });
    const accountMap = new Map(accounts.map((account) => [account.id, account]));

    for (const count of dto.counts) {
      const account = accountMap.get(count.accountId);
      if (!account) {
        throw new ValidationError(`La cuenta ${count.accountId} no pertenece a esta unidad financiera`);
      }
      if (!(COUNTABLE_TYPES as readonly string[]).includes(account.type)) {
        throw new ValidationError(
          `La cuenta "${account.name}" es de tipo ${account.type} y no se cuenta a mano en el cierre diario`,
        );
      }
    }

    const balances = await balancesForAccounts(this.prisma, {
      financialAccountIds: dto.counts.map((count) => count.accountId),
      asOf: businessDate,
    });

    const counts: AccountCount[] = dto.counts.map((count) => ({
      accountId: count.accountId,
      accountName: accountMap.get(count.accountId)!.name,
      expected: balances.get(count.accountId)?.balance ?? dec(0),
      counted: dec(count.countedAmount),
      explanation: count.explanation ?? null,
    }));

    const pendingSync = await this.countPendingSync(dto.entityId);

    // Cuentas contables que se cuentan a mano y que no se enviaron: cerrar sin
    // contarlas dejaría dinero sin identificar.
    const countableAccounts = accounts.filter((account) =>
      (COUNTABLE_TYPES as readonly string[]).includes(account.type),
    );
    const countedIds = new Set(dto.counts.map((count) => count.accountId));
    const missingAccounts = countableAccounts
      .filter((account) => !countedIds.has(account.id))
      .map((account) => account.name);

    // Ingresos y gastos reales del día, para el resumen del cierre.
    const dayTotals = await this.prisma.financialTransaction.groupBy({
      by: ['kind'],
      where: { entityId: dto.entityId, businessDate, status: 'POSTED' },
      _sum: { amount: true },
    });
    const dayIncome = dec(dayTotals.find((row) => row.kind === 'INCOME')?._sum.amount ?? 0);
    const dayExpense = dec(dayTotals.find((row) => row.kind === 'EXPENSE')?._sum.amount ?? 0);

    const analysis = analyzeClosing(counts, {
      pendingSyncOperations: pendingSync.total,
      isOffline: dto.recordedOffline === true,
      checklistComplete: this.isChecklistComplete(dto.confirmedSteps ?? [], counts.length > 0, true),
      missingAccounts,
    });

    const existing = await this.prisma.dailyClosing.findUnique({
      where: { entityId_businessDate: { entityId: dto.entityId, businessDate } },
    });

    if (existing?.status === 'FINALIZED') {
      throw new ConflictError(
        `El cierre del ${dto.businessDate ?? businessDateToIso(businessDate)} ya está FINALIZADO. Para corregirlo debe reabrirlo con un motivo.`,
      );
    }
    if (dto.clientOperationId && existing && existing.clientOperationId === dto.clientOperationId) {
      return { duplicate: true, closingId: existing.id, status: existing.status, analysis };
    }

    // Instantáneas que se guardan en el cierre: quedan como prueba de lo que el
    // usuario vio y contó en ese momento, aunque después cambien los saldos.
    const balancesSnapshot = counts.map((count) => ({
      accountId: count.accountId,
      accountName: count.accountName,
      expected: dec(count.expected).toFixed(2),
      counted: dec(count.counted).toFixed(2),
    }));
    const differencesSnapshot = analysis.differences.map((row) => ({
      accountId: row.accountId,
      accountName: row.accountName,
      expected: row.expected,
      counted: row.counted,
      difference: row.difference,
      hasDifference: row.hasDifference,
      explanation: row.explanation,
      explained: row.explained,
    }));
    const checklistSnapshot = dto.confirmedSteps ?? [];

    // Guardar el conteo NUNCA deja el cierre FINALIZADO: como mucho lo deja con
    // diferencias registradas o listo para finalizar. La finalización es un
    // paso explícito y exige conexión.
    const status: ClosingStatus =
      dto.recordedOffline === true
        ? 'PROVISIONAL'
        : analysis.unexplainedDifferences > 0
          ? 'WITH_DIFFERENCES'
          : analysis.canFinalize
            ? 'WITH_DIFFERENCES'
            : analysis.suggestedStatus;

    const result = await this.prisma.$transaction(async (tx) => {
      const closing = await tx.dailyClosing.upsert({
        where: { entityId_businessDate: { entityId: dto.entityId, businessDate } },
        create: {
          entityId: dto.entityId,
          businessDate,
          status,
          expectedCash: dec(analysis.totalExpected),
          countedCash: dec(analysis.totalCounted),
          difference: dec(analysis.totalDifference),
          totalIncome: dayIncome,
          totalExpense: dayExpense,
          balancesJson: balancesSnapshot as unknown as Prisma.InputJsonValue,
          differencesJson: differencesSnapshot as unknown as Prisma.InputJsonValue,
          checklistJson: checklistSnapshot as unknown as Prisma.InputJsonValue,
          notes: dto.notes ?? null,
          clientOperationId: dto.clientOperationId ?? null,
          deviceId: meta.deviceId ?? null,
          recordedOffline: dto.recordedOffline ?? false,
        },
        update: {
          status,
          expectedCash: dec(analysis.totalExpected),
          countedCash: dec(analysis.totalCounted),
          difference: dec(analysis.totalDifference),
          totalIncome: dayIncome,
          totalExpense: dayExpense,
          balancesJson: balancesSnapshot as unknown as Prisma.InputJsonValue,
          differencesJson: differencesSnapshot as unknown as Prisma.InputJsonValue,
          checklistJson: checklistSnapshot as unknown as Prisma.InputJsonValue,
          notes: dto.notes ?? existing?.notes ?? null,
          recordedOffline: dto.recordedOffline ?? existing?.recordedOffline ?? false,
        },
      });

      for (const difference of analysis.differences) {
        await tx.closingReconciliation.upsert({
          where: { closingId_accountId: { closingId: closing.id, accountId: difference.accountId } },
          create: {
            closingId: closing.id,
            accountId: difference.accountId,
            expectedAmount: dec(difference.expected),
            countedAmount: dec(difference.counted),
            differenceAmount: dec(difference.difference),
            explanation: difference.explanation,
          },
          update: {
            expectedAmount: dec(difference.expected),
            countedAmount: dec(difference.counted),
            differenceAmount: dec(difference.difference),
            explanation: difference.explanation,
          },
        });
      }

      await this.audit.record(
        {
          userId: user.userId,
          actorType: dto.recordedOffline ? 'SYNC' : 'USER',
          action: dto.recordedOffline ? 'closing.saved_offline' : 'closing.counted',
          entityType: 'DailyClosing',
          entityId: closing.id,
          after: {
            businessDate: businessDateToIso(businessDate),
            status: closing.status,
            totalDifference: analysis.totalDifference,
            accountsWithDifference: analysis.accountsWithDifference,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return closing;
    });

    return {
      closingId: result.id,
      status: result.status,
      statusLabel: closingStatusLabel(result.status),
      recordedOffline: result.recordedOffline,
      analysis,
      canFinalize: analysis.canFinalize,
      message: analysis.canFinalize
        ? 'Conteo guardado. El cierre está listo para finalizarse.'
        : dto.recordedOffline
          ? 'Cierre guardado como PROVISIONAL, sin conexión. Se confirmará al sincronizar.'
          : `Conteo guardado como ${closingStatusLabel(result.status)}. ${analysis.blockers.join(' ')}`,
    };
  }

  /**
   * Finaliza el cierre. Exige que no queden diferencias sin explicar ni
   * movimientos locales sin confirmar. Si se pide, genera los asientos de
   * ajuste por diferencia (faltante 8010 / sobrante 4920).
   */
  async finalize(user: AuthenticatedUser, dto: FinalizeClosingDto, meta: RequestMetaInfo) {
    await this.access.assertCanWrite(user.userId, dto.entityId);
    const businessDate = dto.businessDate ? new Date(`${dto.businessDate}T00:00:00.000Z`) : businessToday();

    const closing = await this.prisma.dailyClosing.findUnique({
      where: { entityId_businessDate: { entityId: dto.entityId, businessDate } },
      include: { reconciliations: true },
    });

    if (!closing) {
      throw new NotFoundError(
        'Cierre diario',
        `no existe un cierre para el ${businessDateToIso(businessDate)}. Ejecute primero el conteo.`,
      );
    }
    if (closing.closedAt !== null) {
      throw new ConflictError(
        `El cierre del ${businessDateToIso(businessDate)} ya está finalizado (estado ${closing.status}, versión ${closing.version}). ` +
          'Para corregirlo debe reabrirlo con un motivo.',
      );
    }

    const counts: AccountCount[] = closing.reconciliations.map((row) => ({
      accountId: row.accountId,
      accountName: row.accountId,
      expected: row.expectedAmount,
      counted: row.countedAmount,
      explanation: row.explanation,
    }));

    /**
     * Las confirmaciones del asistente se guardan con el conteo (checklistJson)
     * y se reutilizan al finalizar: el usuario ya confirmó los pasos y no tiene
     * que repetirlos. Si el cliente los envía de nuevo, se usan los nuevos.
     * En ambos casos las confirmaciones quedan registradas en la auditoría.
     */
    const storedChecklist = Array.isArray(closing.checklistJson)
      ? (closing.checklistJson as unknown as string[])
      : [];
    const confirmedSteps = dto.confirmedSteps ?? storedChecklist;

    const pendingSync = await this.countPendingSync(dto.entityId);
    const analysis = analyzeClosing(counts, {
      pendingSyncOperations: pendingSync.total,
      isOffline: false,
      checklistComplete: this.isChecklistComplete(confirmedSteps, counts.length > 0, counts.length > 0),
      missingAccounts: [],
    });

    if (!analysis.canFinalize) {
      throw new ClosingStateError(
        'No se puede finalizar el cierre todavía.',
        analysis.blockers,
      );
    }

    // Ajustes contables por diferencia explicada.
    const adjustments: Array<{ accountId: string; difference: string; transactionId?: string }> = [];
    if (dto.adjustDifferences !== false) {
      for (const difference of analysis.differences) {
        if (!difference.hasDifference) {
          continue;
        }
        const account = await this.prisma.financialAccount.findUnique({
          where: { id: difference.accountId },
          include: { ledgerAccount: { select: { code: true } } },
        });
        if (!account) {
          continue;
        }

        const isShortage = dec(difference.difference).isNegative();
        const result = await this.transactions.create(
          user,
          {
            entityId: dto.entityId,
            kind: 'ADJUSTMENT',
            accountId: account.id,
            amount: dec(difference.difference).abs().toFixed(2),
            businessDate: businessDateToIso(businessDate),
            description: `Ajuste por diferencia de caja del ${businessDateToIso(businessDate)} (${account.name})`,
            adjustmentDebitCode: isShortage ? '8010' : account.ledgerAccount.code,
            adjustmentCreditCode: isShortage ? account.ledgerAccount.code : '4920',
            adjustmentReason: difference.explanation ?? 'Diferencia del cierre diario',
          },
          meta,
        );

        adjustments.push({
          accountId: account.id,
          difference: difference.difference,
          transactionId: result.id,
        });
      }
    }

    const finalized = await this.prisma.dailyClosing.update({
      where: { id: closing.id },
      data: {
        // Con diferencias explicadas el cierre queda "con diferencias"; si no
        // hubo ninguna, queda FINALIZADO limpio.
        status: analysis.accountsWithDifference > 0 ? 'WITH_DIFFERENCES' : 'FINALIZED',
        closedAt: new Date(),
        closedByUserId: user.userId,
        expectedCash: dec(analysis.totalExpected),
        countedCash: dec(analysis.totalCounted),
        difference: dec(analysis.totalDifference),
        differencesJson: JSON.parse(JSON.stringify(analysis.differences)) as unknown as Prisma.InputJsonValue,
        explanation: dto.notes ?? closing.explanation ?? null,
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'closing.finalized',
      entityType: 'DailyClosing',
      entityId: closing.id,
      after: {
        businessDate: businessDateToIso(businessDate),
        totalDifference: analysis.totalDifference,
        adjustments,
        version: finalized.version,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      closingId: finalized.id,
      status: finalized.status,
      statusLabel: closingStatusLabel(finalized.status),
      version: finalized.version,
      totals: {
        expected: analysis.totalExpected,
        counted: analysis.totalCounted,
        difference: analysis.totalDifference,
      },
      differences: analysis.differences.filter((difference) => difference.hasDifference),
      adjustments,
      message:
        analysis.accountsWithDifference > 0
          ? `Cierre finalizado con ${analysis.accountsWithDifference} diferencia(s) explicada(s) y su ajuste contable registrado.`
          : 'Cierre finalizado sin diferencias.',
    };
  }

  /** Reapertura auditada: obliga a registrar el motivo y queda en la historia. */
  async reopen(user: AuthenticatedUser, dto: ReopenClosingDto, meta: RequestMetaInfo) {
    await this.access.assertCanAdminister(user.userId, dto.entityId);
    const businessDate = dto.businessDate ? new Date(`${dto.businessDate}T00:00:00.000Z`) : businessToday();

    const closing = await this.prisma.dailyClosing.findUnique({
      where: { entityId_businessDate: { entityId: dto.entityId, businessDate } },
    });
    if (!closing) {
      throw new NotFoundError('Cierre diario', businessDateToIso(businessDate));
    }
    if (closing.closedAt === null) {
      throw new ClosingStateError(
        `Sólo se puede reabrir un cierre finalizado (estado actual del ${businessDateToIso(businessDate)}: ${closing.status}).`,
      );
    }

    const reopened = await this.prisma.dailyClosing.update({
      where: { id: closing.id },
      data: {
        status: 'REOPENED',
        lastReopenReason: dto.reason.trim(),
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'closing.reopened',
      entityType: 'DailyClosing',
      entityId: closing.id,
      before: { status: closing.status, version: closing.version },
      after: { status: reopened.status, version: reopened.version, reason: dto.reason.trim() },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      closingId: reopened.id,
      status: reopened.status,
      statusLabel: closingStatusLabel(reopened.status),
      version: reopened.version,
      reopenCount: reopened.reopenCount,
      message: 'Cierre reabierto. La reapertura quedó registrada en la auditoría.',
    };
  }

  async list(user: AuthenticatedUser, entityId: string | undefined, fromIso?: string, toIso?: string) {
    const entityIds = await this.access.resolveScope(user.userId, entityId);
    const from = fromIso ? new Date(`${fromIso}T00:00:00.000Z`) : startOfBusinessMonth(businessToday());
    const to = toIso ? new Date(`${toIso}T00:00:00.000Z`) : businessToday();

    const closings = await this.prisma.dailyClosing.findMany({
      where: { entityId: { in: entityIds }, businessDate: { gte: from, lte: to } },
      orderBy: { businessDate: 'desc' },
      include: {
        entity: { select: { id: true, code: true, name: true } },
        closedBy: { select: { id: true, name: true } },
        _count: { select: { reconciliations: true } },
      },
    });

    return closings.map((closing) => ({
      id: closing.id,
      entityId: closing.entityId,
      entity: closing.entity,
      businessDate: closing.businessDate,
      businessDateIso: businessDateToIso(closing.businessDate),
      status: closing.status,
      statusLabel: closingStatusLabel(closing.status),
      expectedCash: closing.expectedCash?.toFixed(2) ?? null,
      countedCash: closing.countedCash?.toFixed(2) ?? null,
      difference: closing.difference?.toFixed(2) ?? null,
      hasDifference: closing.difference ? !closing.difference.isZero() : false,
      accountsCounted: closing._count.reconciliations,
      version: closing.version,
      reopenCount: closing.reopenCount,
      lastReopenReason: closing.lastReopenReason,
      closedAt: closing.closedAt,
      closedBy: closing.closedBy,
      recordedOffline: closing.recordedOffline,
      notes: closing.notes,
    }));
  }

  /** Estado del día: qué días están cerrados y cuáles no (control de disciplina). */
  async calendar(user: AuthenticatedUser, entityId: string, days = 30) {
    await this.access.assertCanRead(user.userId, entityId);
    const today = businessToday();
    const from = addBusinessDays(today, -(days - 1));

    const [closings, transactionDays] = await Promise.all([
      this.prisma.dailyClosing.findMany({
        where: { entityId, businessDate: { gte: from, lte: today } },
      }),
      this.prisma.financialTransaction.groupBy({
        by: ['businessDate'],
        where: { entityId, businessDate: { gte: from, lte: today }, status: 'POSTED' },
        _count: { _all: true },
      }),
    ]);

    const closingMap = new Map(closings.map((closing) => [businessDateToIso(closing.businessDate), closing]));
    const movementMap = new Map(transactionDays.map((row) => [businessDateToIso(row.businessDate), row._count._all]));

    const result: Array<{
      date: string;
      hasMovements: boolean;
      movementCount: number;
      status: ClosingStatus | 'NOT_STARTED';
      statusLabel: string;
      difference: string | null;
    }> = [];

    for (let index = 0; index < days; index += 1) {
      const date = addBusinessDays(from, index);
      const iso = businessDateToIso(date);
      const closing = closingMap.get(iso);
      const movementCount = movementMap.get(iso) ?? 0;
      result.push({
        date: iso,
        hasMovements: movementCount > 0,
        movementCount,
        status: closing?.status ?? 'NOT_STARTED',
        statusLabel: closing ? closingStatusLabel(closing.status) : 'Sin cierre',
        difference: closing?.difference?.toFixed(2) ?? null,
      });
    }

    return {
      entityId,
      days,
      closed: closings.filter((closing) => closing.status === 'FINALIZED').length,
      pending: result.filter((row) => row.status === 'NOT_STARTED' || row.status === 'IN_PROGRESS' || row.status === 'PENDING')
        .length,
      withDifferences: closings.filter((closing) => closing.status === 'WITH_DIFFERENCES').length,
      calendar: result,
    };
  }

  /**
   * Semáforo de disciplina financiera con criterios verificables (§12).
   */
  async discipline(user: AuthenticatedUser, entityId?: string) {
    const entityIds = await this.access.resolveScope(user.userId, entityId);
    const today = businessToday();
    const from = addBusinessDays(today, -29);

    const [entities, closings, pendingSync, payables, receivables, loans] = await Promise.all([
      this.prisma.financialEntity.findMany({
        where: { id: { in: entityIds } },
        select: { id: true, name: true },
      }),
      this.prisma.dailyClosing.findMany({
        where: { entityId: { in: entityIds }, businessDate: { gte: from, lte: today } },
      }),
      this.prisma.syncOperation.count({
        where: { userId: user.userId, status: { in: ['RECEIVED'] } },
      }),
      this.prisma.payable.findMany({
        where: { entityId: { in: entityIds }, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
        select: { id: true, entityId: true, dueDate: true },
      }),
      this.prisma.receivable.findMany({
        where: { entityId: { in: entityIds }, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
        select: { id: true, entityId: true, dueDate: true },
      }),
      this.prisma.loan.findMany({
        where: { entityId: { in: entityIds }, status: 'ACTIVE' },
        select: { id: true, entityId: true, nextDueDate: true, direction: true },
      }),
    ]);

    const budgets = await this.prisma.budget.findMany({
      where: { entityId: { in: entityIds }, status: 'ACTIVE' },
      select: { id: true, entityId: true },
    });

    const todayTime = today.getTime();

    const statuses = await Promise.all(
      entities.map(async (entity) => {
        const entityClosings = closings.filter((closing) => closing.entityId === entity.id);
        const daysWithMovements = await this.prisma.financialTransaction.findMany({
          where: { entityId: entity.id, businessDate: { gte: from, lte: today }, status: 'POSTED' },
          select: { businessDate: true },
          distinct: ['businessDate'],
        });

        const daysRequiringClosing = Math.max(1, daysWithMovements.length);
        const finalized = entityClosings.filter((closing) => closing.status === 'FINALIZED').length;
        const pendingDays = entityClosings.filter((closing) =>
          ['PENDING', 'IN_PROGRESS', 'PROVISIONAL'].includes(closing.status),
        ).length;
        const withUnexplained = entityClosings.filter((closing) => {
          if (closing.status === 'WITH_DIFFERENCES') {
            const differences = (closing.differencesJson as unknown as Array<{ explained?: boolean }> | null) ?? [];
            return differences.some((difference) => difference?.explained === false);
          }
          return false;
        }).length;

        const overdueObligations =
          payables.filter((row) => row.entityId === entity.id && row.dueDate && row.dueDate.getTime() < todayTime).length +
          receivables.filter((row) => row.entityId === entity.id && row.dueDate && row.dueDate.getTime() < todayTime).length +
          loans.filter(
            (row) =>
              row.entityId === entity.id &&
              row.direction === 'PAYABLE' &&
              row.nextDueDate &&
              row.nextDueDate.getTime() < todayTime,
          ).length;

        const entityBudgets = budgets.filter((budget) => budget.entityId === entity.id);
        let budgetExceeded = 0;
        let budgetWarning = 0;
        for (const budget of entityBudgets) {
          const detail = await this.budgetHealth(budget.id);
          if (detail.health === 'EXCEEDED') {
            budgetExceeded += 1;
          } else if (detail.health === 'WARNING') {
            budgetWarning += 1;
          }
        }

        // Días con movimientos que no tienen cierre finalizado.
        const closedDays = new Set(
          entityClosings
            .filter((closing) => closing.status === 'FINALIZED')
            .map((closing) => businessDateToIso(closing.businessDate)),
        );
        const overdueClosings = daysWithMovements.filter((row) => !closedDays.has(businessDateToIso(row.businessDate))).length;

        const status = evaluateDiscipline({
          entityId: entity.id,
          entityName: entity.name,
          daysRequiringClosing,
          closingsFinalized: finalized,
          closingsWithUnexplainedDifferences: withUnexplained,
          overdueObligations,
          pendingSyncOperations: pendingSync,
          budgetExceeded,
          budgetWarning,
          overdueClosings,
        });

        return {
          entityId: entity.id,
          entityName: entity.name,
          level: status.level,
          reasons: status.reasons,
          checks: status.checks,
          metrics: {
            daysRequiringClosing,
            closingsFinalized: finalized,
            pendingClosings: pendingDays,
            overdueClosings,
            unexplainedDifferences: withUnexplained,
            overdueObligations,
            pendingSyncOperations: pendingSync,
            budgetExceeded,
            budgetWarning,
            closingCoveragePct: percentOf(finalized, daysRequiringClosing).toFixed(2),
          },
        };
      }),
    );

    const worst = statuses.some((status) => status.level === 'RED')
      ? 'RED'
      : statuses.some((status) => status.level === 'YELLOW')
        ? 'YELLOW'
        : 'GREEN';

    return {
      level: worst,
      generatedAt: new Date().toISOString(),
      entities: statuses,
      pendingSyncOperations: pendingSync,
    };
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  private async budgetHealth(budgetId: string): Promise<{ health: string }> {
    const budget = await this.prisma.budget.findUnique({
      where: { id: budgetId },
      include: { allocations: true },
    });
    if (!budget) {
      return { health: 'OK' };
    }

    const endDate = budget.endDate ?? new Date(addBusinessDays(businessToday(), 1).getTime());
    const grouped = await this.prisma.financialTransaction.groupBy({
      by: ['categoryId'],
      where: {
        entityId: budget.entityId,
        kind: 'EXPENSE',
        status: 'POSTED',
        businessDate: { gte: budget.startDate, lte: endDate },
        categoryId: { in: budget.allocations.map((allocation) => allocation.categoryId) },
      },
      _sum: { amount: true },
    });

    const spent = new Map(grouped.map((row) => [row.categoryId as string, dec(row._sum.amount ?? 0)]));
    let health = 'OK';
    for (const allocation of budget.allocations) {
      const limit = dec(allocation.limitAmount);
      if (limit.isZero()) {
        continue;
      }
      const used = percentOf(spent.get(allocation.categoryId) ?? dec(0), limit);
      if (used.greaterThanOrEqualTo(allocation.alertPct ?? 100)) {
        health = 'EXCEEDED';
      } else if (used.greaterThanOrEqualTo(allocation.warnPct ?? 80) && health !== 'EXCEEDED') {
        health = 'WARNING';
      }
    }
    return { health };
  }

  /** Movimientos registrados en el dispositivo que el servidor aún no confirmó. */
  private async countPendingSync(entityId: string): Promise<{ total: number; transactions: number; operations: number }> {
    const [transactions, operations] = await Promise.all([
      this.prisma.financialTransaction.count({
        where: { entityId, syncStatus: { in: ['PENDING', 'FAILED'] } },
      }),
      this.prisma.syncOperation.count({
        where: { entityId, status: 'RECEIVED' },
      }),
    ]);
    return { total: transactions + operations, transactions, operations };
  }

  private isChecklistComplete(confirmedSteps: string[], countsProvided: boolean, allAccountsCounted: boolean): boolean {
    if (!countsProvided || !allAccountsCounted) {
      return false;
    }
    const required = CHECKLIST_STEPS.filter((step) => step.requiresConfirmation).map((step) => step.key);
    return required.every((key) => confirmedSteps.includes(key));
  }

  private buildChecklist(params: {
    confirmedSteps: string[];
    countsProvided: boolean;
    allAccountsCounted: boolean;
    differencesIdentified: boolean;
    differencesExplained: boolean;
    pendingSyncOperations: number;
  }) {
    return CHECKLIST_STEPS.map((step) => {
      let satisfied: boolean;
      switch (step.key) {
        case 'cash_counted':
          satisfied = params.countsProvided;
          break;
        case 'expected_vs_counted':
          satisfied = params.countsProvided;
          break;
        case 'differences_identified':
          satisfied = params.differencesIdentified;
          break;
        case 'differences_explained':
          satisfied = params.differencesExplained;
          break;
        case 'sync_reviewed':
          satisfied = params.pendingSyncOperations === 0;
          break;
        case 'closing_confirm':
          satisfied = params.confirmedSteps.includes(step.key);
          break;
        default:
          satisfied = params.confirmedSteps.includes(step.key);
      }
      return {
        key: step.key,
        label: step.label,
        requiresUserConfirmation: step.requiresConfirmation,
        satisfied,
      };
    });
  }
}
