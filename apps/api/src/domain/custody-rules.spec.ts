import { dec } from './money.js';
import {
  allocateToFunds,
  collectionPostings,
  expenseFromCustodyPostings,
  expensePaidByOwnerPostings,
  fundStatus,
  settlementPostings,
} from './custody-rules.js';

/**
 * REGLAS DE CUSTODIA (dinero de la empresa en cuentas personales)
 * ===============================================================
 * Lo que se comprueba aquí es la parte que, si está mal, arruina los informes:
 * que cada operación cuadre, que el ingreso se reconozca UNA vez, que la
 * liquidación no cree ingresos ni gastos, y que nunca se pueda liquidar más de lo
 * que hay pendiente.
 *
 * Cada asiento se comprueba como se mira en contabilidad: débitos = créditos.
 */

const monto = (value: unknown) => dec((value ?? 0) as never).toFixed(2);

const total = (lines: Array<{ debit?: unknown; credit?: unknown }>, side: 'debit' | 'credit') =>
  lines.reduce((acc, l) => acc.plus(dec(((side === 'debit' ? l.debit : l.credit) ?? 0) as never)), dec(0));

const assertCuadra = (lines: Array<{ debit?: unknown; credit?: unknown }>, nombre: string) => {
  expect(`${nombre}: ${total(lines, 'debit').toFixed(2)}`).toBe(`${nombre}: ${total(lines, 'credit').toFixed(2)}`);
};

const cuenta = <T extends { ledgerCode: string }>(lines: T[], code: string): T[] => lines.filter((l) => l.ledgerCode === code);

describe('cobro de una empresa en una cuenta personal', () => {
  it('reconoce el ingreso en la empresa y el banco real en la unidad que custodia (caso Fulltech → Banreservas)', () => {
    const { beneficiary, holding } = collectionPostings({
      amount: '5000.00',
      holdingLedgerCode: '1100', // banco
      contrapartidaCode: '4100', // ingresos por ventas
      holdingAccountId: 'cuenta-banreservas-personal',
      memo: 'Venta de equipos',
    });

    // Empresa dueña: ACTIVO en custodia (1130) contra ingreso.
    expect(beneficiary).toHaveLength(2);
    expect(cuenta(beneficiary, '1130')[0].debit!.toFixed(2)).toBe('5000.00');
    expect(cuenta(beneficiary, '4100')[0].credit!.toFixed(2)).toBe('5000.00');
    assertCuadra(beneficiary, 'empresa dueña');

    // Quien custodia: sube el banco de verdad y sube la deuda con la empresa.
    expect(holding).toHaveLength(2);
    expect(cuenta(holding, '1100')[0].debit!.toFixed(2)).toBe('5000.00');
    expect(cuenta(holding, '1100')[0].financialAccountId).toBe('cuenta-banreservas-personal');
    expect(cuenta(holding, '2150')[0].credit!.toFixed(2)).toBe('5000.00');
    assertCuadra(holding, 'unidad que custodia');

    // Lo esencial: el propietario NO tiene un ingreso por esto.
    expect(cuenta(holding, '4100')).toHaveLength(0);
  });

  it('si la factura ya estaba contabilizada, cobra contra cuentas por cobrar y NO reconoce ingreso otra vez', () => {
    const { beneficiary } = collectionPostings({
      amount: '2500.00',
      holdingLedgerCode: '1102',
      contrapartidaCode: '1210', // cuentas por cobrar
      holdingAccountId: 'cuenta-bhd-personal',
    });

    expect(cuenta(beneficiary, '1130')[0].debit!.toFixed(2)).toBe('2500.00');
    expect(cuenta(beneficiary, '1210')[0].credit!.toFixed(2)).toBe('2500.00');
    // Ninguna cuenta de ingresos (4xxx) se toca.
    expect(beneficiary.filter((l) => l.ledgerCode.startsWith('4'))).toHaveLength(0);
    assertCuadra(beneficiary, 'cobro de factura');
  });

  it('rechaza importes de cero o negativos', () => {
    expect(() =>
      collectionPostings({ amount: '0', holdingLedgerCode: '1100', contrapartidaCode: '4100', holdingAccountId: 'x' }),
    ).toThrow(/mayor que cero/i);
  });
});

