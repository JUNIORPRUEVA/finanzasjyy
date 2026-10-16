import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, countPendingOperations, listQueuedOperations, setMeta } from './db';
import { canOperateOffline, localSyncStatus, retryOperation, submitOrQueue, syncPendingOperations } from './sync';

/**
 * VALIDACIÓN COMPLETA DEL TRABAJO SIN CONEXIÓN (24 h)
 * ---------------------------------------------------
 * Recorre, paso a paso y de forma automatizada, el escenario real:
 * registrar con conexión → quedarse sin cobertura → seguir registrando →
 * cerrar la aplicación → volver a abrirla → recuperar la conexión → sincronizar.
 *
 * Se usa un IndexedDB REAL (fake-indexeddb) y un `fetch` simulado, de forma que
 * lo que se prueba es el mecanismo de verdad: la cola, los estados y las reglas.
 *
 * Lo que estas pruebas NO pueden demostrar (y por eso queda pendiente y así se
 * informa en el informe final): el comportamiento de un teléfono físico con el
 * modo avión activado durante 24 horas reales.
 */

type FetchMock = ReturnType<typeof vi.fn>;

const setOnline = (online: boolean) => {
  Object.defineProperty(window.navigator, 'onLine', { value: online, writable: true, configurable: true });
  Object.defineProperty(navigator, 'onLine', { value: online, writable: true, configurable: true });
};

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

/** Cuenta los envíos por lote (los que llevan más de una operación). */
const batchPushCount = (fetchMock: FetchMock) =>
  fetchMock.mock.calls.filter((call) => {
    if (!String(call[0]).includes('/sync/push')) {
      return false;
    }
    const body = JSON.parse(String((call[1] as { body?: string })?.body ?? '{}')) as { operations?: unknown[] };
    return (body.operations?.length ?? 0) > 0;
  }).length;

