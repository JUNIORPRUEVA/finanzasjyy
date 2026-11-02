import { LEDGER } from './chart-of-accounts.js';
import { round2, type DecimalInput } from './money.js';
import { ValidationError } from '../common/errors.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * REGLAS DE REEMBOLSO AL PROPIETARIO
 * ==================================
 * Caso real: el propietario pagó con su tarjeta personal la cuota del hosting de
 * FULLTECH. El gasto es de la empresa; el dinero salió de su bolsillo.
 *
 * El error que hay que hacer imposible es **contar el gasto dos veces**: una en
 * la empresa y otra en sus finanzas personales. Y el segundo error, más sutil:
 * **contar dos gastos** cuando la empresa le devuelve el dinero.
 *
 * Cómo se evita, con dos asientos por cada hecho:
 *
 *   1) El gasto lo pagó el propietario
 *      Empresa : D gasto (6xxx)      / C 2350 (debe al propietario)
 *      Dueño   : D 1200 (le deben)   / C su cuenta (salió el dinero)
 *      → El gasto existe UNA vez, en la empresa. En las finanzas personales NO
 *        hay gasto: hay un cambio de forma (efectivo → derecho de cobro), así
 *        que el patrimonio personal no baja.
 *
 *   2) La empresa le devuelve el dinero
 *      Empresa : D 2350 (paga lo que debía) / C su banco
 *      Dueño   : D su cuenta (entra el dinero) / C 1200 (deja de deberle)
 *      → No hay gasto nuevo ni ingreso nuevo. Sólo se cierra la deuda.
 *
 * Las dos operaciones son reversibles: se anulan con su asiento contrario, nunca
 * borrando.
 */

export interface ReimbursementLine {
  ledgerCode: string;
  debit?: Prisma.Decimal;
  credit?: Prisma.Decimal;
  memo?: string;
  financialAccountId?: string | null;
}

/** Dos asientos: uno en los libros de la empresa y otro en los del propietario. */
export interface ReimbursementPostings {
  company: ReimbursementLine[];
  owner: ReimbursementLine[];
}

const line = (
  ledgerCode: string,
  side: 'debit' | 'credit',
  amount: DecimalInput,
  memo?: string,
  financialAccountId?: string | null,
): ReimbursementLine => ({
  ledgerCode,
  financialAccountId: financialAccountId ?? null,
  debit: side === 'debit' ? round2(amount) : undefined,
  credit: side === 'credit' ? round2(amount) : undefined,
  memo,
});

/**
 * 1) El propietario paga un gasto de la empresa con su propio dinero.
 *
 * `expenseLedgerCode` es la cuenta de gasto de la categoría elegida (6xxx): el
 * gasto se reconoce en la empresa y en el ejercicio en que ocurrió.
 */
export function expensePaidByOwnerDualPostings(input: {
  amount: DecimalInput;
  expenseLedgerCode: string;
  /** Cuenta contable de la cuenta personal de la que salió el dinero. */
  ownerLedgerCode: string;
  ownerAccountId: string;
  memo?: string;
}): ReimbursementPostings {
  const amount = round2(input.amount);
  if (amount.lte(0)) {
    throw new ValidationError('El importe del gasto debe ser mayor que cero');
  }
  if (!input.expenseLedgerCode || !/^6\d{3}$/.test(input.expenseLedgerCode)) {
    throw new ValidationError('El gasto pagado por el propietario debe ir a una cuenta de gasto (6xxx)');
  }

  return {
    company: [
      line(input.expenseLedgerCode, 'debit', amount, input.memo),
      line(LEDGER.OWNER_REIMBURSEMENT, 'credit', amount, input.memo),
    ],
    owner: [
      line(LEDGER.RECEIVABLE_GENERAL, 'debit', amount, input.memo),
      line(input.ownerLedgerCode, 'credit', amount, input.memo, input.ownerAccountId),
    ],
  };
}

/**
 * 2) La empresa devuelve el dinero al propietario.
 *
 * Baja la deuda (2350) y sale dinero del banco de la empresa. En la unidad del
 * propietario entra el dinero y desaparece el derecho de cobro. **Ninguna de las
 * dos partes registra un gasto ni un ingreso.**
 */
export function reimbursementPaymentDualPostings(input: {
  amount: DecimalInput;
  /** Cuenta contable de la cuenta de la empresa de la que sale el dinero. */
  companyLedgerCode: string;
  companyAccountId: string;
  /** Cuenta contable de la cuenta personal que recibe el dinero. */
  ownerLedgerCode: string;
  ownerAccountId: string;
  memo?: string;
}): ReimbursementPostings {
  const amount = round2(input.amount);
  if (amount.lte(0)) {
    throw new ValidationError('El importe de la devolución debe ser mayor que cero');
  }

  return {
    company: [
      line(LEDGER.OWNER_REIMBURSEMENT, 'debit', amount, input.memo),
      line(input.companyLedgerCode, 'credit', amount, input.memo, input.companyAccountId),
    ],
    owner: [
      line(input.ownerLedgerCode, 'debit', amount, input.memo, input.ownerAccountId),
      line(LEDGER.RECEIVABLE_GENERAL, 'credit', amount, input.memo),
    ],
  };
}