describe('liquidación (total o parcial)', () => {
  it('mueve el dinero de la custodia a la cuenta de la empresa sin crear ingreso ni gasto', () => {
    const { beneficiary, holding } = settlementPostings({
      amount: '3000.00',
      holdingLedgerCode: '1100',
      targetLedgerCode: '1100',
      holdingAccountId: 'cuenta-banreservas-personal',
      targetAccountId: 'cuenta-fulltech-principal',
    });

    // Quien custodia: baja la deuda y sale el dinero del banco.
    expect(cuenta(holding, '2150')[0].debit!.toFixed(2)).toBe('3000.00');
    expect(cuenta(holding, '1100')[0].credit!.toFixed(2)).toBe('3000.00');
    assertCuadra(holding, 'salida de custodia');

    // Empresa dueña: entra el dinero y baja su activo en custodia.
    expect(cuenta(beneficiary, '1100')[0].debit!.toFixed(2)).toBe('3000.00');
    expect(cuenta(beneficiary, '1100')[0].financialAccountId).toBe('cuenta-fulltech-principal');
    expect(cuenta(beneficiary, '1130')[0].credit!.toFixed(2)).toBe('3000.00');
    assertCuadra(beneficiary, 'entrada en la empresa');

    // Ni ingresos (4xxx) ni gastos (5xxx/6xxx).
    const resultado = [...beneficiary, ...holding].filter((l) => /^[456]/.test(l.ledgerCode));
    expect(resultado).toHaveLength(0);
  });
});

describe('gastos', () => {
  it('un gasto de la empresa pagado con dinero en custodia baja la custodia y NO se cuenta como gasto personal', () => {
    const { beneficiary, holding } = expenseFromCustodyPostings({
      amount: '2000.00',
      expenseLedgerCode: '6300',
      holdingLedgerCode: '1100',
      holdingAccountId: 'cuenta-banreservas-personal',
    });

    expect(cuenta(beneficiary, '6300')[0].debit!.toFixed(2)).toBe('2000.00');
    expect(cuenta(beneficiary, '1130')[0].credit!.toFixed(2)).toBe('2000.00');
    assertCuadra(beneficiary, 'gasto de la empresa');

    expect(cuenta(holding, '2150')[0].debit!.toFixed(2)).toBe('2000.00');
    expect(cuenta(holding, '1100')[0].credit!.toFixed(2)).toBe('2000.00');
    assertCuadra(holding, 'salida del banco personal');

    // El propietario no registra ningún gasto (6xxx) en su unidad.
    expect(holding.filter((l) => l.ledgerCode.startsWith('6'))).toHaveLength(0);
  });

  it('un gasto pagado con dinero propio del propietario genera deuda de reembolso, no custodia', () => {
    const lines = expensePaidByOwnerPostings({ amount: '800.00', expenseLedgerCode: '6350' });

    expect(cuenta(lines, '6350')[0].debit!.toFixed(2)).toBe('800.00');
    expect(cuenta(lines, '2350')[0].credit!.toFixed(2)).toBe('800.00');
    assertCuadra(lines, 'gasto pagado por el propietario');
    // No hay movimiento bancario ni se toca la custodia.
    expect(lines.every((l) => !l.ledgerCode.startsWith('11'))).toBe(true);
    expect(cuenta(lines, '2150')).toHaveLength(0);
  });
});

describe('reparto de una liquidación entre cobros (parcial y agrupada)', () => {
  const fondos = [
    {
      id: 'viejo',
      originalAmount: '5000.00',
      appliedAmount: '0.00',
      businessDate: new Date('2026-10-01'),
      createdAt: new Date('2026-10-01T12:00:00Z'),
    },
    {
      id: 'nuevo',
      originalAmount: '1200.00',
      appliedAmount: '0.00',
      businessDate: new Date('2026-10-15'),
      createdAt: new Date('2026-10-15T12:00:00Z'),
    },
  ];

  it('una liquidación parcial deja el cobro en PARTIAL y conserva el resto pendiente', () => {
    const [allocation] = allocateToFunds(fondos, '3000.00');

    expect(allocation.fundId).toBe('viejo');
    expect(allocation.amount.toFixed(2)).toBe('3000.00');
    expect(allocation.newApplied.toFixed(2)).toBe('3000.00');
    expect(allocation.status).toBe('PARTIAL');
  });

  it('una liquidación agrupada cubre varios cobros, del más antiguo al más nuevo', () => {
    const allocations = allocateToFunds(fondos, '5600.00');

    expect(allocations).toHaveLength(2);
    expect(allocations[0]).toMatchObject({ fundId: 'viejo', status: 'SETTLED' });
    expect(allocations[0].amount.toFixed(2)).toBe('5000.00');
    expect(allocations[1]).toMatchObject({ fundId: 'nuevo', status: 'PARTIAL' });
    expect(allocations[1].amount.toFixed(2)).toBe('600.00');
  });

  it('nunca permite liquidar más de lo pendiente (evita saldos negativos)', () => {
    expect(() => allocateToFunds(fondos, '6200.01')).toThrow(/sólo hay 6200\.00 pendiente/i);
  });

  it('no reparte nada si el cobro ya está liquidado', () => {
    const liquidado = [{ ...fondos[0], appliedAmount: '5000.00' }];
    expect(() => allocateToFunds(liquidado, '1.00')).toThrow(/pendiente/i);
  });

  it('el estado del cobro refleja exactamente lo aplicado', () => {
    expect(fundStatus('5000.00', '0.00')).toBe('OPEN');
    expect(fundStatus('5000.00', '4999.99')).toBe('PARTIAL');
    expect(fundStatus('5000.00', '5000.00')).toBe('SETTLED');
  });
});