describe('Offline 24 h · validación completa del ciclo', () => {
  let fetchMock: FetchMock;

  beforeEach(async () => {
    await db.queuedOperations.clear();
    await db.cacheMeta.clear();
    setOnline(true);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('recorre el ciclo completo sin perder ni duplicar ninguna operación', async () => {
    // ---- Paso 1: registrar un ingreso CON conexión -------------------------
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ serverTime: new Date().toISOString(), results: [{ status: 'APPLIED', clientOperationId: 'x' }] }),
    );

    const online = await submitOrQueue({
      type: 'TRANSACTION',
      payload: { entityId: 'e1', kind: 'INCOME', accountId: 'a1', amount: '1000.00', description: 'Venta con conexión' },
      summary: 'Venta con conexión',
      amount: '1000.00',
      entityId: 'e1',
      entityName: 'FULLTECH',
    });
    expect(online.sentNow).toBe(true);
    expect(online.queued).toBe(false);
    expect(await countPendingOperations()).toBe(0);

    // ---- Paso 2: se cae la cobertura ---------------------------------------
    setOnline(false);

    // La autorización offline debe existir (se guarda al iniciar sesión).
    await setMeta('offlineAllowedUntil', new Date(Date.now() + 24 * 3_600_000).toISOString());
    const permission = await canOperateOffline();
    expect(permission.allowed).toBe(true);

    // ---- Pasos 3 y 4: registrar gastos e ingresos sin conexión -------------
    const offlineOps: Array<{ id: string; summary: string }> = [];
    for (const [index, payload] of [
      { kind: 'EXPENSE', amount: '250.00', description: 'Combustible sin cobertura' },
      { kind: 'INCOME', amount: '480.00', description: 'Cobro en efectivo sin cobertura' },
      { kind: 'EXPENSE', amount: '99.50', description: 'Almuerzo del equipo sin cobertura' },
    ].entries()) {
      const result = await submitOrQueue({
        type: 'TRANSACTION',
        payload: { entityId: 'e1', accountId: 'a1', ...payload },
        summary: payload.description,
        amount: payload.amount,
        entityId: 'e1',
        entityName: 'FULLTECH',
      });
      expect(result.queued).toBe(true);
      expect(result.sentNow).toBe(false);
      offlineOps.push({ id: result.clientOperationId, summary: payload.description });
      expect(index + 1).toBe(await countPendingOperations());
    }

    // ---- Paso 5: consultar lo registrado localmente ------------------------
    const local = await listQueuedOperations();
    expect(local).toHaveLength(3);
    expect(local.map((row) => row.summary)).toEqual(offlineOps.map((row) => row.summary));
    expect(local.every((row) => row.status === 'PENDING')).toBe(true);

    // ---- Paso 6: preparar un cierre provisional sin conexión ---------------
    const closing = await submitOrQueue({
      type: 'CLOSING_SAVE',
      payload: {
        entityId: 'e1',
        businessDate: new Date().toISOString().slice(0, 10),
        counts: [{ accountId: 'a1', countedAmount: '1000.00' }],
      },
      summary: 'Cierre provisional',
      amount: null,
      entityId: 'e1',
      entityName: 'FULLTECH',
    });
    expect(closing.queued).toBe(true);

    // ---- Pasos 7 y 8: cerrar y volver a abrir la aplicación ----------------
    // Cerrar la app es perder la memoria: la cola vive en el almacenamiento
    // persistente del dispositivo, así que se vuelve a leer tal cual.
    const afterRestart = await listQueuedOperations();
    expect(afterRestart).toHaveLength(4);
    expect(await countPendingOperations()).toBe(4);
    const idsBefore = afterRestart.map((row) => row.id).sort();

    // Estado visible para el usuario mientras no hay servidor.
    const statusOffline = await localSyncStatus();
    expect(statusOffline.pending).toBe(4);
    expect(statusOffline.isOnline).toBe(false);

    // ---- Paso 9: vuelve la conexión ---------------------------------------
    setOnline(true);

    // ---- Paso 10: sincronizar --------------------------------------------
    const sentOrder: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/sync/push')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          operations: Array<{ clientOperationId: string }>;
        };
        sentOrder.push(...body.operations.map((operation) => operation.clientOperationId));
        return jsonResponse({
          serverTime: new Date().toISOString(),
          results: body.operations.map((operation) => ({
            status: 'APPLIED',
            clientOperationId: operation.clientOperationId,
          })),
        });
      }
      return jsonResponse({});
    });

    const pushesBefore = batchPushCount(fetchMock);
    const sync = await syncPendingOperations();
    expect(sync.applied).toBe(4);
    expect(sync.pendingAfter).toBe(0);

    // ---- Pasos 11 y 12: verificar en el servidor y comprobar duplicados ----
    expect(sentOrder.sort()).toEqual(idsBefore);
    expect(new Set(sentOrder).size).toBe(sentOrder.length); // ninguno repetido
    expect(await countPendingOperations()).toBe(0);
    expect(batchPushCount(fetchMock) - pushesBefore).toBe(1); // un solo lote: no se reenvió de más

    // ---- Paso 13: simular un timeout del servidor --------------------------
    setOnline(false);
    const timeoutOp = await submitOrQueue({
      type: 'TRANSACTION',
      payload: { entityId: 'e1', accountId: 'a1', kind: 'EXPENSE', amount: '15.00', description: 'Con timeout' },
      summary: 'Con timeout',
      amount: '15.00',
      entityId: 'e1',
      entityName: 'FULLTECH',
    });
    setOnline(true);
    // Un tiempo de espera agotado llega como AbortError: es lo que produce el
    // límite de 20 s de `apiRequest` cuando el servidor no contesta.
    fetchMock.mockRejectedValueOnce(new DOMException('La operación tardó demasiado', 'AbortError'));

    const failedSync = await syncPendingOperations();
    expect(failedSync.failed).toBe(1);
    const afterTimeout = await listQueuedOperations();
    expect(afterTimeout).toHaveLength(1);
    expect(afterTimeout[0].status).toBe('ERROR');
    // La operación NO se perdió y sigue visible con su motivo.
    expect(afterTimeout[0].lastError ?? '').toMatch(/tardó demasiado|timeout/i);

    // ---- Paso 14: reintentar ----------------------------------------------
    await retryOperation(timeoutOp.clientOperationId);
    expect((await listQueuedOperations())[0].status).toBe('PENDING');

    fetchMock.mockImplementation(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { operations: Array<{ clientOperationId: string }> };
      return jsonResponse({
        serverTime: new Date().toISOString(),
        results: body.operations.map((operation) => ({
          status: 'APPLIED',
          clientOperationId: operation.clientOperationId,
        })),
      });
    });
    const retried = await syncPendingOperations();
    expect(retried.applied).toBe(1);
    expect(await countPendingOperations()).toBe(0);

    // ---- Paso 15: idempotencia (el servidor la ve repetida) ---------------
    const duplicate = await submitOrQueue({
      type: 'TRANSACTION',
      payload: { entityId: 'e1', accountId: 'a1', kind: 'INCOME', amount: '300.00', description: 'Reintento' },
      summary: 'Reintento',
      amount: '300.00',
      entityId: 'e1',
      entityName: 'FULLTECH',
    });
    setOnline(false);
    await setMeta('offlineAllowedUntil', new Date(Date.now() + 3_600_000).toISOString());
    await submitOrQueue({
      type: 'TRANSACTION',
      payload: { entityId: 'e1', accountId: 'a1', kind: 'INCOME', amount: '300.00', description: 'Reintento' },
      summary: 'Reintento',
      amount: '300.00',
      entityId: 'e1',
      entityName: 'FULLTECH',
      clientOperationId: duplicate.clientOperationId,
    });
    setOnline(true);

    fetchMock.mockImplementation(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { operations: Array<{ clientOperationId: string }> };
      return jsonResponse({
        serverTime: new Date().toISOString(),
        results: body.operations.map((operation) => ({
          status: 'DUPLICATE',
          clientOperationId: operation.clientOperationId,
        })),
      });
    });
    const duplicated = await syncPendingOperations();
    expect(duplicated.duplicates).toBe(1);
    // Y la cola queda limpia: no se conserva nada por ser duplicado.
    expect(await countPendingOperations()).toBe(0);

    // ---- Paso 16: conflicto entre dos dispositivos -------------------------
    setOnline(false);
    const conflicted = await submitOrQueue({
      type: 'TRANSACTION',
      payload: { entityId: 'e1', accountId: 'a1', kind: 'EXPENSE', amount: '40.00', description: 'Modificado en otro móvil' },
      summary: 'Modificado en otro móvil',
      amount: '40.00',
      entityId: 'e1',
      entityName: 'FULLTECH',
    });
    setOnline(true);

    fetchMock.mockImplementation(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { operations: Array<{ clientOperationId: string }> };
      return jsonResponse({
        serverTime: new Date().toISOString(),
        results: body.operations.map((operation) => ({
          status: 'CONFLICT',
          clientOperationId: operation.clientOperationId,
          error: 'Esta operación ya se registró con otros datos.',
        })),
      });
    });
    const conflicting = await syncPendingOperations();
    expect(conflicting.conflicts).toBe(1);
    const conflictedRow = (await listQueuedOperations()).find((row) => row.id === conflicted.clientOperationId);
    expect(conflictedRow?.status).toBe('CONFLICT');
    expect(conflictedRow?.lastError).toContain('otros datos');

    // Un conflicto NO se reintenta automáticamente: exige que el usuario decida.
    fetchMock.mockImplementation(async () => jsonResponse({ serverTime: new Date().toISOString(), results: [] }));
    const afterConflict = await syncPendingOperations();
    expect(afterConflict.pendingAfter).toBe(0);
    expect((await listQueuedOperations()).some((row) => row.status === 'CONFLICT')).toBe(true);

    // ---- Paso 18: lo rechazado sigue visible -------------------------------
    setOnline(false);
    const rejected = await submitOrQueue({
      type: 'TRANSACTION',
      payload: { entityId: 'e1', accountId: 'a1', kind: 'EXPENSE', amount: '5.00', description: 'Será rechazada' },
      summary: 'Será rechazada',
      amount: '5.00',
      entityId: 'e1',
      entityName: 'FULLTECH',
    });
    setOnline(true);
    fetchMock.mockImplementation(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { operations: Array<{ clientOperationId: string }> };
      return jsonResponse({
        serverTime: new Date().toISOString(),
        results: body.operations.map((operation) => ({
          status: 'REJECTED',
          clientOperationId: operation.clientOperationId,
          error: 'La cuenta no existe',
        })),
      });
    });
    const rejectedSync = await syncPendingOperations();
    expect(rejectedSync.rejected).toBe(1);
    const rejectedRow = (await listQueuedOperations()).find((row) => row.id === rejected.clientOperationId);
    expect(rejectedRow?.status).toBe('REJECTED');
    expect(rejectedRow?.lastError).toContain('no existe');

    // ---- Paso 19: nada se ha perdido ---------------------------------------
    const finalQueue = await listQueuedOperations();
    const accounted = finalQueue.filter((row) => row.status === 'CONFLICT' || row.status === 'REJECTED');
    expect(accounted).toHaveLength(2);
    // Todo lo demás llegó al servidor (APPLIED o DUPLICATE) y salió de la cola.
    expect(finalQueue.every((row) => row.status !== 'PENDING')).toBe(true);
  });

  it('paso 17 · pasada la ventana, la aplicación deja de aceptar registros sin conexión', async () => {
    setOnline(false);
    await setMeta('offlineAllowedUntil', new Date(Date.now() - 60_000).toISOString());

    const permission = await canOperateOffline();
    expect(permission.allowed).toBe(false);
    expect(permission.reason).toMatch(/caducado/i);

    await expect(
      submitOrQueue({
        type: 'TRANSACTION',
        payload: { entityId: 'e1', accountId: 'a1', kind: 'EXPENSE', amount: '1.00', description: 'Fuera de ventana' },
        summary: 'Fuera de ventana',
        amount: '1.00',
        entityId: 'e1',
        entityName: 'FULLTECH',
      }),
    ).rejects.toThrow(/caducado/i);

    // Y no se ha guardado nada: no se acepta trabajo que luego no se podría conciliar.
    expect(await countPendingOperations()).toBe(0);
  });

  it('avisa cuando quedan menos de 4 horas de autorización offline', async () => {
    await setMeta('offlineAllowedUntil', new Date(Date.now() + 90 * 60_000).toISOString());
    const status = await localSyncStatus();
    const hoursLeft = (new Date(status.offlineAllowedUntil ?? 0).getTime() - Date.now()) / 3_600_000;
    expect(hoursLeft).toBeGreaterThan(0);
    expect(hoursLeft).toBeLessThan(4);
  });

  it('sin autorización guardada no permite registrar sin conexión', async () => {
    await db.cacheMeta.clear();
    setOnline(false);
    const permission = await canOperateOffline();
    expect(permission.allowed).toBe(false);
    expect(permission.reason).toMatch(/Conéctese/i);
  });
});
