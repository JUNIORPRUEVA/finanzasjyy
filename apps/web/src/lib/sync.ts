import { ApiError, OfflineError, api, deviceInfo, newOperationId } from './api';
import {
  countPendingOperations,
  enqueueOperation,
  getMeta,
  listQueuedOperations,
  markOperationStatus,
  removeQueuedOperation,
  setMeta,
  type QueuedOperation,
} from './db';

/**
 * MOTOR DE SINCRONIZACIÓN
 * -----------------------
 * Reglas que la app respeta escrupulosamente:
 *
 *  1. Una operación sólo se marca como ENVIADA cuando el servidor responde
 *     APPLIED o DUPLICATE. Nunca antes.
 *  2. Reintentar es seguro: cada operación lleva un `clientOperationId` y el
 *     servidor la deduplica.
 *  3. CONFLICT y REJECTED NO se reintentan automáticamente: requieren que el
 *     usuario decida (se muestran en la pantalla de sincronización).
 *  4. El error técnico (ERROR) mantiene la operación en cola con reintento.
 *  5. Antes de encolar sin conexión se comprueba la VENTANA OFFLINE: si caducó,
 *     se bloquea y se explica, en lugar de aceptar un trabajo que luego no se
 *     podría conciliar.
 */

export interface SyncResult {
  applied: number;
  duplicates: number;
  conflicts: number;
  rejected: number;
  failed: number;
  pendingAfter: number;
  lastSyncedAt: string | null;
}

export interface QueuedPushResult {
  status: string;
  clientOperationId: string;
  error?: string;
  code?: string;
}

