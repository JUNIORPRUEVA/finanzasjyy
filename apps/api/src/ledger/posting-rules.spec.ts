import { buildPostingLines, assertExpenseAccount, assertIncomeAccount } from './posting-rules.js';
import { InvariantError } from '../common/errors.js';
import { LEDGER } from '../domain/chart-of-accounts.js';

/**
 * Estas pruebas fijan las reglas que evitan confusiones contables clásicas:
 * ventas ≠ ganancias, ingresos ≠ entradas de dinero, préstamos ≠ ingresos,
 * retiros ≠ gastos.
 */
describe('Reglas de contabilización (ledger/posting-rules)', () => {
  const financialAccountId = 'acc-1';

  it('un INGRESO carga la cuenta de dinero y abona la cuenta de ingresos', () => {
    const lines = buildPostingLines({
      kind: 'INCOME',
      amount: '1000.00',
      financialLedgerCode: LEDGER.CASH,
      categoryLedgerCode: LEDGER.SALES_INCOME,
      financialAccountId,
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ ledgerCode: LEDGER.CASH, financialAccountId });
    expect(lines[0].debit?.toString()).toBe('1000');
    expect(lines[1]).toMatchObject({ ledgerCode: LEDGER.SALES_INCOME });
    expect(lines[1].credit?.toString()).toBe('1000');
  });

  it('un GASTO carga la cuenta de gastos y abona la cuenta de dinero', () => {
    const lines = buildPostingLines({
      kind: 'EXPENSE',
      amount: '250.50',
      financialLedgerCode: LEDGER.BANK,
      categoryLedgerCode: LEDGER.FUEL,
      financialAccountId,
    });

    expect(lines[0]).toMatchObject({ ledgerCode: LEDGER.FUEL });
    expect(lines[0].debit?.toFixed(2)).toBe('250.50');
    expect(lines[1]).toMatchObject({ ledgerCode: LEDGER.BANK, financialAccountId });
    expect(lines[1].credit?.toFixed(2)).toBe('250.50');
  });

  it('un RETIRO DEL PROPIETARIO no es un gasto del negocio (va a 3200)', () => {
    const lines = buildPostingLines({
      kind: 'OWNER_WITHDRAWAL',
      amount: '5000',
      financialLedgerCode: LEDGER.BANK,
      financialAccountId,
    });

    expect(lines.some((line) => line.ledgerCode === LEDGER.OWNER_WITHDRAWAL)).toBe(true);
    // No debe tocar ninguna cuenta de gastos.
    expect(lines.some((line) => line.ledgerCode === LEDGER.OTHER_OPERATING_EXPENSE)).toBe(false);
    expect(lines.some((line) => line.ledgerCode === LEDGER.FUEL)).toBe(false);
  });

  it('un PRÉSTAMO RECIBIDO no es un ingreso: entra dinero y sube la deuda', () => {
    const lines = buildPostingLines({
      kind: 'LOAN_DISBURSEMENT',
      amount: '50000',
      financialLedgerCode: LEDGER.BANK,
      financialAccountId,
    });

    expect(lines[0]).toMatchObject({ ledgerCode: LEDGER.BANK });
    expect(lines[0].debit?.toString()).toBe('50000');
    expect(lines[1]).toMatchObject({ ledgerCode: LEDGER.LOAN_PAYABLE });
    expect(lines[1].credit?.toString()).toBe('50000');
    // Crítico: NO toca ninguna cuenta de ingresos.
    expect(lines.some((line) => line.ledgerCode === LEDGER.SALES_INCOME)).toBe(false);
    expect(lines.some((line) => line.ledgerCode === LEDGER.OTHER_INCOME)).toBe(false);
  });

  it('pagar un préstamo baja la deuda y sale dinero (sin gasto de capital)', () => {
    const lines = buildPostingLines({
      kind: 'LOAN_PAYMENT',
      amount: '3000',
      financialLedgerCode: LEDGER.BANK,
      financialAccountId,
    });

    expect(lines[0]).toMatchObject({ ledgerCode: LEDGER.LOAN_PAYABLE });
    expect(lines[0].debit?.toString()).toBe('3000');
    expect(lines[1]).toMatchObject({ ledgerCode: LEDGER.BANK });
  });

  it('cobrar una cuenta por cobrar baja el activo por cobrar (no es ingreso nuevo)', () => {
    const lines = buildPostingLines({
      kind: 'RECEIVABLE_SETTLEMENT',
      amount: '1200',
      financialLedgerCode: LEDGER.CASH,
      counterpartyLedgerCode: '1210',
      financialAccountId,
    });

    expect(lines[1]).toMatchObject({ ledgerCode: '1210' });
    expect(lines.some((line) => line.ledgerCode === LEDGER.SALES_INCOME)).toBe(false);
  });

  it('el pago de una tarjeta de crédito baja el pasivo', () => {
    const lines = buildPostingLines({
      kind: 'CREDIT_CARD_PAYMENT',
      amount: '800',
      financialLedgerCode: LEDGER.BANK,
      financialAccountId,
    });

    expect(lines[0]).toMatchObject({ ledgerCode: LEDGER.CREDIT_CARD });
    expect(lines[0].debit?.toString()).toBe('800');
  });

  it('un ajuste exige indicar la cuenta que se carga y la que se abona', () => {
    expect(() =>
      buildPostingLines({
        kind: 'ADJUSTMENT',
        amount: '100',
        financialLedgerCode: LEDGER.CASH,
        financialAccountId,
      }),
    ).toThrow(/cuenta que se carga y la que se abona/);
  });

  it('las transferencias no se contabilizan con reglas simples', () => {
    expect(() =>
      buildPostingLines({
        kind: 'TRANSFER_OUT',
        amount: '100',
        financialLedgerCode: LEDGER.BANK,
      }),
    ).toThrow(InvariantError);
  });

  it('rechaza usar una cuenta de gastos como cuenta de ingresos', () => {
    expect(() => assertIncomeAccount(LEDGER.FUEL)).toThrow(/no es una cuenta de ingresos/);
    expect(() => assertExpenseAccount(LEDGER.SALES_INCOME)).toThrow(/no es una cuenta de gastos/);
  });

  it('la cuenta de agrupación 6000 no se puede usar directamente', () => {
    // 6000 es de agrupación: el error lo lanza el núcleo del libro al resolver el catálogo.
    expect(() => assertExpenseAccount('6000')).toThrow(InvariantError);
  });
});
