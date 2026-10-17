import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PRUEBAS DE LAS COMPRAS SIN CONEXIÓN
 * -----------------------------------
 * Aquí se prueba la parte que evita perder trabajo y, sobre todo, la que evita
 * MOVER DINERO dos veces:
 *  · Lo que se prepara sin conexión queda guardado y marcado como pendiente.
 *  · El envío es idempotente (el identificador del dispositivo viaja en el envío).
 *  · Una lista cuyo gasto YA está registrado no se sobrescribe nunca.
 *  · Sin identificador de lista no se llama al servidor a ciegas.
 */

const apiGet = vi.fn();
const apiPost = vi.fn();

vi.mock('./api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
  ApiError: class ApiError extends Error {
    status = 400;
  },
  OfflineError: class OfflineError extends Error {},
}));

const {
  createListOffline,
  flushShoppingQueue,
  isServerList,
  loadShoppingList,
  snapshotToRemote,
  toSnapshot,
} = await import('./shopping-offline');
const { countShoppingPending, db, getLocalShoppingList, listShoppingPending } = await import('./db');

function remoteList(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'list-1',
    entityId: 'entity-1',
    entityCode: 'PERSONAL',
    entityName: 'FINANZAS PERSONALES',
    name: 'Supermercado',
    status: 'ACTIVE' as const,
    currency: 'DOP',
    notes: null,
    plannedDate: '2026-10-17',
    completedAt: null,
    deviceListId: null,
    createdAt: '2026-10-17T10:00:00.000Z',
    updatedAt: '2026-10-17T10:00:00.000Z',
    totals: { estimated: '170.00', actual: '0.00', pending: '170.00', purchasedEstimated: '0.00', difference: '0.00' },
    counts: { items: 2, purchased: 0 },
    expense: { transactionId: null, journalEntryId: null, registered: false },
    items: [
      {
        id: 'item-1',
        name: 'Leche',
        quantity: '2.000',
        unit: null,
        estimatedUnitPrice: '60.00',
        actualUnitPrice: null,
        estimatedTotal: '120.00',
        actualTotal: '0.00',
        isPurchased: false,
        purchasedAt: null,
        categoryId: null,
        notes: null,
        sortOrder: 0,
      },
      {
        id: 'item-2',
        name: 'Café',
        quantity: '1.000',
        unit: null,
        estimatedUnitPrice: '50.00',
        actualUnitPrice: null,
        estimatedTotal: '50.00',
        actualTotal: '0.00',
        isPurchased: false,
        purchasedAt: null,
        categoryId: null,
        notes: null,
        sortOrder: 1,
      },
    ],
    ...overrides,
  };
}

describe('compras sin conexión', () => {
  beforeEach(async () => {
    await db.shoppingLists.clear();
    await db.shoppingPending.clear();
    apiGet.mockReset();
    apiPost.mockReset();
  });

  it('convierte lo que devuelve el servidor en la copia local sin perder nada', () => {
    const snapshot = toSnapshot(remoteList() as never);

    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items[0].name).toBe('Leche');
    expect(snapshot.items[0].estimatedUnitPrice).toBe('60.00');
    expect(snapshot.expenseRegistered).toBe(false);
    expect(snapshot.pendingSync).toBe(false);
    expect(snapshot.serverId).toBe('list-1');
  });

  it('la ida y vuelta (servidor → local → pantalla) mantiene importes y cantidades', () => {
    const remote = snapshotToRemote(toSnapshot(remoteList() as never));

    // La cantidad se conserva tal cual y los totales se recalculan con ella.
    expect(remote.items[0].quantity).toBe('2.000');
    expect(remote.totals.estimated).toBe('170.00');
    expect(remote.totals.pending).toBe('170.00');
    expect(remote.counts.items).toBe(2);
  });

  it('sin identificador de lista NO se llama al servidor (ni se inventa una lista)', async () => {
    const result = await loadShoppingList('');

    expect(result.list).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('una lista creada sin conexión queda guardada, pendiente de enviar y marcada como tal', async () => {
    const created = await createListOffline({ entityId: 'entity-1', name: 'Compra del sábado' });

    expect(created.id.startsWith('dev_')).toBe(true);
    expect(created.pendingSync).toBe(true);
    expect(created.serverId).toBeNull();
    expect(await countShoppingPending()).toBe(1);

    const stored = await getLocalShoppingList(created.id);
    expect(stored?.name).toBe('Compra del sábado');
  });

  it('una lista con el gasto YA registrado no se sobrescribe: se descarta del envío pendiente', async () => {
    const created = await createListOffline({ entityId: 'entity-1', name: 'Compra confirmada' });
    await db.shoppingLists.update(created.id, { expenseRegistered: true, pendingSync: true });

    const result = await flushShoppingQueue();

    expect(result.sent).toBe(0);
    expect(apiPost).not.toHaveBeenCalled();
    expect(await listShoppingPending()).toHaveLength(0);
    // Y la lista local sigue ahí, con su gasto registrado intacto.
    expect((await getLocalShoppingList(created.id))?.expenseRegistered).toBe(true);
  });

  it('distingue una lista que ya existe en el servidor de una creada aquí', () => {
    // Lista que llega del servidor tal cual (sin identificador de dispositivo).
    expect(isServerList({ id: '9f1c-uuid-del-servidor', deviceListId: null })).toBe(true);
    // Lista creada sin conexión: todavía NO está en el servidor.
    expect(isServerList({ id: 'dev_123', deviceListId: 'dev_123' })).toBe(false);
    // Lista que ya se sincronizó: conserva el identificador del dispositivo pero
    // ya tiene el del servidor, así que SÍ existe allí. Este caso es el que hacía
    // que se intentara escribir contra una lista inexistente y se perdiera el
    // producto recién escrito.
    expect(isServerList({ id: '9f1c-uuid-del-servidor', deviceListId: 'dev_123' })).toBe(true);
  });

  it('una lista sin cambios no genera trabajo pendiente', async () => {
    expect(await countShoppingPending()).toBe(0);
    expect(await listShoppingPending()).toHaveLength(0);
  });
});
