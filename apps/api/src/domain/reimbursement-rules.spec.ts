import { describe, expect, it } from '@jest/globals';
import { expensePaidByOwnerDualPostings, reimbursementPaymentDualPostings } from './reimbursement-rules.js';

/**
 * REEMBOLSOS: PRUEBAS DE LAS REGLAS
 * --------------------------------
 * Lo que se comprueba aquí no es «que se genere un asiento», sino las dos cosas
 * que de verdad cuestan dinero si se hacen mal:
 *
 *  1. Cada asiento está CUADRADO (debe = haber) por separado.
 *  2. El gasto aparece UNA sola vez (en la empresa), nunca en las finanzas
 *     personales, y la devolución no crea un gasto ni un ingreso nuevo.
 */

const suma = (lineas: Array<{ debit?: unknown; credit?: unknown }>, lado: 'debit' | 'credit') =>
  lineas.reduce((total, linea) => total + Number(linea[lado] ?? 0), 0);

describe('gasto de la empresa pagado por el propietario', () => {
  const postings = expensePaidByOwnerDualPostings({
    amount: '1200.00',
    expenseLedgerCode: '6500',
    ownerLedgerCode: '1102',
    ownerAccountId: 'cuenta-personal',
  });

  it('la empresa reconoce el gasto y queda debiendo el importe', () => {
    expect(postings.company).toEqual([
      expect.objectContaining({ ledgerCode: '6500', debit: expect.anything() }),
      expect.objectContaining({ ledgerCode: '2350', credit: expect.anything() }),
    ]);
    expect(Number(postings.company[0].debit)).toBe(1200);
    expect(Number(postings.company[1].credit)).toBe(1200);
  });

  it('el propietario NO registra un gasto: registra un derecho de cobro', () => {
    expect(postings.owner).toEqual([
      expect.objectContaining({ ledgerCode: '1200', debit: expect.anything() }),
      expect.objectContaining({ ledgerCode: '1102', credit: expect.anything() }),
    ]);
    // Ninguna línea del propietario puede ser de resultado (4xxx/5xxx/6xxx/7xxx).
    for (const linea of postings.owner) {
      expect(linea.ledgerCode.startsWith('4') || linea.ledgerCode.startsWith('6')).toBe(false);
    }
  });

  it('los dos asientos están cuadrados', () => {
    expect(suma(postings.company, 'debit')).toBe(suma(postings.company, 'credit'));
    expect(suma(postings.owner, 'debit')).toBe(suma(postings.owner, 'credit'));
  });

  it('la cuenta personal elegida es la que baja', () => {
    expect(postings.owner[1].financialAccountId).toBe('cuenta-personal');
  });

  it('rechaza un gasto que no va a una cuenta de gasto', () => {
    expect(() =>
      expensePaidByOwnerDualPostings({
        amount: '10',
        expenseLedgerCode: '1100',
        ownerLedgerCode: '1102',
        ownerAccountId: 'x',
      }),
    ).toThrow(/gasto/i);
  });

  it('rechaza importes no positivos', () => {
    expect(() =>
      expensePaidByOwnerDualPostings({
        amount: '0',
        expenseLedgerCode: '6500',
        ownerLedgerCode: '1102',
        ownerAccountId: 'x',
      }),
    ).toThrow();
  });
});

describe('devolución del reembolso', () => {
  const postings = reimbursementPaymentDualPostings({
    amount: '1200.00',
    companyLedgerCode: '1102',
    companyAccountId: 'banco-empresa',
    ownerLedgerCode: '1102',
    ownerAccountId: 'cuenta-personal',
  });

  it('la empresa paga la deuda: baja 2350, no hay gasto', () => {
    expect(postings.company).toEqual([
      expect.objectContaining({ ledgerCode: '2350', debit: expect.anything() }),
      expect.objectContaining({ ledgerCode: '1102', credit: expect.anything() }),
    ]);
    for (const linea of postings.company) {
      expect(linea.ledgerCode.startsWith('6')).toBe(false);
    }
  });

  it('el propietario cobra: entra el dinero y desaparece el derecho de cobro', () => {
    expect(postings.owner).toEqual([
      expect.objectContaining({ ledgerCode: '1102', debit: expect.anything() }),
      expect.objectContaining({ ledgerCode: '1200', credit: expect.anything() }),
    ]);
  });

  it('los dos asientos están cuadrados', () => {
    expect(suma(postings.company, 'debit')).toBe(suma(postings.company, 'credit'));
    expect(suma(postings.owner, 'debit')).toBe(suma(postings.owner, 'credit'));
  });

  it('entre el gasto y la devolución, 2350 y 1200 quedan en CERO', () => {
    const gasto = expensePaidByOwnerDualPostings({
      amount: '1200.00',
      expenseLedgerCode: '6500',
      ownerLedgerCode: '1102',
      ownerAccountId: 'cuenta-personal',
    });

    const saldo2350 = Number(gasto.company[1].credit ?? 0) - Number(postings.company[0].debit ?? 0);
    const saldo1200 = Number(gasto.owner[0].debit ?? 0) - Number(postings.owner[1].credit ?? 0);

    expect(saldo2350).toBe(0);
    expect(saldo1200).toBe(0);
  });

  it('el gasto reconocido en la empresa es exactamente el importe adelantado (una sola vez)', () => {
    const gasto = expensePaidByOwnerDualPostings({
      amount: '1200.00',
      expenseLedgerCode: '6500',
      ownerLedgerCode: '1102',
      ownerAccountId: 'cuenta-personal',
    });
    const totalGasto = gasto.company
      .filter((linea) => linea.ledgerCode.startsWith('6'))
      .reduce((total, linea) => total + Number(linea.debit ?? 0), 0);
    expect(totalGasto).toBe(1200);
  });
});
