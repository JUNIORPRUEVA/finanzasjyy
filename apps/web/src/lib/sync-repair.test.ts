import { describe, expect, it } from 'vitest';
import { repararPayload } from './sync';
import type { QueuedOperation } from './db';

/**
 * REPARACIÓN DE UNA OPERACIÓN ATASCADA
 * -----------------------------------
 * El caso real que reportó el usuario: un GASTO quedó rechazado para siempre
 * porque llevaba una categoría de INGRESOS. Reenviarlo igual no sirve: el
 * servidor lo rechazaría siempre. La reparación tiene que cambiar el DATO y no
 * tocar lo que el usuario escribió (importe, fecha, cuenta).
 */

const categorias = [
  { id: 'cat-ingreso-otros', name: 'Otros ingresos', kind: 'INCOME' },
  { id: 'cat-gasto-suministros', name: 'Suministros de oficina', kind: 'EXPENSE' },
];

function operacion(payload: Record<string, unknown>, lastError: string): QueuedOperation {
  return {
    id: 'op-1',
    type: 'TRANSACTION',
    payload,
    summary: 'Compra de suministros',
    amount: '250.00',
    entityId: 'ent-1',
    entityName: 'FULLTECH',
    occurredAt: '2026-10-29T16:00:00.000Z',
    status: 'REJECTED',
    attempts: 1,
    lastError,
  };
}

describe('repararPayload', () => {
  it('cambia la categoría de ingresos por una de gastos en un gasto (el caso reportado)', () => {
    const op = operacion(
      { entityId: 'ent-1', kind: 'EXPENSE', accountId: 'acc-1', categoryId: 'cat-ingreso-otros', amount: '250.00' },
      'La categoría "Otros ingresos" es de ingresos y no se puede usar en un movimiento de tipo EXPENSE',
    );

    const { payload, resultado } = repararPayload(op, categorias);

    expect(resultado.arreglada).toBe(true);
    expect(payload.categoryId).toBe('cat-gasto-suministros');
    // Lo que el usuario escribió no se toca.
    expect(payload.amount).toBe('250.00');
    expect(payload.accountId).toBe('acc-1');
    expect(payload.entityId).toBe('ent-1');
  });

  it('si no hay ninguna categoría del tipo correcto, quita la categoría en vez de inventarla', () => {
    const op = operacion(
      { kind: 'EXPENSE', categoryId: 'cat-ingreso-otros', amount: '10.00' },
      'La categoría "Otros ingresos" es de ingresos y no se puede usar en un movimiento de tipo EXPENSE',
    );

    const { payload, resultado } = repararPayload(op, [categorias[0]]);

    expect(resultado.arreglada).toBe(true);
    expect(payload.categoryId).toBeUndefined();
    expect(payload.amount).toBe('10.00');
  });

  it('un ingreso con categoría de gastos se corrige al revés', () => {
    const op = operacion(
      { kind: 'INCOME', categoryId: 'cat-gasto-suministros', amount: '99.00' },
      'La categoría "Suministros de oficina" es de gastos y aquí se necesita de ingresos',
    );

    const { payload, resultado } = repararPayload(op, categorias);

    expect(resultado.arreglada).toBe(true);
    expect(payload.categoryId).toBe('cat-ingreso-otros');
  });

  it('no toca una operación cuyo error no sabe corregir y explica el motivo', () => {
    const op = operacion(
      { kind: 'EXPENSE', accountId: 'acc-1', amount: '10.00' },
      'La cuenta "Banco viejo" está cerrada',
    );

    const { payload, resultado } = repararPayload(op, categorias);

    expect(resultado.arreglada).toBe(false);
    expect(payload).toEqual({ kind: 'EXPENSE', accountId: 'acc-1', amount: '10.00' });
    expect(resultado.motivo).toContain('Banco viejo');
  });

  it('si la categoría ya es del tipo correcto, no la cambia', () => {
    const op = operacion(
      { kind: 'EXPENSE', categoryId: 'cat-gasto-suministros', amount: '10.00' },
      'El importe debe ser mayor que cero',
    );

    const { resultado } = repararPayload(op, categorias);
    expect(resultado.arreglada).toBe(false);
  });
});