/** Fin de la ventana autorizada para trabajar sin conexión. */
export async function offlineAllowedUntil(): Promise<Date | null> {
  const stored = await getMeta('offlineAllowedUntil');
  if (!stored) {
    return null;
  }
  const date = new Date(stored);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function canOperateOffline(): Promise<{ allowed: boolean; until: Date | null; reason: string }> {
  const until = await offlineAllowedUntil();
  if (!until) {
    return {
      allowed: false,
      until: null,
      reason:
        'No hay una autorización offline guardada. Conéctese a internet e inicie sesión al menos una vez para poder registrar movimientos sin conexión.',
    };
  }
  if (until.getTime() < Date.now()) {
    return {
      allowed: false,
      until,
      reason:
        'La autorización para trabajar sin conexión ha caducado. Conéctese a internet para seguir registrando movimientos con seguridad.',
    };
  }
  const hoursLeft = Math.max(0, Math.round((until.getTime() - Date.now()) / 3_600_000));
  return { allowed: true, until, reason: `Puede registrar movimientos sin conexión ~${hoursLeft} h más.` };
}

/**
 * Guarda una operación para enviarla ahora o cuando haya conexión.
 * Devuelve si se envió (true) o si quedó en cola (false).
 */
export async function submitOrQueue(input: {
  type: QueuedOperation['type'];
  payload: Record<string, unknown>;
  summary: string;
  amount: string | null;
  entityId: string | null;
  entityName: string | null;
  clientOperationId?: string;
}): Promise<{ queued: boolean; clientOperationId: string; sentNow: boolean; error?: string }> {
  const clientOperationId = input.clientOperationId ?? newOperationId(input.type.toLowerCase());

  if (!navigator.onLine) {
    const permission = await canOperateOffline();
    if (!permission.allowed) {
      throw new OfflineError(permission.reason);
    }
    await enqueueOperation({
      ...input,
      id: clientOperationId,
      occurredAt: new Date().toISOString(),
    });
    return { queued: true, clientOperationId, sentNow: false };
  }

  try {
    const response = await api.post<{ results: QueuedPushResult[] }>('/sync/push', {
      deviceId: deviceInfo.deviceId(),
      platform: deviceInfo.platform(),
      clientRecordedAt: new Date().toISOString(),
      operations: [
        {
          clientOperationId,
          clientRecordedAt: new Date().toISOString(),
          operation: { type: input.type, payload: input.payload },
        },
      ],
    });

    const result = response.results[0];
    if (result && (result.status === 'APPLIED' || result.status === 'DUPLICATE')) {
      await setMeta('lastSyncedAt', new Date().toISOString());
      return { queued: false, clientOperationId, sentNow: true };
    }

    // El servidor la rechazó: se guarda para que el usuario la vea y decida.
    await enqueueOperation({ ...input, id: clientOperationId, occurredAt: new Date().toISOString() });
    await markOperationStatus(clientOperationId, (result?.status as 'REJECTED') ?? 'ERROR', result?.error);
    return {
      queued: true,
      clientOperationId,
      sentNow: false,
      error: result?.error ?? 'El servidor rechazó la operación',
    };
  } catch (error) {
    if (error instanceof OfflineError) {
      const permission = await canOperateOffline();
      if (!permission.allowed) {
        throw new OfflineError(permission.reason);
      }
      await enqueueOperation({ ...input, id: clientOperationId, occurredAt: new Date().toISOString() });
      return { queued: true, clientOperationId, sentNow: false };
    }
    if (error instanceof ApiError && error.isUserFixable) {
      // Error de negocio (dato inválido): no se encola, se explica al usuario.
      throw error;
    }
    throw error;
  }
}

/** Envía todas las operaciones pendientes (llamado al recuperar conexión). */
export async function syncPendingOperations(): Promise<SyncResult> {
  const result: SyncResult = {
    applied: 0,
    duplicates: 0,
    conflicts: 0,
    rejected: 0,
    failed: 0,
    pendingAfter: 0,
    lastSyncedAt: await getMeta('lastSyncedAt'),
  };

  const queued = (await listQueuedOperations()).filter((operation) => operation.status !== 'CONFLICT' && operation.status !== 'REJECTED');
  if (queued.length === 0) {
    result.pendingAfter = await countPendingOperations();
    return result;
  }

  // El servidor acepta lotes de hasta 200 operaciones.
  const batch = queued.slice(0, 200);

  try {
    const response = await api.post<{ results: QueuedPushResult[]; serverTime: string }>('/sync/push', {
      deviceId: deviceInfo.deviceId(),
      platform: deviceInfo.platform(),
      clientRecordedAt: new Date().toISOString(),
      operations: batch.map((operation) => ({
        clientOperationId: operation.id,
        clientRecordedAt: operation.occurredAt,
        operation: { type: operation.type, payload: operation.payload },
      })),
    });

    for (const item of response.results) {
      switch (item.status) {
        case 'APPLIED':
          result.applied += 1;
          await removeQueuedOperation(item.clientOperationId);
          break;
        case 'DUPLICATE':
          result.duplicates += 1;
          await removeQueuedOperation(item.clientOperationId);
          break;
        case 'CONFLICT':
          result.conflicts += 1;
          await markOperationStatus(item.clientOperationId, 'CONFLICT', item.error);
          break;
        case 'REJECTED':
          result.rejected += 1;
          await markOperationStatus(item.clientOperationId, 'REJECTED', item.error);
          break;
        default:
          result.failed += 1;
          await markOperationStatus(item.clientOperationId, 'ERROR', item.error);
      }
    }

    await setMeta('lastSyncedAt', response.serverTime);
    result.lastSyncedAt = response.serverTime;
  } catch (error) {
    if (error instanceof OfflineError) {
      // Sin conexión: sigue pendiente, se reintentará.
      for (const operation of batch) {
        await markOperationStatus(operation.id, 'PENDING', 'Sin conexión con el servidor');
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      for (const operation of batch) {
        await markOperationStatus(operation.id, 'ERROR', message);
      }
      result.failed += batch.length;
    }
  }

  result.pendingAfter = await countPendingOperations();
  return result;
}

/** Estado local de sincronización (lo que ve el usuario incluso sin servidor). */
export async function localSyncStatus(): Promise<{
  pending: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  offlineAllowedUntil: string | null;
  isOnline: boolean;
}> {
  const queued = await listQueuedOperations();
  const withError = queued.find((operation) => operation.lastError);
  const until = await offlineAllowedUntil();

  return {
    pending: queued.filter((operation) => operation.status !== 'CONFLICT' && operation.status !== 'REJECTED').length,
    lastSyncedAt: await getMeta('lastSyncedAt'),
    lastError: withError?.lastError ?? null,
    offlineAllowedUntil: until?.toISOString() ?? null,
    isOnline: navigator.onLine,
  };
}

/** Desbloquea una operación para volver a intentarla (tras revisarla). */
export async function retryOperation(id: string): Promise<void> {
  await markOperationStatus(id, 'PENDING');
}

export function registerConnectivityListeners(onChange: (online: boolean) => void): () => void {
  const handleOnline = () => onChange(true);
  const handleOffline = () => onChange(false);
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}
