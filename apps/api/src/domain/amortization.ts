import { DateTime } from 'luxon';
import { dec, mul, round2, type DecimalInput } from './money.js';
import { addBusinessMonths, addBusinessDays, daysBetween } from './business-date.js';
import type { InterestType, PaymentFrequency } from '../generated/prisma/enums.js';

/**
 * CÁLCULOS DE PRÉSTAMOS
 * ---------------------
 * Regla del proyecto: NO se inventan condiciones. Si no se conoce la tasa, el
 * sistema no calcula intereses; se registra lo que el usuario indique.
 *
 * El reparto de un pago se hace SIEMPRE en este orden y con estos criterios:
 *   1. Intereses devengados (si se conoce la tasa).
 *   2. Penalidades y comisiones indicadas.
 *   3. Capital (el resto).
 * Y el resultado se devuelve para que el usuario lo vea antes de confirmar.
 */

export const FREQUENCY_PERIODS_PER_YEAR: Record<PaymentFrequency, number> = {
  ONE_TIME: 1,
  WEEKLY: 52,
  BIWEEKLY: 26,
  MONTHLY: 12,
  QUARTERLY: 4,
  SEMIANNUAL: 2,
  ANNUAL: 1,
};

export const FREQUENCY_DAYS: Record<PaymentFrequency, number> = {
  ONE_TIME: 0,
  WEEKLY: 7,
  BIWEEKLY: 14,
  MONTHLY: 30,
  QUARTERLY: 91,
  SEMIANNUAL: 182,
  ANNUAL: 365,
};

export function periodsPerYear(frequency: PaymentFrequency): number {
  return FREQUENCY_PERIODS_PER_YEAR[frequency] ?? 12;
}

export function addPeriods(date: Date, frequency: PaymentFrequency, periods: number): Date {
  switch (frequency) {
    case 'WEEKLY':
      return addBusinessDays(date, 7 * periods);
    case 'BIWEEKLY':
      return addBusinessDays(date, 14 * periods);
    case 'MONTHLY':
      return addBusinessMonths(date, periods);
    case 'QUARTERLY':
      return addBusinessMonths(date, 3 * periods);
    case 'SEMIANNUAL':
      return addBusinessMonths(date, 6 * periods);
    case 'ANNUAL':
      return addBusinessMonths(date, 12 * periods);
    case 'ONE_TIME':
    default:
      return date;
  }
}

/** Interés simple devengado por un saldo durante un número de días. */
export function simpleInterestForDays(balance: DecimalInput, annualRatePct: DecimalInput, days: number): ReturnType<typeof dec> {
  if (days <= 0) {
    return dec(0);
  }
  const rate = dec(annualRatePct).dividedBy(100);
  return round2(mul(balance, rate).times(days).dividedBy(365));
}

/** Cuota fija (sistema francés) para interés compuesto / cuota fija. */
export function fixedInstallment(
  principal: DecimalInput,
  annualRatePct: DecimalInput,
  installmentCount: number,
  frequency: PaymentFrequency,
): ReturnType<typeof dec> {
  const periods = installmentCount;
  if (periods <= 0) {
    return dec(0);
  }
  const periodRate = dec(annualRatePct).dividedBy(100).dividedBy(periodsPerYear(frequency));
  if (periodRate.isZero()) {
    return round2(dec(principal).dividedBy(periods));
  }
  const factor = periodRate.plus(1).pow(periods);
  const payment = dec(principal).times(periodRate).times(factor).dividedBy(factor.minus(1));
  return round2(payment);
}

export interface ScheduleRow {
  period: number;
  dueDate: Date;
  payment: ReturnType<typeof dec>;
  interest: ReturnType<typeof dec>;
  principal: ReturnType<typeof dec>;
  balance: ReturnType<typeof dec>;
}

/**
 * Cuadro de amortización proyectado (INFORMATIVO).
 * No altera la base de datos: sirve para que el usuario vea qué le espera y
 * para generar los vencimientos de las obligaciones recurrentes.
 */
