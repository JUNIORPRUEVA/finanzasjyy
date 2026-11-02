import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guardarUltimaCuenta, leerUltimaCuenta } from './preferencias';

/**
 * PREFERENCIAS DE OPERACIÓN
 * -------------------------
 * Lo que se prueba aquí es lo importante para el dinero: que recordar una cuenta
 * NUNCA puede convertirse en un movimiento en la cuenta equivocada.
 *
 *  · Se recuerda por tipo de operación y por unidad (no hay una «cuenta global»).
 *  · Si el dato guardado está corrupto, se ignora: se vuelve al valor por defecto.
 *  · Si el navegador no deja escribir (modo privado), no se lanza ninguna
 *    excepción: registrar el movimiento es más importante que recordar.
 */
describe('preferencias de cuenta', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('empieza sin recordar nada', () => {
    expect(leerUltimaCuenta('EXPENSE', 'unidad-1')).toBe('');
  });

  it('recuerda la cuenta de cada tipo de operación por separado', () => {
    guardarUltimaCuenta('EXPENSE', 'cuenta-caja', 'unidad-1');
    guardarUltimaCuenta('INCOME', 'cuenta-banco', 'unidad-1');

    expect(leerUltimaCuenta('EXPENSE', 'unidad-1')).toBe('cuenta-caja');
    expect(leerUltimaCuenta('INCOME', 'unidad-1')).toBe('cuenta-banco');
  });

  it('no mezcla unidades distintas aunque sea la misma operación', () => {
    guardarUltimaCuenta('EXPENSE', 'cuenta-caja', 'unidad-a');
    guardarUltimaCuenta('EXPENSE', 'cuenta-personal', 'unidad-b');

    expect(leerUltimaCuenta('EXPENSE', 'unidad-a')).toBe('cuenta-caja');
    expect(leerUltimaCuenta('EXPENSE', 'unidad-b')).toBe('cuenta-personal');
  });

  it('ignora un valor guardado corrupto en vez de romper el formulario', () => {
    window.localStorage.setItem('finanza:ultimaCuenta', 'esto-no-es-json');
    expect(leerUltimaCuenta('EXPENSE', 'unidad-1')).toBe('');
  });

  it('ignora un mapa con valores que no son texto', () => {
    window.localStorage.setItem('finanza:ultimaCuenta', JSON.stringify({ 'EXPENSE:unidad-1': { id: 'x' } }));
    expect(leerUltimaCuenta('EXPENSE', 'unidad-1')).toBe('');
  });

  it('no guarda nada si la cuenta está vacía', () => {
    guardarUltimaCuenta('EXPENSE', '', 'unidad-1');
    expect(leerUltimaCuenta('EXPENSE', 'unidad-1')).toBe('');
  });

  it('sigue funcionando si el navegador no deja escribir (modo privado)', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    try {
      // No debe lanzar: perder la preferencia no puede impedir registrar el gasto.
      expect(() => guardarUltimaCuenta('EXPENSE', 'cuenta-caja', 'unidad-1')).not.toThrow();
    } finally {
      setItem.mockRestore();
    }

    expect(leerUltimaCuenta('EXPENSE', 'unidad-1')).toBe('');
  });
});
