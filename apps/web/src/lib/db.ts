import Dexie, { type Table } from 'dexie';

/**
 * BASE DE DATOS LOCAL (IndexedDB vía Dexie)
 * -----------------------------------------
 * FINANZA funciona sin conexión durante una ventana configurable (24 h por
 * defecto). Lo que se guarda aquí es EXACTAMENTE esto:
 *
 *  1. `queuedOperations`: movimientos y conteos registrados por el usuario que
 *     el servidor TODAVÍA NO HA CONFIRMADO. Cada uno lleva su
 *     `clientOperationId`, que hace que reenviarlo sea seguro (idempotencia).
 *  2. `cacheMeta`, `cacheEntities`, `cacheAccounts`, `cacheCategories`:
 *     copias de sólo lectura para poder MOVERSE por la app sin conexión.
 *
 * DECISIONES DELIBERADAS:
 *  · NO se guardan tokens, contraseñas ni secretos aquí.
 *  · Los datos en caché se muestran SIEMPRE marcados como "sin conexión": nunca
 *    se presentan como cifras conciliadas.
 *  · Nada se marca como enviado hasta que el servidor responde OK.
 *  · Si el navegador borra el almacenamiento (el sistema operativo puede
 *    hacerlo), la app lo detecta y avisa: por eso existe también la exportación
 *    de pendientes.
 */

export type QueuedOperationStatus = 'PENDING' | 'SENDING' | 'ERROR' | 'CONFLICT' | 'REJECTED';

export interface QueuedOperation {
  /** clientOperationId: clave primaria, garantiza no duplicar. */
  id: string;
  type: 'TRANSACTION' | 'TRANSFER' | 'CLOSING_SAVE' | 'LOAN_PAYMENT';
  /** Contenido que se enviará al servidor (importes como texto decimal). */
  payload: Record<string, unknown>;
  /** Resumen legible para mostrarlo en la lista de pendientes. */
  summary: string;
  amount: string | null;
  entityId: string | null;
  entityName: string | null;
  occurredAt: string;
  status: QueuedOperationStatus;
  attempts: number;
  lastError: string | null;
}

export interface CacheEntity {
  id: string;
  code: string;
  name: string;
  type: string;
  currency: string;
  cachedAt: string;
}

export interface CacheAccount {
  id: string;
  entityId: string;
  name: string;
  type: string;
  currency: string;
  isCreditCard: boolean;
  balance: string;
  cachedAt: string;
}

export interface CacheCategory {
  id: string;
  name: string;
  kind: 'INCOME' | 'EXPENSE';
  defaultLedgerCode: string | null;
  entityId: string | null;
  cachedAt: string;
}

export interface CacheMeta {
  key: string;
  value: string;
  updatedAt: string;
}

export class FinanzaDatabase extends Dexie {
  queuedOperations!: Table<QueuedOperation, string>;
  cacheEntities!: Table<CacheEntity, string>;
  cacheAccounts!: Table<CacheAccount, string>;
  cacheCategories!: Table<CacheCategory, string>;
  cacheMeta!: Table<CacheMeta, string>;

  constructor() {
    super('finanza-local');
    this.version(1).stores({
      queuedOperations: 'id, type, status, occurredAt, entityId',
      cacheEntities: 'id, code, name',
      cacheAccounts: 'id, entityId, name',
      cacheCategories: 'id, kind, entityId',
      cacheMeta: 'key',
    });
  }
}

export const db = new FinanzaDatabase();

// ---------------------------------------------------------------------------
// Cola de operaciones pendientes
// ---------------------------------------------------------------------------

export async function enqueueOperation(
  operation: Omit<QueuedOperation, 'status' | 'attempts' | 'lastError'>,
): Promise<void> {
  await db.queuedOperations.put({
    ...operation,
    status: 'PENDING',
    attempts: 0,
    lastError: null,
  });
}

export async function listQueuedOperations(): Promise<QueuedOperation[]> {
  return db.queuedOperations.orderBy('occurredAt').toArray();
}

export async function countPendingOperations(): Promise<number> {
  return db.queuedOperations.where('status').anyOf('PENDING', 'SENDING', 'ERROR').count();
}

export async function removeQueuedOperation(id: string): Promise<void> {
  await db.queuedOperations.delete(id);
}

export async function markOperationStatus(
  id: string,
  status: QueuedOperationStatus,
  error?: string,
): Promise<void> {
  // Se lee y se reescribe en lugar de usar `update` con función: Dexie tipa esa
  // variante como «modify» (debe devolver void) y aquí interesa conservar el
  // resto de los campos.
  const current = await db.queuedOperations.get(id);
  if (!current) {
    return;
  }
  await db.queuedOperations.put({
    ...current,
    status,
    attempts: current.attempts + 1,
    lastError: error ?? null,
  });
}

