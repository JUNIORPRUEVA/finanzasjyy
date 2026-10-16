import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { SyncOperationStatus } from '../generated/prisma/enums.js';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { IdempotencyConflictError, ValidationError, isDomainError } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import { businessToday } from '../domain/business-date.js';
import { ClosingsService } from '../closings/closings.service.js';
import { LoansService } from '../loans/loans.service.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { TransfersService } from '../transfers/transfers.service.js';
import { contentHash } from '../auth/tokens.js';
import { formatZodError, syncPushSchema, type SyncPushInput } from './sync.schemas.js';

/** Tolerancia de desfase de reloj aceptada en el dispositivo (ms). */
const CLOCK_SKEW_TOLERANCE_MS = 10 * 60 * 1000;

export interface SyncOperationResult {
  clientOperationId: string;
  status: SyncOperationStatus;
  serverId?: string | null;
  entityId?: string | null;
  /** Detalle de lo aplicado (para que la app pueda actualizar su caché local). */
  result?: unknown;
  error?: string;
  code?: string;
}

/**
 * SINCRONIZACIÓN OFFLINE-FIRST
 * ----------------------------
 * La app puede registrar movimientos sin conexión durante la ventana
 * autorizada. Al recuperar la conexión envía un LOTE de operaciones y este
 * servicio las aplica con estas garantías:
 *
 *   1. IDEMPOTENCIA: cada operación trae un `clientOperationId`. Si ya fue
 *      aplicada, se devuelve DUPLICATE con el resultado original en lugar de
 *      duplicar el movimiento. Reintentar es SIEMPRE seguro.
 *   2. CONFLICTO: si el mismo identificador llega con contenido distinto, se
 *      marca CONFLICT y NO se sobrescribe nada (se conserva la primera versión).
 *   3. REINTENTOS: un fallo de validación devuelve REJECTED con el motivo; un
 *      fallo técnico devuelve ERROR y la app puede reintentar.
 *   4. ORDEN: las operaciones se aplican en el orden enviado (orden causal del
 *      dispositivo) y cada una es independiente.
 *   5. RELOJ: si el dispositivo envía una hora futura muy por delante del
 *      servidor, la operación se rechaza explicando el motivo (no se aceptan
 *      movimientos "del futuro").
 *   6. REGISTRO: cada intento queda en `SyncOperation` con su estado, de modo
 *      que el usuario puede AUDITAR qué se confirmó y qué no.
 *
 * Nada se marca como sincronizado si el servidor no lo confirmó.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly transactions: TransactionsService,
    private readonly transfers: TransfersService,
    private readonly closings: ClosingsService,
    private readonly loans: LoansService,
  ) {}

  /**
   * Aplica un lote de operaciones offline.
   * Nunca lanza por una operación individual: informa por operación.
   */
  async push(user: AuthenticatedUser, body: unknown, meta: RequestMetaInfo) {
    const parsed = syncPushSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(`El lote de sincronización no es válido: ${formatZodError(parsed.error)}`);
    }

    const input: SyncPushInput = parsed.data;
    const results: SyncOperationResult[] = [];

    for (const item of input.operations) {
      results.push(await this.applyOperation(user, input, item, meta));
    }

    const summary = {
      total: results.length,
      applied: results.filter((result) => result.status === 'APPLIED').length,
      duplicates: results.filter((result) => result.status === 'DUPLICATE').length,
      conflicts: results.filter((result) => result.status === 'CONFLICT').length,
      rejected: results.filter((result) => result.status === 'REJECTED').length,
      failed: results.filter((result) => result.status === 'ERROR').length,
    };

    this.logger.log(
      `Sync de ${user.email} (${input.deviceId}): ${summary.applied} aplicadas, ` +
        `${summary.duplicates} duplicadas, ${summary.conflicts} en conflicto, ${summary.rejected} rechazadas`,
    );

    return {
      serverTime: new Date().toISOString(),
      deviceId: input.deviceId,
      summary,
      results,
    };
  }

  private async applyOperation(
    user: AuthenticatedUser,
    input: SyncPushInput,
    item: SyncPushInput['operations'][number],
    meta: RequestMetaInfo,
  ): Promise<SyncOperationResult> {
    const clientOperationId = item.clientOperationId;
    const payloadHash = contentHash({ type: item.operation.type, payload: item.operation.payload });

    // --- ¿Ya lo tengo? -------------------------------------------------
    const existing = await this.prisma.syncOperation.findUnique({
      where: { clientOperationId },
    });

    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        await this.prisma.syncOperation.update({
          where: { id: existing.id },
          data: { status: 'CONFLICT', errorMessage: 'Mismo clientOperationId con contenido distinto' },
        });
        return {
          clientOperationId,
          status: 'CONFLICT',
          serverId: existing.serverId,
          entityId: existing.entityId,
          code: 'IDEMPOTENCY_CONFLICT',
          error:
            'Esta operación ya se registró con otros datos. Se conserva la versión original; revise el movimiento en el historial.',
        };
      }

      if (existing.status === 'APPLIED' || existing.status === 'DUPLICATE') {
        await this.prisma.syncOperation.update({
          where: { id: existing.id },
          data: { attemptCount: { increment: 1 }, status: 'DUPLICATE' },
        });
        return {
          clientOperationId,
          status: 'DUPLICATE',
          serverId: existing.serverId,
          entityId: existing.entityId,
          result: existing.resultJson,
          error: undefined,
        };
      }
    }

    // --- Reloj del dispositivo -----------------------------------------
    const clientTimestamp = item.clientRecordedAt ?? input.clientRecordedAt;
    if (clientTimestamp) {
      const recordedAt = new Date(clientTimestamp).getTime();
      if (Number.isFinite(recordedAt) && recordedAt > Date.now() + CLOCK_SKEW_TOLERANCE_MS) {
        const message =
          'La hora del dispositivo está adelantada respecto al servidor. Ajuste la fecha y el reloj del dispositivo y reintente: no se registran movimientos "del futuro".';
        await this.recordOperation(user, input, item, payloadHash, 'REJECTED', null, null, message, 'CLOCK_SKEW');
        return { clientOperationId, status: 'REJECTED', code: 'CLOCK_SKEW', error: message };
      }
    }

    const syncRow = await this.recordOperation(user, input, item, payloadHash, 'RECEIVED', null, null, null, null);

    // --- Aplicar -------------------------------------------------------
    try {
      const applied = await this.dispatch(user, clientOperationId, item, meta);

      // Una operación repetida NO se marca como «aplicada de nuevo»: se marca
      // como duplicada. Es lo que espera el dispositivo para limpiar su cola, y
      // lo que permite auditar que el reintento no creó dinero.
      const appliedStatus: SyncOperationStatus = applied.duplicate ? 'DUPLICATE' : 'APPLIED';

      await this.prisma.syncOperation.update({
        where: { id: syncRow.id },
        data: {
          status: appliedStatus,
          appliedAt: new Date(),
          entityId: applied.entityId,
          serverId: applied.serverId,
          resultJson: applied.result === undefined ? undefined : (JSON.parse(JSON.stringify(applied.result)) as Prisma.InputJsonValue),
        },
      });

      // La operación quedó confirmada: se marca el movimiento como sincronizado.
      if (applied.transactionId) {
        await this.prisma.financialTransaction.updateMany({
          where: { clientOperationId: applied.transactionId },
          data: { syncStatus: 'CONFIRMED', syncedAt: new Date() },
        });
      }

      return {
        clientOperationId,
        status: appliedStatus,
        serverId: applied.serverId,
        entityId: applied.entityId,
        result: applied.result,
        ...(applied.duplicate
          ? { error: 'Esta operación ya estaba registrada: no se ha duplicado.' }
          : {}),
      };
    } catch (error) {
      const isDomain = isDomainError(error);
      const message = error instanceof Error ? error.message : String(error);
      const isConflict = error instanceof IdempotencyConflictError;
      const status: SyncOperationStatus = isConflict ? 'CONFLICT' : isDomain ? 'REJECTED' : 'ERROR';

      await this.prisma.syncOperation.update({
        where: { id: syncRow.id },
        data: {
          status,
          errorMessage: message,
        },
      });

      if (status === 'ERROR') {
        this.logger.error(`Fallo al aplicar ${clientOperationId}: ${message}`);
      }

      return {
        clientOperationId,
        status,
        code: isDomain ? error.code : 'INTERNAL_ERROR',
        error: message,
      };
    }
  }

  /** Ejecuta la operación correspondiente reutilizando los servicios de dominio. */
  private async dispatch(
    user: AuthenticatedUser,
    clientOperationId: string,
    item: SyncPushInput['operations'][number],
    meta: RequestMetaInfo,
  ): Promise<{ serverId: string | null; entityId: string | null; result?: unknown; transactionId?: string; duplicate?: boolean }> {
    switch (item.operation.type) {
      case 'TRANSACTION': {
        const payload = item.operation.payload;
        const result = await this.transactions.create(
          user,
          {
            ...payload,
            clientOperationId,
            recordedOffline: true,
            deviceId: undefined,
          },
          meta,
        );
        return {
          serverId: result.id,
          entityId: payload.entityId,
          result,
          transactionId: clientOperationId,
          duplicate: result.duplicate === true,
        };
      }

      case 'TRANSFER': {
        const payload = item.operation.payload;
        const result = await this.transfers.create(
          user,
          { ...payload, clientOperationId, recordedOffline: true },
          meta,
        );
        const fromAccount = await this.prisma.financialAccount.findUnique({
          where: { id: payload.fromAccountId },
          select: { entityId: true },
        });
        return { serverId: result.id, entityId: fromAccount?.entityId ?? null, result, transactionId: `${clientOperationId}:out` };
      }

      case 'CLOSING_SAVE': {
        const payload = item.operation.payload;
        const result = await this.closings.saveCount(
          user,
          { ...payload, clientOperationId, recordedOffline: true },
          meta,
        );
        return {
          serverId: result.closingId,
          entityId: payload.entityId,
          result: {
            status: result.status,
            statusLabel: result.statusLabel,
            canFinalize: result.canFinalize,
            blockers: result.analysis.blockers,
          },
        };
      }

      case 'LOAN_PAYMENT': {
        const payload = item.operation.payload;
        const result = await this.loans.registerPayment(
          user,
          payload.loanId,
          { ...payload, clientOperationId },
          meta,
        );
        const loan = await this.prisma.loan.findUnique({
          where: { id: payload.loanId },
          select: { entityId: true },
        });
        if ('duplicate' in result && result.duplicate) {
          return { serverId: result.paymentId, entityId: loan?.entityId ?? null, result };
        }
        return {
          serverId: (result as { paymentId: string }).paymentId,
          entityId: loan?.entityId ?? null,
          result,
          transactionId: `${clientOperationId}:txn`,
        };
      }

      default: {
        const exhaustive: never = item.operation;
        throw new ValidationError(`Tipo de operación no soportado: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private async recordOperation(
    user: AuthenticatedUser,
    input: SyncPushInput,
    item: SyncPushInput['operations'][number],
    payloadHash: string,
    status: SyncOperationStatus,
    serverId: string | null,
    entityId: string | null,
    errorMessage: string | null,
    errorCode: string | null,
  ) {
    return this.prisma.syncOperation.upsert({
      where: { clientOperationId: item.clientOperationId },
      create: {
        userId: user.userId,
        deviceId: input.deviceId,
        clientOperationId: item.clientOperationId,
        operationType: item.operation.type,
        entityId,
        payloadJson: JSON.parse(
          JSON.stringify({ type: item.operation.type, payload: item.operation.payload }),
        ) as Prisma.InputJsonValue,
        payloadHash,
        status,
        serverId,
        errorMessage:
          errorMessage === null ? null : errorCode ? `[${errorCode}] ${errorMessage}` : errorMessage,
      },
      update: {
        status,
        serverId,
        entityId,
        errorMessage:
          errorMessage === null ? null : errorCode ? `[${errorCode}] ${errorMessage}` : errorMessage,
      },
    });
  }

  /**
   * Descarga de cambios: lo que la app necesita para actualizar su caché local.
   * Se basa en `updatedAt`/`createdAt` posteriores al cursor enviado.
   */
  async pull(user: AuthenticatedUser, params: { since?: string; entityId?: string; limit?: number }) {
    const entityIds = await this.access.resolveScope(user.userId, params.entityId);
    const since = params.since ? new Date(params.since) : new Date(Date.now() - 30 * 86_400_000);
    const limit = Math.min(500, params.limit ?? 200);

    const [transactions, transfers, closings, accounts, loans] = await Promise.all([
      this.prisma.financialTransaction.findMany({
        where: { entityId: { in: entityIds }, createdAt: { gt: since } },
        orderBy: { createdAt: 'asc' },
        take: limit,
        include: {
          account: { select: { id: true, name: true } },
          category: { select: { id: true, name: true, kind: true } },
        },
      }),
      this.prisma.transfer.findMany({
        where: { OR: [{ entityId: { in: entityIds } }, { toAccount: { entityId: { in: entityIds } } }], createdAt: { gt: since } },
        orderBy: { createdAt: 'asc' },
        take: limit,
      }),
      this.prisma.dailyClosing.findMany({
        where: { entityId: { in: entityIds }, updatedAt: { gt: since } },
        orderBy: { updatedAt: 'asc' },
        take: limit,
      }),
      this.prisma.financialAccount.findMany({
        where: { entityId: { in: entityIds }, updatedAt: { gt: since } },
        take: limit,
      }),
      this.prisma.loan.findMany({
        where: { entityId: { in: entityIds }, updatedAt: { gt: since } },
        take: limit,
      }),
    ]);

    return {
      serverTime: new Date().toISOString(),
      cursor: new Date().toISOString(),
      counts: {
        transactions: transactions.length,
        transfers: transfers.length,
        closings: closings.length,
        accounts: accounts.length,
        loans: loans.length,
      },
      transactions,
      transfers,
      closings,
      accounts,
      loans,
      /** Recuerda al cliente que debe usar el cursor devuelto en la próxima llamada. */
      note: 'Use el valor de `cursor` como `since` en la próxima descarga.',
    };
  }

  /** Estado de sincronización que ve el usuario en la app. */
  async status(user: AuthenticatedUser) {
    const [pending, failed, conflicts, lastApplied, devices] = await Promise.all([
      this.prisma.syncOperation.count({ where: { userId: user.userId, status: { in: ['RECEIVED'] } } }),
      this.prisma.syncOperation.count({ where: { userId: user.userId, status: 'ERROR' } }),
      this.prisma.syncOperation.count({ where: { userId: user.userId, status: 'CONFLICT' } }),
      this.prisma.syncOperation.findFirst({
        where: { userId: user.userId, status: { in: ['APPLIED', 'DUPLICATE'] } },
        orderBy: { appliedAt: 'desc' },
        select: { appliedAt: true, clientOperationId: true, operationType: true },
      }),
      this.prisma.device.findMany({
        where: { userId: user.userId },
        select: { deviceId: true, name: true, platform: true, lastSeenAt: true, isActive: true },
        orderBy: { lastSeenAt: 'desc' },
      }),
    ]);

    const pendingTransactions = await this.prisma.financialTransaction.count({
      where: { createdByUserId: user.userId, syncStatus: { in: ['PENDING', 'FAILED'] } },
    });

    return {
      pendingOperations: pending + pendingTransactions,
      failedOperations: failed,
      conflicts,
      lastSyncedAt: lastApplied?.appliedAt ?? null,
      lastSyncedOperation: lastApplied?.clientOperationId ?? null,
      devices,
      isFullySynced: pending === 0 && failed === 0 && conflicts === 0 && pendingTransactions === 0,
    };
  }

  /**
   * Lista de conflictos y rechazos para que el usuario decida qué hacer.
   * Es la "interfaz de resolución de conflictos" a nivel de API.
   */
  async issues(user: AuthenticatedUser) {
    const rows = await this.prisma.syncOperation.findMany({
      where: { userId: user.userId, status: { in: ['CONFLICT', 'REJECTED', 'ERROR'] } },
      orderBy: { receivedAt: 'desc' },
      take: 100,
    });

    return rows.map((row) => ({
      id: row.id,
      clientOperationId: row.clientOperationId,
      operationType: row.operationType,
      status: row.status,
      deviceId: row.deviceId,
      receivedAt: row.receivedAt,
      attempts: row.attemptCount,
      errorMessage: row.errorMessage,
      payload: row.payloadJson,
      /** Instrucción clara para el usuario. */
      recommendation:
        row.status === 'CONFLICT'
          ? 'Estos datos ya se registraron de otra forma. Revise el movimiento en el historial y anule el duplicado si procede.'
          : row.status === 'REJECTED'
            ? 'La operación no cumple las reglas de negocio. Corrija los datos indicados y vuelva a registrarla.'
            : 'Fallo técnico temporal. Puede reintentar el envío; no se duplicará nada.',
    }));
  }

  /** Descarta un conflicto dejando constancia (no borra la operación). */
  async resolveIssue(
    user: AuthenticatedUser,
    syncOperationId: string,
    resolution: 'DISCARDED' | 'RETRY_SUGGESTED',
    note: string,
    meta: RequestMetaInfo,
  ) {
    const row = await this.prisma.syncOperation.findUnique({ where: { id: syncOperationId } });
    if (!row || row.userId !== user.userId) {
      throw new ValidationError('La operación de sincronización no existe');
    }

    await this.audit.record({
      userId: user.userId,
      actorType: 'SYNC',
      action: `sync.issue.${resolution.toLowerCase()}`,
      entityType: 'SyncOperation',
      entityId: syncOperationId,
      before: { status: row.status, errorMessage: row.errorMessage },
      after: { resolution, note },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { resolved: true, syncOperationId, resolution };
  }

  /**
   * Limpieza de operaciones ya aplicadas y antiguas.
   * Se conserva un histórico de 90 días para poder auditar.
   */
  async pruneApplied(olderThanDays = 90): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    const result = await this.prisma.syncOperation.deleteMany({
      where: { status: { in: ['APPLIED', 'DUPLICATE'] }, appliedAt: { lt: cutoff } },
    });
    return result.count;
  }

  /** Fecha de negocio de hoy, expuesta para que el cliente no dependa de su reloj. */
  serverBusinessDate(): string {
    return businessToday().toISOString().slice(0, 10);
  }
}