export function buildSchedule(params: {
  principal: DecimalInput;
  annualRatePct?: DecimalInput | null;
  installmentAmount?: DecimalInput | null;
  installmentCount: number;
  frequency: PaymentFrequency;
  firstDueDate: Date;
  interestType?: InterestType;
}): ScheduleRow[] {
  const {
    principal,
    annualRatePct,
    installmentAmount,
    installmentCount,
    frequency,
    firstDueDate,
    interestType = 'NONE',
  } = params;

  const rows: ScheduleRow[] = [];
  let balance = dec(principal);
  const periods = installmentCount;

  const paymentPerPeriod =
    installmentAmount && dec(installmentAmount).greaterThan(0)
      ? dec(installmentAmount)
      : interestType === 'FIXED_INSTALLMENT' || interestType === 'COMPOUND'
        ? fixedInstallment(principal, annualRatePct ?? 0, periods, frequency)
        : round2(dec(principal).dividedBy(periods));

  const daysPerPeriod = FREQUENCY_DAYS[frequency] || 30;

  for (let period = 1; period <= periods; period += 1) {
    if (balance.isZero() || balance.isNegative()) {
      break;
    }

    const interest =
      annualRatePct && interestType !== 'NONE'
        ? simpleInterestForDays(balance, annualRatePct, daysPerPeriod)
        : dec(0);

    let principalPortion = round2(paymentPerPeriod.minus(interest));
    if (principalPortion.isNegative() || principalPortion.isZero()) {
      // La cuota no cubre ni los intereses: se avisa en lugar de inventar.
      principalPortion = dec(0);
    }
    if (principalPortion.greaterThan(balance)) {
      principalPortion = balance;
    }

    const newBalance = round2(balance.minus(principalPortion));
    rows.push({
      period,
      dueDate: addPeriods(firstDueDate, frequency, period - 1),
      payment: round2(principalPortion.plus(interest)),
      interest,
      principal: principalPortion,
      balance: newBalance.isNegative() ? dec(0) : newBalance,
    });

    balance = newBalance;
  }

  return rows;
}

export interface PaymentAllocation {
  interest: ReturnType<typeof dec>;
  fees: ReturnType<typeof dec>;
  penalties: ReturnType<typeof dec>;
  principal: ReturnType<typeof dec>;
  total: ReturnType<typeof dec>;
  remainingBalance: ReturnType<typeof dec>;
  warnings: string[];
}

/**
 * Reparte un pago entre intereses, comisiones, penalidades y capital.
 * Si el usuario indica explícitamente los componentes, se respetan tal cual.
 */
export function allocatePayment(params: {
  currentBalance: DecimalInput;
  totalAmount: DecimalInput;
  annualRatePct?: DecimalInput | null;
  interestFromDate?: Date | null;
  paymentDate: Date;
  explicitPrincipal?: DecimalInput | null;
  explicitInterest?: DecimalInput | null;
  feeAmount?: DecimalInput | null;
  penaltyAmount?: DecimalInput | null;
}): PaymentAllocation {
  const warnings: string[] = [];
  const balance = dec(params.currentBalance);
  const total = round2(params.totalAmount);
  const fees = round2(params.feeAmount ?? 0);
  const penalties = round2(params.penaltyAmount ?? 0);

  const explicitPrincipal = params.explicitPrincipal ? round2(params.explicitPrincipal) : null;
  const explicitInterest = params.explicitInterest ? round2(params.explicitInterest) : null;

  let interest: ReturnType<typeof dec>;
  if (explicitInterest) {
    interest = explicitInterest;
  } else if (params.annualRatePct && params.interestFromDate) {
    const days = Math.max(0, daysBetween(params.interestFromDate, params.paymentDate));
    interest = simpleInterestForDays(balance, params.annualRatePct, days);
  } else {
    interest = dec(0);
    if (params.annualRatePct === null || params.annualRatePct === undefined) {
      warnings.push('El préstamo no tiene tasa registrada: no se calcularon intereses automáticamente.');
    }
  }

  let principal = explicitPrincipal ?? round2(total.minus(interest).minus(fees).minus(penalties));

  if (principal.isNegative()) {
    // El pago no alcanza ni para cubrir intereses y comisiones.
    interest = round2(total.minus(fees).minus(penalties));
    principal = dec(0);
    warnings.push(
      'El pago no cubre los intereses y comisiones: se aplicó todo a intereses y nada a capital. Confirme el reparto.',
    );
  }

  if (principal.greaterThan(balance)) {
    warnings.push(
      `El capital del pago (${principal.toFixed(2)}) supera el saldo pendiente (${balance.toFixed(2)}). ` +
        'Ajuste el importe o indique explícitamente cuánto va a intereses.',
    );
    principal = balance;
  }

  const remainingBalance = round2(balance.minus(principal));

  return {
    interest,
    fees,
    penalties,
    principal,
    total,
    remainingBalance,
    warnings,
  };
}

/** Días transcurridos entre dos fechas de negocio. */
export function interestDays(from: Date, to: Date): number {
  return Math.max(0, daysBetween(from, to));
}

/** Próximo vencimiento según la frecuencia, a partir de una fecha dada. */
export function nextDueDate(from: Date, frequency: PaymentFrequency): Date {
  if (frequency === 'ONE_TIME') {
    return from;
  }
  return addPeriods(from, frequency, 1);
}

/** Fecha de hoy en la zona de negocio, útil para vencimientos. */
export function today(): Date {
  const now = DateTime.now().setZone(process.env.BUSINESS_TIMEZONE ?? 'America/Santo_Domingo');
  return new Date(Date.UTC(now.year, now.month - 1, now.day));
}