/** Exporta las operaciones pendientes para no perderlas si el navegador limpia el almacenamiento. */
export async function exportPendingOperations(): Promise<string> {
  const operations = await listQueuedOperations();
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      app: 'FINANZA',
      warning:
        'Este archivo contiene movimientos NO confirmados por el servidor. Guárdelo en un lugar seguro y vuélvalo a importar antes de registrarlos de nuevo a mano.',
      operations,
    },
    null,
    2,
  );
}

export async function importPendingOperations(json: string): Promise<number> {
  const parsed = JSON.parse(json) as { operations?: QueuedOperation[] };
  if (!Array.isArray(parsed.operations)) {
    throw new Error('El archivo no tiene el formato esperado (falta la lista de operaciones).');
  }
  let imported = 0;
  for (const operation of parsed.operations) {
    if (!operation?.id) {
      continue;
    }
    const exists = await db.queuedOperations.get(operation.id);
    if (exists) {
      continue;
    }
    await db.queuedOperations.put({ ...operation, status: 'PENDING', attempts: 0, lastError: null });
    imported += 1;
  }
  return imported;
}

// ---------------------------------------------------------------------------
// Caché de lectura
// ---------------------------------------------------------------------------

export async function setMeta(key: string, value: string): Promise<void> {
  await db.cacheMeta.put({ key, value, updatedAt: new Date().toISOString() });
}

export async function getMeta(key: string): Promise<string | null> {
  const row = await db.cacheMeta.get(key);
  return row?.value ?? null;
}

export async function cacheEntities(entities: CacheEntity[]): Promise<void> {
  await db.cacheEntities.clear();
  await db.cacheEntities.bulkPut(entities);
  await setMeta('entitiesCachedAt', new Date().toISOString());
}

export async function cacheAccounts(accounts: CacheAccount[]): Promise<void> {
  await db.cacheAccounts.clear();
  await db.cacheAccounts.bulkPut(accounts);
  await setMeta('accountsCachedAt', new Date().toISOString());
}

export async function cacheCategories(categories: CacheCategory[]): Promise<void> {
  await db.cacheCategories.clear();
  await db.cacheCategories.bulkPut(categories);
  await setMeta('categoriesCachedAt', new Date().toISOString());
}

/**
 * Añade o actualiza cuentas en la copia local SIN borrar las demás.
 *
 * Es importante que no borre: el servidor devuelve las cuentas filtrando por
 * unidad financiera, así que reemplazar la tabla entera dejaría a las otras
 * unidades sin datos justo cuando no hay conexión, que es cuando más falta hacen.
 */
export async function upsertCachedAccounts(accounts: CacheAccount[]): Promise<void> {
  if (accounts.length === 0) {
    return;
  }
  await db.cacheAccounts.bulkPut(accounts);
  await setMeta('accountsCachedAt', new Date().toISOString());
}

export async function upsertCachedCategories(categories: CacheCategory[]): Promise<void> {
  if (categories.length === 0) {
    return;
  }
  await db.cacheCategories.bulkPut(categories);
  await setMeta('categoriesCachedAt', new Date().toISOString());
}

export async function getCachedEntities(): Promise<CacheEntity[]> {
  return db.cacheEntities.orderBy('name').toArray();
}

export async function getCachedAccounts(entityId?: string): Promise<CacheAccount[]> {
  const all = await db.cacheAccounts.toArray();
  return entityId ? all.filter((account) => account.entityId === entityId) : all;
}

export async function getCachedCategories(kind?: 'INCOME' | 'EXPENSE'): Promise<CacheCategory[]> {
  const all = await db.cacheCategories.toArray();
  return kind ? all.filter((category) => category.kind === kind) : all;
}

/** Borra la caché local (al cerrar sesión). NO borra la cola de pendientes sin avisar. */
export async function clearReadCache(): Promise<void> {
  await Promise.all([
    db.cacheEntities.clear(),
    db.cacheAccounts.clear(),
    db.cacheCategories.clear(),
  ]);
}

/** Estado del almacenamiento persistente (el navegador puede borrarlo si no se concede). */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) {
    return false;
  }
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usageMb: number; quotaMb: number } | null> {
  if (!navigator.storage?.estimate) {
    return null;
  }
  const estimate = await navigator.storage.estimate();
  return {
    usageMb: Math.round(((estimate.usage ?? 0) / 1024 / 1024) * 10) / 10,
    quotaMb: Math.round((estimate.quota ?? 0) / 1024 / 1024),
  };
}
