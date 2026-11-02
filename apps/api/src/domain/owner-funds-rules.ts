import { LEDGER } from './chart-of-accounts.js';
import { round2, type DecimalInput } from './money.js';
import { ValidationError } from '../common/errors.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * «DINERO PARA MÍ»: SACAR DINERO DE MI EMPRESA Y QUE LLEGUE A MI CUENTA
 * =====================================================================
 * El problema que resuelve: un retiro del propietario bajaba el banco de la
 * empresa pero **no aparecía en ninguna cuenta suya**, así que su dinero
 * «desaparecía» de FINANZA. Y no se puede simplemente mover con un traspaso,
 * porque son dos personas jurídicas distintas.
 *
 * La solución no es adivinar: es **preguntar qué es ese dinero** y contabilizar
 * la respuesta. Hay dos naturalezas que la aplicación puede registrar hoy sin
 * inventar nada (la tercera —«me lo debía la empresa»— ya tiene su propio
 * módulo: reembolsos):
 *
 *   1) ES MI DINERO (retiro del propietario)
 *      Empresa : D 3200 Retiros del propietario      / C banco de la empresa
 *      Personal: D banco personal                    / C 1230 participación
 *      → El dinero pasa de «mi parte en la empresa» a «mi banco». El patrimonio
 *        personal NO cambia y NO se reconoce ningún ingreso. No hay deuda.
 *
 *   2) LA EMPRESA ME LO PRESTA (lo devolveré)
 *      Empresa : D 1250 Préstamos otorgados          / C banco de la empresa
 *      Personal: D banco personal                    / C 2202 préstamo por pagar
 *      → Nace una deuda real en los dos lados. Tampoco hay ingreso ni gasto.
 *
 * En los dos casos el dinero sale de verdad y llega de verdad: los dos bancos
 * quedan como dice el extracto, y se puede anular con su asiento contrario.
 */

export type OwnerFundsNature = 'WITHDRAWAL' | 'LOAN';

export interface OwnerTransferLine {
  ledgerCode: string;
  debit?: Prisma.Decimal;
  credit?: Prisma.Decimal;
  memo?: string;
  financialAccountId?: string | null;
}

export interface OwnerTransferPostings {
  /** Asiento de la empresa de la que sale el dinero. */
  source: OwnerTransferLine[];
  /** Asiento de la unidad del propietario que lo recibe. */
  target: OwnerTransferLine[];
}

const line = (
  ledgerCode: string,
  side: 'debit' | 'credit',
  amount: DecimalInput,
  memo?: string,
  financialAccountId?: string | null,
): OwnerTransferLine => ({
  ledgerCode,
  financialAccountId: financialAccountId ?? null,
  debit: side === 'debit' ? round2(amount) : undefined,
  credit: side === 'credit' ? round2(amount) : undefined,
  memo,
});

/**
 * Asientos de los dos lados.
 *
 * `sourceLedgerCode` es la cuenta contable del banco/caja de la empresa (1102,
 * 1010…) y `targetLedgerCode` la de la cuenta personal que recibe.
 */
export function ownerFundsPostings(input: {
  nature: OwnerFundsNature;
  amount: DecimalInput;
  sourceLedgerCode: string;
  sourceAccountId: string;
  targetLedgerCode: string;
  targetAccountId: string;
  memo?: string;
}): OwnerTransferPostings {
  const amount = round2(input.amount);
  if (amount.lte(0)) {
    throw new ValidationError('El importe debe ser mayor que cero');
  }

  switch (input.nature) {
    case 'WITHDRAWAL':
      return {
        source: [
          line(LEDGER.OWNER_WITHDRAWAL, 'debit', amount, input.memo),
          line(input.sourceLedgerCode, 'credit', amount, input.memo, input.sourceAccountId),
        ],
        target: [
          line(input.targetLedgerCode, 'debit', amount, input.memo, input.targetAccountId),
          // Baja su participación en la empresa: no es un ingreso ni una deuda.
          line(LEDGER.OWNER_STAKE_IN_COMPANIES, 'credit', amount, input.memo),
        ],
      };

    case 'LOAN':
      return {
        source: [
          line(LEDGER.LOAN_GIVEN, 'debit', amount, input.memo),
          line(input.sourceLedgerCode, 'credit', amount, input.memo, input.sourceAccountId),
        ],
        target: [
          line(input.targetLedgerCode, 'debit', amount, input.memo, input.targetAccountId),
          line(LEDGER.LOAN_PAYABLE_PERSONAL, 'credit', amount, input.memo),
        ],
      };

    default: {
      const exhaustivo: never = input.nature;
      throw new ValidationError(`Naturaleza del dinero no soportada: ${String(exhaustivo)}`);
    }
  }
}
