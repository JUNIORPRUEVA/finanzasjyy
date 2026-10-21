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
 *  3. `cacheResponses`: la última respuesta buena de cada consulta (panel,
 *     cuentas, deudas, presupuestos…). Es una CACHÉ, no una base de datos
 *     paralela: guarda lo que el servidor ya contestó, con la hora a la que lo
 *     contestó, y sólo se usa cuando el servidor no puede responder. Sirve para
 *     que la app siga mostrando cifras reales durante esas 24 horas.
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

/**
 * Última respuesta correcta de una consulta (GET) del servidor.
 *
 * `key` es la ruta con su cadena de consulta tal cual se pidió. `body` es el
 * JSON serializado. No se guarda nada que el servidor no haya confirmado.
 */
export interface CacheResponse {
  key: string;
  body: string;
  cachedAt: string;
}

export class FinanzaDatabase extends Dexie {
  queuedOperations!: Table<QueuedOperation, string>;
  cacheEntities!: Table<CacheEntity, string>;
  cacheAccounts!: Table<CacheAccount, string>;
  cacheCategories!: Table<CacheCategory, string>;
  cacheMeta!: Table<CacheMeta, string>;
  cacheResponses!: Table<CacheResponse, string>;
  shoppingLists!: Table<ShoppingListSnapshot, string>;
  shoppingPending!: Table<ShoppingPendingSave, string>;

  constructor() {
    super('finanza-local');
    this.version(1).stores({
      queuedOperations: 'id, type, status, occurredAt, entityId',
      cacheEntities: 'id, code, name',
      cacheAccounts: 'id, entityId, name',
      cacheCategories: 'id, kind, entityId',
      cacheMeta: 'key',
    });

    // Versión 2: listas de compras personales.
    //
    // Se AÑADE una versión en vez de modificar la 1: así los dispositivos que ya
    // tenían datos (la cola de movimientos sin confirmar incluida) los conservan.
    // IndexedDB aplica sólo lo nuevo y no borra nada.
    this.version(2).stores({
      shoppingLists: 'id, entityId, status, updatedAt, pendingSync, deviceListId',
      shoppingPending: 'id, listId, createdAt',
    });

    // Versión 3: caché de respuestas para leer sin conexión.
    // Se añade igual que la 2, sin tocar lo anterior.
    this.version(3).stores({
      cacheResponses: 'key, cachedAt',
    });
  }
}

export const db = new FinanzaDatabase();

// ---------------------------------------------------------------------------
// Compras personales: copia local y envíos pendientes
// ---------------------------------------------------------------------------

/**
 * Copia local de una lista de compras.
 *
 * `pendingSync` significa «esto lo ha cambiado este dispositivo y el servidor
 * todavía no lo ha confirmado». Mientras valga `true`, la interfaz lo dice con
 * todas las letras: nunca se presenta como sincronizado algo que no lo está.
 */
export interface ShoppingListSnapshot {
  id: string;
  deviceListId: string;
  entityId: string;
  name: string;
  status: 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
  currency: string;
  notes: string | null;
  plannedDate: string | null;
  items: Array<{
    id: string;
    name: string;
    quantity: string;
    unit: string | null;
    estimatedUnitPrice: string | null;
    actualUnitPrice: string | null;
    isPurchased: boolean;
    categoryId: string | null;
  }>;
  /** Cambios locales sin enviar al servidor. */
  pendingSync: boolean;
  /** El gasto ya está registrado: a partir de aquí no se edita sin conexión. */
  expenseRegistered: boolean;
  serverId: string | null;
  /** Quién abrió la lista (la firma se conserva también sin conexión). */
  createdByName?: string | null;
  updatedAt: string;
  cachedAt: string;
}

/** Envío pendiente: la lista completa tal como quedó en el dispositivo. */
export interface ShoppingPendingSave {
  id: string;
  listId: string;
  deviceListId: string;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

/** Guarda (o actualiza) listas en la copia local sin borrar las demás. */
export async function saveLocalShoppingLists(lists: ShoppingListSnapshot[]): Promise<void> {
  if (lists.length === 0) {
    return;
  }
  await db.shoppingLists.bulkPut(lists);
}

export async function getLocalShoppingLists(): Promise<ShoppingListSnapshot[]> {
  const rows = await db.shoppingLists.toArray();
  return rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function getLocalShoppingList(id: string): Promise<ShoppingListSnapshot | null> {
  return (await db.shoppingLists.get(id)) ?? null;
}

export async function removeLocalShoppingList(id: string): Promise<void> {
  await db.shoppingLists.delete(id);
}

/** Anota que esta lista necesita enviarse al servidor. */
export async function queueShoppingSave(listId: string, deviceListId: string): Promise<void> {
  await db.shoppingPending.put({
    id: listId,
    listId,
    deviceListId,
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
  });
}

export async function listShoppingPending(): Promise<ShoppingPendingSave[]> {
  return db.shoppingPending.orderBy('createdAt').toArray();
}

export async function countShoppingPending(): Promise<number> {
  return db.shoppingPending.count();
}

export async function clearShoppingPending(listId: string): Promise<void> {
  await db.shoppingPending.delete(listId);
}

export async function markShoppingPendingError(listId: string, error: string): Promise<void> {
  const row = await db.shoppingPending.get(listId);
  if (!row) {
    return;
  }
  await db.shoppingPending.put({ ...row, attempts: row.attempts + 1, lastError: error });
}

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
    // Las respuestas guardadas son datos financieros del usuario: al cerrar
    // sesión desaparecen, igual que las cuentas y las categorías.
    db.cacheResponses.clear(),
  ]);
}

// ---------------------------------------------------------------------------
// Caché de respuestas (lo que se ve sin conexión)
// ---------------------------------------------------------------------------

/** Guarda la respuesta de una consulta. */
export async function putCachedResponse(key: string, body: string): Promise<void> {
  await db.cacheResponses.put({ key, body, cachedAt: new Date().toISOString() });
}

export async function getCachedResponse(key: string): Promise<CacheResponse | null> {
  return (await db.cacheResponses.get(key)) ?? null;
}

export async function countCachedResponses(): Promise<number> {
  return db.cacheResponses.count();
}

/** Elimina respuestas más viejas que `maxAgeMs` y recorta las más antiguas si sobran. */
export async function pruneCachedResponses(maxAgeMs: number, maxEntries: number): Promise<void> {
  const limite = new Date(Date.now() - maxAgeMs).toISOString();
  await db.cacheResponses.where('cachedAt').below(limite).delete();

  const total = await db.cacheResponses.count();
  if (total <= maxEntries) {
    return;
  }
  // `cachedAt` es ISO 8601: ordenar como texto equivale a ordenar por fecha.
  const sobran = total - maxEntries;
  const antiguas = await db.cacheResponses.orderBy('cachedAt').limit(sobran).toArray();
  await db.cacheResponses.bulkDelete(antiguas.map((row) => row.key));
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
