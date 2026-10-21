import { LEDGER } from './chart-of-accounts.js';
import { round2, type DecimalInput } from './money.js';
import { ValidationError } from '../common/errors.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { JournalLineInput } from '../ledger/ledger-core.js';

/**
 * REGLAS DE CUSTODIA: DINERO DE LA EMPRESA EN CUENTAS PERSONALES
 * =============================================================
 * Caso real: un cliente de FULLTECH paga RD$5,000 y los transfiere al Banreservas
 * PERSONAL del propietario. El dinero está en el banco (saldo real) pero no es del
 * propietario: es de la empresa, en custodia.
 *
 * La contabilidad debe decir tres cosas a la vez, y sólo estas:
 *   1. El banco tiene RD$5,000 de verdad.
 *   2. FULLTECH ganó RD$5,000 (ingreso) y ese dinero es un ACTIVO suyo (1130).
 *   3. El propietario debe RD$5,000 a la empresa: en su unidad es un PASIVO (2150).
 *
 * Cada operación genera DOS asientos, uno por unidad, y ninguno toca ingresos o
 * gastos de más. Este módulo es puro a propósito (sin base de datos, sin Nest):
 * así las reglas contables se prueban solas y no dependen de nada más.
 */

export interface CustodyPostings {
  /** Asiento de la empresa dueña del dinero (FULLTECH / APPYRA). */
  beneficiary: CustodyLine[];
  /** Asiento de la unidad que tiene el dinero físicamente (PERSONAL). */
  holding: CustodyLine[];
}

/** Línea de asiento con importes ya redondeados a 2 decimales. */
export interface CustodyLine {
  ledgerCode: string;
  debit?: Prisma.Decimal;
  credit?: Prisma.Decimal;
  memo?: string;
  financialAccountId?: string | null;
}

const line = (ledgerCode: string, side: 'debit' | 'credit', amount: DecimalInput, memo?: string, financialAccountId?: string | null): CustodyLine => ({
  ledgerCode,
  financialAccountId: financialAccountId ?? null,
  debit: side === 'debit' ? round2(amount) : undefined,
  credit: side === 'credit' ? round2(amount) : undefined,
  memo,
});

/**
 * COBRO de una empresa que entra en una cuenta de otra unidad.
 *
 *   Empresa dueña : D 1130 (efectivo de la empresa en poder del propietario) / C ingreso (o C 1210 si es cliente)
 *   Quien custodia: D banco (saldo real sube)                                  / C 2150 (debe ese dinero)
 *
 * `contrapartidaCode` decide si se reconoce un ingreso nuevo (4100…) o si sólo se
 * cobra una factura ya contabilizada (1210): en ese segundo caso NO hay ingreso.
 */
export function collectionPostings(input: {
  amount: DecimalInput;
  /** Cuenta contable de la cuenta real que recibe el dinero (1100, 1101, 1102…). */
  holdingLedgerCode: string;
  /** Ingreso (4100…) o cuentas por cobrar (1210) cuando la factura ya existía. */
  contrapartidaCode: string;
  holdingAccountId: string;
  memo?: string;
}): CustodyPostings {
  const amount = round2(input.amount);
  if (amount.lte(0)) {
    throw new ValidationError('El importe del cobro debe ser mayor que cero');
  }
  if (!input.contrapartidaCode) {
    throw new ValidationError('Falta indicar a qué corresponde el cobro (ingreso o cuenta por cobrar)');
  }

  return {
    beneficiary: [
      line(LEDGER.COMPANY_CASH_WITH_OWNER, 'debit', amount, input.memo),
      line(input.contrapartidaCode, 'credit', amount, input.memo),
    ],
    holding: [
      line(input.holdingLedgerCode, 'debit', amount, input.memo, input.holdingAccountId),
      line(LEDGER.CUSTODY_FUNDS, 'credit', amount, input.memo),
    ],
  };
}

/**
 * LIQUIDACIÓN: la empresa dueña recibe el dinero en su banco o caja.
 *
 *   Quien custodia: D 2150 (deja de deber) / C banco (sale el dinero de verdad)
 *   Empresa dueña : D banco o caja (entra)  / C 1130 (deja de tenerlo en custodia)
 *
 * No hay ingreso ni gasto: es un traslado de dinero, y la liquidación puede ser
 * parcial.
 */
export function settlementPostings(input: {
  amount: DecimalInput;
  holdingLedgerCode: string;
  targetLedgerCode: string;
  holdingAccountId: string;
  targetAccountId: string;
  memo?: string;
}): CustodyPostings {
  const amount = round2(input.amount);
  if (amount.lte(0)) {
    throw new ValidationError('El importe de la liquidación debe ser mayor que cero');
  }

  return {
    holding: [
      line(LEDGER.CUSTODY_FUNDS, 'debit', amount, input.memo),
      line(input.holdingLedgerCode, 'credit', amount, input.memo, input.holdingAccountId),
    ],
    beneficiary: [
      line(input.targetLedgerCode, 'debit', amount, input.memo, input.targetAccountId),
      line(LEDGER.COMPANY_CASH_WITH_OWNER, 'credit', amount, input.memo),
    ],
  };
}

