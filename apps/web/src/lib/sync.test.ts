import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countPendingOperations,
  db,
  enqueueOperation,
  exportPendingOperations,
  importPendingOperations,
  listQueuedOperations,
  markOperationStatus,
  removeQueuedOperation,
  setMeta,
} from './db';
import { canOperateOffline, submitOrQueue } from './sync';

/**
 * PRUEBAS DE LA COLA OFFLINE
 * --------------------------
 * Se ejecutan contra un IndexedDB real (fake-indexeddb): se comprueba de verdad
 * que una operación registrada sin conexión se guarda, se puede exportar, se
 * recupera y NO se pierde. Es el mecanismo que evita perder dinero anotado sin
 * conexión.
 */
describe('Cola de operaciones sin conexión', () => {
  beforeEach(async () => {
    await db.queuedOperations.clear();
    await db.cacheMeta.clear();
    vi.restoreAllMocks();
  });

  it('guarda una operación pendiente y la cuenta', async () => {
    await enqueueOperation({
      id: 'op-1',
      type: 'TRANSACTION',
      payload: { entityId: 'e1', kind: 'EXPENSE', amount: '150.00' },
      summary: 'Combustible',
      amount: '150.00',
      entityId: 'e1',
      entityName: 'FULLTECH',
      occurredAt: new Date().toISOString(),
    });

    const queued = await listQueuedOperations();
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe('PENDING');
    expect(await countPendingOperations()).toBe(1);
  });

  it('no duplica una operación con el mismo identificador (idempotencia local)', async () => {
    const operation = {
      id: 'op-2',
      type: 'TRANSACTION' as const,
      payload: { amount: '99.99' },
      summary: 'Prueba',
      amount: '99.99',
      entityId: 'e1',
      entityName: 'FULLTECH',
      occurredAt: new Date().toISOString(),
    };

    await enqueueOperation(operation);
    await enqueueOperation(operation);

    expect(await countPendingOperations()).toBe(1);
  });

  it('marca errores sin borrar la operación (nada se pierde)', async () => {
    await enqueueOperation({
      id: 'op-3',
      type: 'TRANSACTION',
      payload: {},
      summary: 'Prueba con error',
      amount: '10.00',
      entityId: 'e1',
      entityName: 'FULLTECH',
      occurredAt: new Date().toISOString(),
    });

    await markOperationStatus('op-3', 'ERROR', 'Sin conexión con el servidor');

    const queued = await listQueuedOperations();
    expect(queued[0].status).toBe('ERROR');
    expect(queued[0].attempts).toBe(1);
    expect(queued[0].lastError).toContain('Sin conexión');
    expect(await countPendingOperations()).toBe(1);
  });

  it('exporta los pendientes con una advertencia clara', async () => {
    await enqueueOperation({
      id: 'op-4',
      type: 'TRANSACTION',
      payload: { amount: '25.00' },
      summary: 'Pendiente de exportar',
      amount: '25.00',
      entityId: 'e1',
      entityName: 'FULLTECH',
      occurredAt: new Date().toISOString(),
    });

    const json = await exportPendingOperations();
    const parsed = JSON.parse(json) as { warning: string; operations: unknown[] };

    expect(parsed.operations).toHaveLength(1);
    expect(parsed.warning).toMatch(/NO confirmados/);
  });

  it('recupera los pendientes desde un archivo sin duplicar los que ya existen', async () => {
    await enqueueOperation({
      id: 'op-5',
      type: 'TRANSACTION',
      payload: {},
      summary: 'Ya en este dispositivo',
      amount: null,
      entityId: 'e1',
      entityName: null,
      occurredAt: new Date().toISOString(),
    });

    const exported = await exportPendingOperations();
    const parsed = JSON.parse(exported) as { operations: Array<Record<string, unknown>> };
    parsed.operations.push({
      id: 'op-6',
      type: 'TRANSACTION',
      payload: {},
      summary: 'Recuperada de un respaldo',
      amount: null,
      entityId: 'e1',
      entityName: null,
      occurredAt: new Date().toISOString(),
      status: 'PENDING',
      attempts: 0,
      lastError: null,
    });

    const imported = await importPendingOperations(JSON.stringify(parsed));

    expect(imported).toBe(1);
    expect(await countPendingOperations()).toBe(2);
  });

  it('rechaza un archivo con formato inesperado', async () => {
    await expect(importPendingOperations('{"otra":"cosa"}')).rejects.toThrow(/formato/);
  });

  it('permite descartar una operación concreta', async () => {
    await enqueueOperation({
      id: 'op-7',
      type: 'TRANSACTION',
      payload: {},
      summary: 'Para descartar',
      amount: null,
      entityId: 'e1',
      entityName: null,
      occurredAt: new Date().toISOString(),
    });

    await removeQueuedOperation('op-7');
    expect(await countPendingOperations()).toBe(0);
  });
});

describe('Ventana de trabajo sin conexión', () => {
  beforeEach(async () => {
    await db.cacheMeta.clear();
  });

  it('bloquea el registro offline cuando no hay autorización guardada', async () => {
    const permission = await canOperateOffline();
    expect(permission.allowed).toBe(false);
    expect(permission.reason).toMatch(/Conéctese a internet/);
  });

  it('permite registrar mientras la ventana sigue vigente', async () => {
    await setMeta('offlineAllowedUntil', new Date(Date.now() + 3 * 3_600_000).toISOString());
    const permission = await canOperateOffline();
    expect(permission.allowed).toBe(true);
    expect(permission.reason).toMatch(/sin conexión/);
  });

  it('bloquea cuando la ventana ya caducó', async () => {
    await setMeta('offlineAllowedUntil', new Date(Date.now() - 60_000).toISOString());
    const permission = await canOperateOffline();
    expect(permission.allowed).toBe(false);
    expect(permission.reason).toMatch(/caducado/);
  });

  it('sin conexión y sin ventana vigente, submitOrQueue rechaza la operación', async () => {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });

    await expect(
      submitOrQueue({
        type: 'TRANSACTION',
        payload: { entityId: 'e1', amount: '10.00' },
        summary: 'Prueba sin permiso',
        amount: '10.00',
        entityId: 'e1',
        entityName: 'FULLTECH',
      }),
    ).rejects.toThrow(/Conéctese a internet/);
  });

  it('sin conexión y con ventana vigente, la operación se encola', async () => {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    await setMeta('offlineAllowedUntil', new Date(Date.now() + 3_600_000).toISOString());

    const result = await submitOrQueue({
      type: 'TRANSACTION',
      payload: { entityId: 'e1', kind: 'EXPENSE', amount: '10.00' },
      summary: 'Registrado sin conexión',
      amount: '10.00',
      entityId: 'e1',
      entityName: 'FULLTECH',
    });

    expect(result.queued).toBe(true);
    expect(result.sentNow).toBe(false);
    expect(await countPendingOperations()).toBeGreaterThan(0);
  });
});
