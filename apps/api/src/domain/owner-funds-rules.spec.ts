import { describe, expect, it } from '@jest/globals';
import { ownerFundsPostings } from './owner-funds-rules.js';

/**
 * «DINERO PARA MÍ»: LAS DOS NATURALEZAS
 * ------------------------------------
 * Lo que se protege:
 *
 *  1. Los dos asientos están CUADRADOS.
 *  2. **Ninguno toca ingresos ni gastos**: sacar dinero de tu empresa no es
 *     ganar dinero, en ninguna de las dos unidades.
 *  3. En «es mi dinero» el patrimonio personal **no cambia**: baja la
 *     participación en la empresa (1230) y sube el banco lo mismo.
 *  4. En «es un préstamo» nace una deuda real (2202) espejo del préstamo
 *     otorgado por la empresa (1250).
 */

const suma = (lineas: Array<{ debit?: unknown; credit?: unknown }>, lado: 'debit' | 'credit') =>
  lineas.reduce((total, linea) => total + Number(linea[lado] ?? 0), 0);

const base = {
  amount: '5000.00',
  sourceLedgerCode: '1102',
  sourceAccountId: 'banco-empresa',
  targetLedgerCode: '1102',
  targetAccountId: 'banco-personal',
};

describe('es mi dinero (retiro del propietario)', () => {
  const postings = ownerFundsPostings({ ...base, nature: 'WITHDRAWAL' });

  it('la empresa baja el banco contra retiros del propietario', () => {
    expect(postings.source).toEqual([
      expect.objectContaining({ ledgerCode: '3200', debit: expect.anything() }),
      expect.objectContaining({ ledgerCode: '1102', credit: expect.anything() }),
    ]);
  });

  it('su cuenta personal sube y baja su participación en la empresa', () => {
    expect(postings.target).toEqual([
      expect.objectContaining({ ledgerCode: '1102', debit: expect.anything() }),
      expect.objectContaining({ ledgerCode: '1230', credit: expect.anything() }),
    ]);
    expect(Number(postings.target[0].debit)).toBe(5000);
    expect(Number(postings.target[1].credit)).toBe(5000);
  });

  it('no aparece ninguna cuenta de resultado (ni ingreso ni gasto)', () => {
    for (const linea of [...postings.source, ...postings.target]) {
      const esResultado = /^[4-7]/.test(linea.ledgerCode);
      expect({ cuenta: linea.ledgerCode, esResultado }).toEqual({ cuenta: linea.ledgerCode, esResultado: false });
    }
  });

  it('el patrimonio personal no cambia: banco arriba = participación abajo', () => {
    expect(Number(postings.target[0].debit)).toBe(Number(postings.target[1].credit));
  });

  it('los dos asientos están cuadrados', () => {
    expect(suma(postings.source, 'debit')).toBe(suma(postings.source, 'credit'));
    expect(suma(postings.target, 'debit')).toBe(suma(postings.target, 'credit'));
  });
});

describe('la empresa me lo presta', () => {
  const postings = ownerFundsPostings({ ...base, nature: 'LOAN' });

  it('la empresa reconoce un préstamo otorgado, no un gasto', () => {
    expect(postings.source).toEqual([
      expect.objectContaining({ ledgerCode: '1250', debit: expect.anything() }),
      expect.objectContaining({ ledgerCode: '1102', credit: expect.anything() }),
    ]);
  });

  it('el propietario reconoce la deuda, no un ingreso', () => {
    expect(postings.target).toEqual([
      expect.objectContaining({ ledgerCode: '1102', debit: expect.anything() }),
      expect.objectContaining({ ledgerCode: '2202', credit: expect.anything() }),
    ]);
  });

  it('tampoco hay cuentas de resultado en ningún lado', () => {
    for (const linea of [...postings.source, ...postings.target]) {
      expect(/^[4-7]/.test(linea.ledgerCode)).toBe(false);
    }
  });

  it('los dos asientos están cuadrados', () => {
    expect(suma(postings.source, 'debit')).toBe(suma(postings.source, 'credit'));
    expect(suma(postings.target, 'debit')).toBe(suma(postings.target, 'credit'));
  });
});

describe('validaciones', () => {
  it('rechaza importes no positivos', () => {
    expect(() => ownerFundsPostings({ ...base, amount: '0', nature: 'WITHDRAWAL' })).toThrow();
    expect(() => ownerFundsPostings({ ...base, amount: '-100', nature: 'LOAN' })).toThrow();
  });
});
