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

  /**
   * OPERACIONES QUE NO SE ENCOLAN
   * -----------------------------
   * Un ajuste contable dice exactamente qué cuenta se carga y cuál se abona.
   * Encolarlo sin conexión significaría aplicarlo más tarde sin que nadie pueda
   * revisar si sigue teniendo sentido (la cuenta pudo cambiar, el saldo pudo
   * dejar de cuadrar). Es una corrección deliberada: se hace con conexión.
   *
   * Los gastos, ingresos y retiros SÍ se encolan: son el día a día y, si el
   * servidor los rechaza, quedan visibles en «Salud de los datos» para repararlos.
   */
  if (input.payload.kind === 'ADJUSTMENT' && !navigator.onLine) {
    throw new OfflineError(
      'Un ajuste contable necesita conexión: es una corrección deliberada y hay que poder comprobar las cuentas al aplicarla. Vuelva a intentarlo con internet.',
    );
  }

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

/**
 * REPARA UNA OPERACIÓN ATASCADA, de verdad.
 *
 * Reenviar con otro identificador no arregla un dato inválido: si el servidor
 * dijo «esa categoría es de ingresos y el movimiento es un gasto», volverá a
 * decirlo siempre. Aquí se corrige el DATO, que es lo único que puede funcionar:
 *
 *   · Si el problema es la categoría (no existe, está desactivada o es del tipo
 *     contrario), se cambia por una categoría válida del mismo tipo que el
 *     movimiento. Si no hay ninguna, se quita la categoría y el servidor usa la
 *     cuenta contable por defecto de ese tipo.
 *   · Si el problema es la cuenta (cerrada o de otra unidad), se avisa: eso hay
 *     que decidirlo, no se puede adivinar.
 *
 * Lo que NUNCA se toca: el importe, la fecha, la unidad ni la cuenta. Así el
 * movimiento sigue siendo exactamente el que el usuario registró.
 */
export interface ResultadoReparacion {
  arreglada: boolean;
  cambios: string[];
  motivo?: string;
}

export function repararPayload(
  operation: QueuedOperation,
  categorias: Array<{ id: string; name: string; kind: string }>,
): { payload: Record<string, unknown>; resultado: ResultadoReparacion } {
  const payload = { ...(operation.payload as Record<string, unknown>) };
  const cambios: string[] = [];
  const error = (operation.lastError ?? '').toLowerCase();
  const kind = String(payload.kind ?? '');

  // 1. Categoría del tipo contrario (el caso que reportó el usuario).
  const problemaDeCategoria =
    error.includes('categoría') ||
    error.includes('categoria') ||
    (typeof payload.categoryId === 'string' && payload.categoryId.length > 0 && error.includes('tipo'));
  if (problemaDeCategoria && (kind === 'INCOME' || kind === 'EXPENSE')) {
    const valida = categorias.find((categoria) => categoria.kind === kind);
    const actual = categorias.find((categoria) => categoria.id === payload.categoryId);
    if (!actual || actual.kind !== kind) {
      if (valida) {
        payload.categoryId = valida.id;
        cambios.push(`categoría → «${valida.name}» (de ${kind === 'EXPENSE' ? 'gastos' : 'ingresos'})`);
      } else {
        delete payload.categoryId;
        cambios.push('se quitó la categoría inválida (se usará la cuenta por defecto)');
      }
    }
  }

  if (cambios.length === 0) {
    const motivo = (operation.lastError ?? '').trim();
    return {
      payload,
      resultado: {
        arreglada: false,
        cambios,
        motivo:
          motivo.length > 0
            ? `No se puede corregir sola: ${motivo}`
            : 'No se puede corregir sola: el servidor no dijo qué dato está mal.',
      },
    };
  }

  return { payload, resultado: { arreglada: true, cambios } };
}

/** Guarda una operación ya corregida con un identificador nuevo y la envía. */
export async function guardarOperacionReparada(
  operation: QueuedOperation,
  payload: Record<string, unknown>,
): Promise<void> {
  const nuevoId = newOperationId(operation.type.toLowerCase());
  await removeQueuedOperation(operation.id);
  await enqueueOperation({
    id: nuevoId,
    type: operation.type,
    payload,
    summary: operation.summary,
    amount: operation.amount,
    entityId: operation.entityId,
    entityName: operation.entityName,
    occurredAt: operation.occurredAt,
  });
  await syncPendingOperations();
}

/** Descarta una operación que NO llegó al servidor (nunca se descarta algo aplicado). */
export async function descartarOperacion(id: string): Promise<void> {
  await removeQueuedOperation(id);
}

