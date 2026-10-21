import { ApiError, OfflineError, api } from './api';
import {
  clearShoppingPending,
  countShoppingPending,
  getLocalShoppingList,
  getLocalShoppingLists,
  listShoppingPending,
  markShoppingPendingError,
  queueShoppingSave,
  removeLocalShoppingList,
  saveLocalShoppingLists,
  type ShoppingListSnapshot,
} from './db';

/**
 * COMPRAS PERSONALES SIN CONEXIÓN
 * ===============================
 * La lista de la compra se piensa muchas veces en el supermercado, donde la
 * cobertura es justo lo que falla. Así que las listas se trabajan **en el
 * dispositivo** y se envían al servidor cuando se puede.
 *
 * Reglas (las mismas que en el resto de FINANZA):
 *  · La copia local NUNCA se presenta como confirmada. Mientras haya cambios sin
 *    enviar, la interfaz lo dice («pendiente de enviar»).
 *  · El envío es idempotente: cada lista lleva su `deviceListId`, así que
 *    reintentar no duplica listas (lo garantiza el servidor).
 *  · El gasto financiero NO se registra sin conexión: eso es dinero real y se
 *    hace contra el servidor, con su asiento. Aquí se dice claramente.
 *  · Una lista cuyo gasto ya está confirmado no se sobrescribe desde el móvil.
 */

export interface RemoteShoppingItem {
  id: string;
  name: string;
  quantity: string;
  unit: string | null;
  estimatedUnitPrice: string | null;
  actualUnitPrice: string | null;
  estimatedTotal: string;
  actualTotal: string;
  isPurchased: boolean;
  purchasedAt: string | null;
  categoryId: string | null;
  notes: string | null;
  sortOrder: number;
}

export interface RemoteShoppingList {
  id: string;
  entityId: string;
  entityCode: string | null;
  entityName: string | null;
  /** Quién abrió la lista (firma). Puede faltar en listas antiguas. */
  createdByName?: string | null;
  name: string;
  status: ShoppingListSnapshot['status'];
  currency: string;
  notes: string | null;
  plannedDate: string | null;
  completedAt: string | null;
  deviceListId: string | null;
  createdAt: string;
  updatedAt: string;
  totals: {
    estimated: string;
    actual: string;
    pending: string;
    purchasedEstimated: string;
    difference: string;
  };
  counts: { items: number; purchased: number };
  expense: { transactionId: string | null; journalEntryId: string | null; registered: boolean };
  items: RemoteShoppingItem[];
  duplicate?: boolean;
}

/** Identificador de lista del dispositivo (permite crearla sin conexión). */
function newDeviceListId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random());
  return `dev_${Date.now().toString(36)}_${random.replace(/-/g, '').slice(0, 12)}`;
}

/** Convierte lo que devuelve el servidor en la copia local. */
export function toSnapshot(list: RemoteShoppingList): ShoppingListSnapshot {
  return {
    id: list.id,
    deviceListId: list.deviceListId ?? list.id,
    entityId: list.entityId,
    name: list.name,
    status: list.status,
    currency: list.currency,
    notes: list.notes,
    plannedDate: list.plannedDate,
    items: list.items.map((item) => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      estimatedUnitPrice: item.estimatedUnitPrice,
      actualUnitPrice: item.actualUnitPrice,
      isPurchased: item.isPurchased,
      categoryId: item.categoryId,
    })),
    pendingSync: false,
    expenseRegistered: list.expense.registered,
    serverId: list.id,
    updatedAt: list.updatedAt,
    createdByName: list.createdByName ?? null,
    cachedAt: new Date().toISOString(),
  };
}

/** Guarda en el dispositivo todo lo que llegó del servidor. */
export async function cacheRemoteLists(lists: RemoteShoppingList[]): Promise<void> {
  await saveLocalShoppingLists(lists.map(toSnapshot));
}

/**
 * Lee las listas: del servidor si se puede y, si no, de la copia local.
 * Se devuelven las locales marcadas como `pendingSync` para poder avisar.
 */
export async function loadShoppingLists(options: { entityId?: string; search?: string } = {}): Promise<{
  lists: RemoteShoppingList[];
  fromCache: boolean;
}> {
  const query = new URLSearchParams();
  if (options.entityId) {
    query.set('entityId', options.entityId);
  }
  if (options.search && options.search.length >= 2) {
    query.set('search', options.search);
  }
  const suffix = query.toString();

  try {
    const response = await api.get<{ data: RemoteShoppingList[] }>(`/shopping-lists${suffix ? `?${suffix}` : ''}`);
    const lists = response.data ?? [];
    await cacheRemoteLists(lists);
    return { lists, fromCache: false };
  } catch (error) {
    if (!(error instanceof OfflineError) && !(error instanceof ApiError)) {
      throw error;
    }
    const local = await getLocalShoppingLists();
    const filtered = options.entityId ? local.filter((row) => row.entityId === options.entityId) : local;
    const searched = options.search
      ? filtered.filter(
          (row) =>
            row.name.toLowerCase().includes(options.search!.toLowerCase()) ||
            row.items.some((item) => item.name.toLowerCase().includes(options.search!.toLowerCase())),
        )
      : filtered;

    return {
      fromCache: true,
      lists: searched.map((snapshot) => snapshotToRemote(snapshot)),
    };
  }
}

