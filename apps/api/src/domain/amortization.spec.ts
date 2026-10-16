import {
  allocatePayment,
  buildSchedule,
  fixedInstallment,
  nextDueDate,
  periodsPerYear,
  simpleInterestForDays,
} from './amortization.js';
import { parseBusinessDateIso, businessDateToIso } from './business-date.js';

describe('Cálculos de préstamos (domain/amortization)', () => {
  it('no calcula intereses si el préstamo no tiene tasa', () => {
    expect(simpleInterestForDays('10000', 0, 30).toFixed(2)).toBe('0.00');
  });

  it('calcula el interés simple por días (base 365)', () => {
    // 100.000 al 12% anual durante 30 días = 100000 * 0.12 * 30/365 = 986.30
    expect(simpleInterestForDays('100000', '12', 30).toFixed(2)).toBe('986.30');
  });

  it('devuelve 0 intereses si no han pasado días', () => {
    expect(simpleInterestForDays('100000', '12', 0).toFixed(2)).toBe('0.00');
  });

  it('conoce los períodos por año de cada frecuencia', () => {
    expect(periodsPerYear('WEEKLY')).toBe(52);
    expect(periodsPerYear('BIWEEKLY')).toBe(26);
    expect(periodsPerYear('MONTHLY')).toBe(12);
    expect(periodsPerYear('ANNUAL')).toBe(1);
  });

  it('calcula la cuota fija (sistema francés)', () => {
    // 100.000 al 24% anual a 12 meses ≈ 9.455,96
    const payment = fixedInstallment('100000', '24', 12, 'MONTHLY');
    expect(Number(payment.toFixed(2))).toBeGreaterThan(9400);
    expect(Number(payment.toFixed(2))).toBeLessThan(9500);
  });

  it('sin interés, la cuota fija es el capital entre el número de cuotas', () => {
    expect(fixedInstallment('12000', 0, 12, 'MONTHLY').toFixed(2)).toBe('1000.00');
  });

  it('el cuadro de amortización termina en saldo cero', () => {
    const rows = buildSchedule({
      principal: '12000',
      annualRatePct: '0',
      installmentCount: 12,
      frequency: 'MONTHLY',
      firstDueDate: parseBusinessDateIso('2026-01-15'),
      interestType: 'NONE',
    });

    expect(rows).toHaveLength(12);
    expect(rows[rows.length - 1].balance.toFixed(2)).toBe('0.00');
    expect(rows.reduce((acc, row) => acc + Number(row.principal.toFixed(2)), 0)).toBeCloseTo(12000, 2);
  });

  it('el cuadro con interés reparte capital e intereses y termina en cero', () => {
    const rows = buildSchedule({
      principal: '100000',
      annualRatePct: '24',
      installmentCount: 12,
      frequency: 'MONTHLY',
      firstDueDate: parseBusinessDateIso('2026-01-15'),
      interestType: 'FIXED_INSTALLMENT',
    });

    const totalInterest = rows.reduce((acc, row) => acc + Number(row.interest.toFixed(2)), 0);
    const totalPrincipal = rows.reduce((acc, row) => acc + Number(row.principal.toFixed(2)), 0);

    expect(totalInterest).toBeGreaterThan(0);
    expect(totalPrincipal).toBeCloseTo(100000, 2);
    expect(rows[rows.length - 1].balance.toFixed(2)).toBe('0.00');
  });

  describe('allocatePayment() — reparto de un pago', () => {
    it('aplica primero intereses y el resto a capital', () => {
      const allocation = allocatePayment({
        currentBalance: '100000',
        totalAmount: '10000',
        annualRatePct: '12',
        interestFromDate: parseBusinessDateIso('2026-01-01'),
        paymentDate: parseBusinessDateIso('2026-01-31'),
      });

      // 30 días de interés simple sobre 100.000 al 12% ≈ 986.30
      expect(Number(allocation.interest.toFixed(2))).toBeCloseTo(986.3, 1);
      expect(Number(allocation.principal.toFixed(2))).toBeCloseTo(9013.7, 1);
      expect(Number(allocation.total.toFixed(2))).toBeCloseTo(10000, 2);
    });

    it('respeta el reparto indicado por el usuario', () => {
      const allocation = allocatePayment({
        currentBalance: '50000',
        totalAmount: '5000',
        explicitPrincipal: '4000',
        explicitInterest: '1000',
        paymentDate: parseBusinessDateIso('2026-02-01'),
      });

      expect(allocation.principal.toFixed(2)).toBe('4000.00');
      expect(allocation.interest.toFixed(2)).toBe('1000.00');
    });

    it('no deja que el capital supere el saldo pendiente y avisa', () => {
      const allocation = allocatePayment({
        currentBalance: '1000',
        totalAmount: '5000',
        paymentDate: parseBusinessDateIso('2026-02-01'),
      });

      expect(allocation.principal.toFixed(2)).toBe('1000.00');
      expect(allocation.remainingBalance.toFixed(2)).toBe('0.00');
    });

    it('avisa cuando el pago no cubre ni los intereses', () => {
      const allocation = allocatePayment({
        currentBalance: '1000000',
        totalAmount: '100',
        annualRatePct: '24',
        interestFromDate: parseBusinessDateIso('2026-01-01'),
        paymentDate: parseBusinessDateIso('2026-06-01'),
      });

      expect(allocation.principal.toFixed(2)).toBe('0.00');
      expect(allocation.warnings.length).toBeGreaterThan(0);
    });

    it('avisa cuando no hay tasa registrada y por tanto no calcula intereses', () => {
      const allocation = allocatePayment({
        currentBalance: '10000',
        totalAmount: '1000',
        annualRatePct: null,
        paymentDate: parseBusinessDateIso('2026-02-01'),
      });

      expect(allocation.interest.toFixed(2)).toBe('0.00');
      expect(allocation.warnings.join(' ')).toMatch(/no tiene tasa registrada/i);
    });
  });

  it('calcula el siguiente vencimiento según la frecuencia', () => {
    const due = parseBusinessDateIso('2026-01-15');
    expect(businessDateToIso(nextDueDate(due, 'MONTHLY'))).toBe('2026-02-15');
    expect(businessDateToIso(nextDueDate(due, 'WEEKLY'))).toBe('2026-01-22');
    expect(businessDateToIso(nextDueDate(due, 'QUARTERLY'))).toBe('2026-04-15');
  });
});