/** Desbloquea una operación para volver a intentarla (tras revisarla). */
export async function retryOperation(id: string): Promise<void> {
  await markOperationStatus(id, 'PENDING');
}

// ---------------------------------------------------------------------------
// AGENTE DE SALUD DE LOS DATOS
// ---------------------------------------------------------------------------
// Responde a «¿queda algo mío sin llegar al servidor?» y permite arreglarlo.
// Antes, una operación que el servidor rechazaba o que quedaba en conflicto se
// quedaba en el teléfono para siempre: el contador de pendientes NO las incluía,
// así que la app decía «al día» y el dinero nunca se movía.

export interface QueueHealth {
  /** Se reintentan solas (pendientes y con error técnico). */
  pending: number;
  /** El servidor no las aplicó: hay que corregirlas o repararlas. */
  rejected: number;
  /** Mismo identificador con otros datos: hay que decidir cuál vale. */
  conflict: number;
  /** Rechazadas + en conflicto: requieren una acción del usuario. */
  stuck: number;
  total: number;
  oldestOccurredAt: string | null;
  lastError: string | null;
  lastSyncedAt: string | null;
  isOnline: boolean;
}

export async function queueHealth(): Promise<QueueHealth> {
  const queued = await listQueuedOperations();
  const pending = queued.filter((operation) => operation.status !== 'CONFLICT' && operation.status !== 'REJECTED');
  const rejected = queued.filter((operation) => operation.status === 'REJECTED');
  const conflict = queued.filter((operation) => operation.status === 'CONFLICT');
  const withError = queued.find((operation) => operation.lastError);
  const oldest = queued.length > 0 ? queued[0].occurredAt : null;

  return {
    pending: pending.length,
    rejected: rejected.length,
    conflict: conflict.length,
    stuck: rejected.length + conflict.length,
    total: queued.length,
    oldestOccurredAt: oldest,
    lastError: withError?.lastError ?? null,
    lastSyncedAt: await getMeta('lastSyncedAt'),
    isOnline: navigator.onLine,
  };
}

/**
 * REPARA Y REENVÍA las operaciones que el servidor no aplicó.
 *
 * Por qué con un identificador NUEVO: si el servidor respondió REJECTED, no
 * aplicó nada; si respondió CONFLICT fue porque ESE identificador ya existía con
 * otros datos. Reenviar el mismo identificador volvería a chocar, así que se
 * genera uno nuevo y el contenido (importe, cuenta, fecha) no se toca. Lo que
 * nunca se hace es inventar ni duplicar dinero: el servidor sigue deduplicando
 * por identificador y el usuario ve el resultado.
 */
export async function repairAndResend(ids?: string[]): Promise<{ repaired: number }> {
  const queued = await listQueuedOperations();
  const objetivo = queued.filter(
    (operation) => operation.status !== 'PENDING' && (!ids || ids.includes(operation.id)),
  );

  let repaired = 0;
  for (const operation of objetivo) {
    const nuevoId = newOperationId(operation.type.toLowerCase());
    await removeQueuedOperation(operation.id);
    await enqueueOperation({
      id: nuevoId,
      type: operation.type,
      payload: operation.payload,
      summary: operation.summary,
      amount: operation.amount,
      entityId: operation.entityId,
      entityName: operation.entityName,
      occurredAt: operation.occurredAt,
    });
    repaired += 1;
  }

  if (repaired > 0) {
    // Se reintenta enseguida lo reparado.
    await syncPendingOperations();
  }
  return { repaired };
}

/**
 * Avisa al administrador de que este dispositivo tiene datos sin subir.
 * Queda registrado en la auditoría del sistema con el detalle técnico.
 */
export async function reportProblemToAdmin(input: {
  description: string;
  health: QueueHealth;
}): Promise<void> {
  const operaciones = await listQueuedOperations();
  await api.post('/sync/report', {
    description: input.description.slice(0, 300),
    deviceId: deviceInfo.deviceId(),
    platform: deviceInfo.platform(),
    isOnline: input.health.isOnline,
    pending: input.health.pending,
    rejected: input.health.rejected,
    conflict: input.health.conflict,
    lastError: input.health.lastError,
    operations: operaciones.slice(0, 20).map((operation) => ({
      clientOperationId: operation.id,
      type: operation.type,
      status: operation.status,
      summary: operation.summary,
      amount: operation.amount,
      occurredAt: operation.occurredAt,
      lastError: operation.lastError,
    })),
  });
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