/**
 * GASTO DE LA EMPRESA pagado con dinero que estaba en custodia.
 *
 *   Empresa dueña : D gasto (6xxx) / C 1130 (consume el dinero que tenía en custodia)
 *   Quien custodia: D 2150        / C banco (sale el dinero de verdad)
 *
 * El gasto es de la empresa (baja su resultado) y NO se cuenta como gasto del
 * propietario. La custodia baja exactamente lo gastado.
 */
export function expenseFromCustodyPostings(input: {
  amount: DecimalInput;
  expenseLedgerCode: string;
  holdingLedgerCode: string;
  holdingAccountId: string;
  memo?: string;
}): CustodyPostings {
  const amount = round2(input.amount);
  if (amount.lte(0)) {
    throw new ValidationError('El importe del gasto debe ser mayor que cero');
  }

  return {
    beneficiary: [
      line(input.expenseLedgerCode, 'debit', amount, input.memo),
      line(LEDGER.COMPANY_CASH_WITH_OWNER, 'credit', amount, input.memo),
    ],
    holding: [
      line(LEDGER.CUSTODY_FUNDS, 'debit', amount, input.memo),
      line(input.holdingLedgerCode, 'credit', amount, input.memo, input.holdingAccountId),
    ],
  };
}

/**
 * GASTO DE LA EMPRESA pagado con dinero PROPIO del propietario (no estaba en
 * custodia). La empresa le queda debiendo el reembolso:
 *
 *   Empresa dueña: D gasto (6xxx) / C 2350 (deuda con el propietario)
 *
 * No se toca ninguna cuenta bancaria porque no hubo movimiento bancario, y no se
 * descuenta custodia porque ese dinero nunca se recibió.
 */
export function expensePaidByOwnerPostings(input: {
  amount: DecimalInput;
  expenseLedgerCode: string;
  memo?: string;
}): CustodyLine[] {
  const amount = round2(input.amount);
  if (amount.lte(0)) {
    throw new ValidationError('El importe del gasto debe ser mayor que cero');
  }
  return [
    line(input.expenseLedgerCode, 'debit', amount, input.memo),
    line(LEDGER.OWNER_REIMBURSEMENT, 'credit', amount, input.memo),
  ];
}

// ---------------------------------------------------------------------------
// Reparto de una liquidación entre varios cobros (total, parcial o agrupada)
// ---------------------------------------------------------------------------

export interface PendingFund {
  id: string;
  originalAmount: DecimalInput;
  appliedAmount: DecimalInput;
  businessDate: Date;
  createdAt: Date;
}

export interface FundAllocation {
  fundId: string;
  amount: Prisma.Decimal;
  /** Lo que quedará aplicado en el cobro después de esta liquidación. */
  newApplied: Prisma.Decimal;
  status: 'OPEN' | 'PARTIAL' | 'SETTLED';
}

/**
 * Reparte un importe entre los cobros pendientes, **del más antiguo al más
 * nuevo** (FIFO por fecha de negocio), que es lo que espera cualquiera al
 * liquidar: primero se va lo que lleva más tiempo esperando.
 *
 * Nunca permite aplicar más de lo pendiente: si el importe supera el total,
 * lanza un error en lugar de dejar un saldo negativo (el usuario pidió
 * explícitamente que no se pueda liquidar más de lo disponible).
 */
export function allocateToFunds(funds: PendingFund[], amount: DecimalInput): FundAllocation[] {
  const total = round2(amount);
  const ordenados = [...funds].sort((a, b) => {
    const byDate = a.businessDate.getTime() - b.businessDate.getTime();
    return byDate !== 0 ? byDate : a.createdAt.getTime() - b.createdAt.getTime();
  });

  const pendienteTotal = ordenados.reduce(
    (acc, fund) => acc.plus(round2(fund.originalAmount).minus(round2(fund.appliedAmount))),
    round2(0),
  );

  if (total.lte(0)) {
    throw new ValidationError('El importe a liquidar debe ser mayor que cero');
  }
  if (total.gt(pendienteTotal)) {
    throw new ValidationError(
      `No se puede liquidar ${total.toFixed(2)}: sólo hay ${pendienteTotal.toFixed(2)} pendiente de liquidar. ` +
        'Si el dinero entró de verdad, registre primero el cobro que falta.',
    );
  }

  const allocations: FundAllocation[] = [];
  let restante = total;

  for (const fund of ordenados) {
    if (restante.lte(0)) {
      break;
    }
    const original = round2(fund.originalAmount);
    const applied = round2(fund.appliedAmount);
    const disponible = original.minus(applied);
    if (disponible.lte(0)) {
      continue;
    }
    const aplicar = disponible.lt(restante) ? disponible : restante;
    const newApplied = applied.plus(aplicar);
    allocations.push({
      fundId: fund.id,
      amount: aplicar,
      newApplied,
      status: newApplied.eq(original) ? 'SETTLED' : 'PARTIAL',
    });
    restante = restante.minus(aplicar);
  }

  return allocations;
}

/** Estado del cobro según lo aplicado (nunca se marca liquidado a medias). */
export function fundStatus(originalAmount: DecimalInput, appliedAmount: DecimalInput): 'OPEN' | 'PARTIAL' | 'SETTLED' {
  const original = round2(originalAmount);
  const applied = round2(appliedAmount);
  if (applied.eq(0)) {
    return 'OPEN';
  }
  return applied.gte(original) ? 'SETTLED' : 'PARTIAL';
}