/** Reconstruye la forma «remota» a partir de la copia local (para pintarla igual). */
export function snapshotToRemote(snapshot: ShoppingListSnapshot): RemoteShoppingList {
  const round = (value: number) => value.toFixed(2);
  const number = (value: string | null) => (value === null ? null : Number(value));

  const items = snapshot.items.map((item, index) => {
    const quantity = Number(item.quantity);
    const estimatedUnit = number(item.estimatedUnitPrice);
    const actualUnit = number(item.actualUnitPrice);
    return {
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      estimatedUnitPrice: item.estimatedUnitPrice,
      actualUnitPrice: item.actualUnitPrice,
      estimatedTotal: round(estimatedUnit === null ? 0 : quantity * estimatedUnit),
      actualTotal: round(actualUnit === null ? 0 : quantity * actualUnit),
      isPurchased: item.isPurchased,
      purchasedAt: null,
      categoryId: item.categoryId,
      notes: null,
      sortOrder: index,
    };
  });

  const sum = (predicate: (item: RemoteShoppingItem) => string | null) =>
    items.reduce((acc, item) => acc + Number(predicate(item) ?? 0), 0);

  const estimated = sum((item) => item.estimatedTotal);
  const actual = sum((item) => item.actualTotal);
  const pending = sum((item) => (item.isPurchased ? null : item.estimatedTotal));
  const purchasedEstimated = sum((item) => (item.isPurchased ? item.estimatedTotal : null));

  return {
    id: snapshot.id,
    entityId: snapshot.entityId,
    entityCode: null,
    entityName: null,
    name: snapshot.name,
    status: snapshot.status,
    currency: snapshot.currency,
    notes: snapshot.notes,
    plannedDate: snapshot.plannedDate,
    completedAt: null,
    deviceListId: snapshot.deviceListId,
    createdAt: snapshot.updatedAt,
    updatedAt: snapshot.updatedAt,
    totals: {
      estimated: round(estimated),
      actual: round(actual),
      pending: round(pending),
      purchasedEstimated: round(purchasedEstimated),
      difference: round(actual - purchasedEstimated),
    },
    counts: { items: items.length, purchased: items.filter((item) => item.isPurchased).length },
    expense: {
      transactionId: null,
      journalEntryId: null,
      registered: snapshot.expenseRegistered,
    },
    items,
  };
}

/**
 * Crea una lista sin conexión: queda en el dispositivo marcada como pendiente y
 * se enviará sola cuando haya red.
 */
export async function createListOffline(input: {
  entityId: string;
  name: string;
  notes?: string | null;
  plannedDate?: string | null;
  items?: Array<{ name: string; quantity: string; estimatedUnitPrice: string | null; unit: string | null }>;
}): Promise<ShoppingListSnapshot> {
  const deviceListId = newDeviceListId();
  const snapshot: ShoppingListSnapshot = {
    id: deviceListId,
    deviceListId,
    entityId: input.entityId,
    name: input.name,
    status: 'DRAFT',
    currency: 'DOP',
    notes: input.notes ?? null,
    plannedDate: input.plannedDate ?? null,
    items: (input.items ?? []).map((item, index) => ({
      id: `${deviceListId}_${index}`,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      estimatedUnitPrice: item.estimatedUnitPrice,
      actualUnitPrice: null,
      isPurchased: false,
      categoryId: null,
    })),
    pendingSync: true,
    expenseRegistered: false,
    serverId: null,
    updatedAt: new Date().toISOString(),
    cachedAt: new Date().toISOString(),
  };

  await saveLocalShoppingLists([snapshot]);
  await queueShoppingSave(snapshot.id, deviceListId);
  return snapshot;
}

/** Marca una lista local como modificada y pendiente de enviar. */
export async function markListPending(id: string): Promise<void> {
  const existing = await getLocalShoppingList(id);
  if (!existing) {
    return;
  }
  await saveLocalShoppingLists([{ ...existing, pendingSync: true, updatedAt: new Date().toISOString() }]);
  await queueShoppingSave(id, existing.deviceListId);
}

/**
 * ¿La lista existe ya en el servidor? (las creadas sin conexión, todavía no).
 *
 * Se decide mirando el IDENTIFICADOR y nada más: una lista que nació en este
 * dispositivo lleva un identificador propio que empieza por `dev_`, y sigue
 * llevándolo aunque ya se haya sincronizado (el servidor le añade su propio
 * identificador y el dispositivo guarda el del servidor). Comprobar
 * `deviceListId` no sirve: se conserva a propósito para no perder la
 * correspondencia entre las dos partes.
 *
 * Importa mucho acertar aquí: si se dijera «está en el servidor» cuando no lo
 * está, la aplicación llamaría a la API con un identificador que el servidor no
 * conoce y **el producto que el usuario acaba de escribir se perdería**.
 */
export function isServerList(list: { id: string; deviceListId?: string | null }): boolean {
  return typeof list.id === 'string' && !list.id.startsWith('dev_');
}

/** Lee UNA lista: del servidor si se puede; si no, de la copia local. */
export async function loadShoppingList(id: string): Promise<{ list: RemoteShoppingList | null; fromCache: boolean }> {
  // Sin identificador no se llama al servidor: `GET /shopping-lists/` devuelve
  // la LISTA completa (otra forma de datos) y tratar esa respuesta como una
  // lista suelta rompía la pantalla. Mejor no preguntar que preguntar mal.
  if (!id) {
    return { list: null, fromCache: false };
  }
  try {
    const fresh = await api.get<RemoteShoppingList>(`/shopping-lists/${id}`);
    await cacheRemoteLists([fresh]);
    return { list: { ...fresh, fromCache: false } as RemoteShoppingList, fromCache: false };
  } catch (error) {
    if (!(error instanceof OfflineError) && !(error instanceof ApiError)) {
      throw error;
    }
    const local = (await getLocalShoppingList(id)) ?? null;
    if (!local) {
      // Puede que el identificador sea el del servidor y la copia esté guardada
      // con el identificador del dispositivo: se busca por coincidencia.
      const all = await getLocalShoppingLists();
      const match = all.find((row) => row.serverId === id) ?? null;
      return { list: match ? snapshotToRemote(match) : null, fromCache: true };
    }
    return { list: snapshotToRemote(local), fromCache: true };
  }
}

/**
 * Aplica un cambio a la copia local de una lista y la marca para enviar.
 * Se usa cuando no hay conexión: el usuario sigue trabajando y nada se pierde.
 */
export async function updateLocalList(
  id: string,
  updater: (snapshot: ShoppingListSnapshot) => ShoppingListSnapshot,
): Promise<ShoppingListSnapshot | null> {
  const all = await getLocalShoppingLists();
  const existing = (await getLocalShoppingList(id)) ?? all.find((row) => row.serverId === id) ?? null;
  if (!existing) {
    return null;
  }

  const next: ShoppingListSnapshot = {
    ...updater(existing),
    pendingSync: true,
    expenseRegistered: existing.expenseRegistered,
    updatedAt: new Date().toISOString(),
  };
  await saveLocalShoppingLists([next]);
  await queueShoppingSave(next.id, next.deviceListId);
  return next;
}

/**
 * Envía al servidor las listas pendientes.
 * Devuelve cuántas se enviaron y cuántas siguen esperando.
 */
export async function flushShoppingQueue(): Promise<{ sent: number; pending: number }> {
  const queue = await listShoppingPending();
  let sent = 0;

  for (const pending of queue) {
    const snapshot = await getLocalShoppingList(pending.listId);
    if (!snapshot) {
      await clearShoppingPending(pending.listId);
      continue;
    }
    if (snapshot.expenseRegistered) {
      // Si el gasto se registró en el servidor desde otro dispositivo, no se
      // envía nada: sobrescribir una compra confirmada sería perder información.
      await clearShoppingPending(pending.listId);
      continue;
    }

    try {
      const saved = await api.post<RemoteShoppingList>('/shopping-lists/sync', {
        deviceListId: snapshot.deviceListId,
        entityId: snapshot.entityId,
        name: snapshot.name,
        status: snapshot.status,
        notes: snapshot.notes,
        plannedDate: snapshot.plannedDate,
        items: snapshot.items.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
          estimatedUnitPrice: item.estimatedUnitPrice,
          actualUnitPrice: item.actualUnitPrice,
          isPurchased: item.isPurchased,
          categoryId: item.categoryId,
        })),
      });

      // El servidor confirma: ahora sí se puede decir «sincronizado».
      await clearShoppingPending(pending.listId);
      await removeLocalShoppingList(snapshot.id);
      await saveLocalShoppingLists([toSnapshot(saved)]);
      sent += 1;
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : error instanceof OfflineError ? 'Sin conexión' : 'Error al enviar';
      await markShoppingPendingError(pending.listId, message);
      if (error instanceof OfflineError) {
        break; // Sin red no se sigue intentando.
      }
    }
  }

  return { sent, pending: await countShoppingPending() };
}
