import type { TxnKind } from '../generated/prisma/enums.js';
import type { Prisma } from '../generated/prisma/client.js';
import { LEDGER } from '../domain/chart-of-accounts.js';
import { round2, type DecimalInput } from '../domain/money.js';
import { InvariantError } from '../common/errors.js';
import type { JournalLineInput } from './ledger-core.js';

/**
 * REGLAS DE CONTABILIZACIÓN POR TIPO DE MOVIMIENTO
 * -----------------------------------------------
 * Aquí vive la traducción de "lo que hace el usuario" a "lo que dice el libro".
 * Estas reglas son las que impiden los errores clásicos que el usuario pidió
 * evitar explícitamente:
 *
 *   · Un ingreso NO es una entrada de dinero: el ingreso va a una cuenta de
 *     resultado (4xxx) y la entrada de dinero a un activo (1xxx).
 *   · Comprar inventario NO es costo de mercancía vendida: comprar activa el
 *     inventario (1300) y el costo se reconoce cuando se vende (5000).
 *   · Un préstamo recibido NO es ingreso: entra dinero (1xxx) y sube la deuda
 *     (2200). No toca ninguna cuenta de ingresos.
 *   · Pagar un préstamo separa capital (baja la deuda) de intereses (gasto).
 *   · Un retiro del propietario NO es gasto del negocio: va a 3200.
 *   · Una transferencia interna NO genera ingreso ni gasto: sólo mueve activos.
 */
export interface PostingContext {
  kind: TxnKind;
  amount: DecimalInput;
  /** Cuenta contable de la cuenta financiera afectada (efectivo, banco, tarjeta...). */
  financialLedgerCode: string;
  /** Cuenta contable de la categoría elegida (ingresos o gastos). */
  categoryLedgerCode?: string | null;
  /** Cuenta de contrapartida para deudas o cuentas por cobrar. */
  counterpartyLedgerCode?: string | null;
  /** Cuentas explícitas para ajustes manuales. */
  adjustmentDebitCode?: string | null;
  adjustmentCreditCode?: string | null;
  memo?: string;
  financialAccountId?: string | null;
}

/**
 * Línea ya normalizada: los importes SIEMPRE salen como Decimal de 2 decimales,
 * porque `buildPostingLines` redondea la entrada antes de construir las líneas.
 */
export interface PostingLine {
  ledgerCode: string;
  financialAccountId?: string | null;
  debit?: Prisma.Decimal;
  credit?: Prisma.Decimal;
  memo?: string;
}

export function buildPostingLines(context: PostingContext): PostingLine[] {
  // El importe se normaliza SIEMPRE a Decimal con 2 decimales: así ninguna
  // línea puede quedar con un texto sin redondear ni con más precisión de la
  // que admite la columna de la base de datos.
  const amount = round2(context.amount);
  const memo = context.memo;
  const financial = context.financialLedgerCode;

  const withFinancialAccount = (line: PostingLine): PostingLine =>
    context.financialAccountId
      ? { ...line, financialAccountId: context.financialAccountId }
      : line;

  switch (context.kind) {
    case 'INCOME': {
      const incomeCode = context.categoryLedgerCode ?? LEDGER.OTHER_INCOME;
      assertIncomeAccount(incomeCode);
      return [
        withFinancialAccount({ ledgerCode: financial, debit: amount, memo }),
        { ledgerCode: incomeCode, credit: amount, memo },
      ];
    }

    case 'EXPENSE': {
      const expenseCode = context.categoryLedgerCode ?? LEDGER.OTHER_OPERATING_EXPENSE;
      assertExpenseAccount(expenseCode);
      return [
        { ledgerCode: expenseCode, debit: amount, memo },
        withFinancialAccount({ ledgerCode: financial, credit: amount, memo }),
      ];
    }

    case 'OWNER_WITHDRAWAL':
      // El dueño saca dinero del negocio: no es un gasto del negocio.
      return [
        { ledgerCode: LEDGER.OWNER_WITHDRAWAL, debit: amount, memo },
        withFinancialAccount({ ledgerCode: financial, credit: amount, memo }),
      ];

    case 'OWNER_CONTRIBUTION':
      // El dueño pone dinero en el negocio: no es un ingreso.
      return [
        withFinancialAccount({ ledgerCode: financial, debit: amount, memo }),
        { ledgerCode: LEDGER.OWNER_CONTRIBUTION, credit: amount, memo },
      ];

    case 'LOAN_DISBURSEMENT': {
      // Dinero recibido de un préstamo: entra el activo y sube la deuda.
      const debtCode = context.counterpartyLedgerCode ?? LEDGER.LOAN_PAYABLE;
      return [
        withFinancialAccount({ ledgerCode: financial, debit: amount, memo }),
        { ledgerCode: debtCode, credit: amount, memo },
      ];
    }

    case 'LOAN_PAYMENT': {
      // Se registra por separado (capital + intereses) desde LoansService.
      const debtCode = context.counterpartyLedgerCode ?? LEDGER.LOAN_PAYABLE;
      return [
        { ledgerCode: debtCode, debit: amount, memo },
        withFinancialAccount({ ledgerCode: financial, credit: amount, memo }),
      ];
    }

    case 'CREDIT_CARD_PAYMENT':
      // Pagar la tarjeta: baja el pasivo y sale dinero del banco.
      return [
        { ledgerCode: LEDGER.CREDIT_CARD, debit: amount, memo },
        withFinancialAccount({ ledgerCode: financial, credit: amount, memo }),
      ];

    case 'RECEIVABLE_SETTLEMENT':
      // El cliente paga lo que debía: entra dinero y baja la cuenta por cobrar.
      return [
        withFinancialAccount({ ledgerCode: financial, debit: amount, memo }),
        { ledgerCode: context.counterpartyLedgerCode ?? LEDGER.RECEIVABLE, credit: amount, memo },
      ];

    case 'PAYABLE_SETTLEMENT':
      // Se paga una cuenta por pagar: baja la deuda y sale dinero.
      return [
        { ledgerCode: context.counterpartyLedgerCode ?? LEDGER.PAYABLE, debit: amount, memo },
        withFinancialAccount({ ledgerCode: financial, credit: amount, memo }),
      ];

    case 'ADJUSTMENT': {
      const debitCode = context.adjustmentDebitCode;
      const creditCode = context.adjustmentCreditCode;
      if (!debitCode || !creditCode) {
        throw new InvariantError(
          'Un ajuste manual exige indicar la cuenta que se carga y la que se abona (nunca se ajusta un saldo "a ojo").',
        );
      }
      return [
        { ledgerCode: debitCode, debit: amount, memo: memo ?? 'Ajuste' },
        { ledgerCode: creditCode, credit: amount, memo: memo ?? 'Ajuste' },
      ];
    }

    case 'TRANSFER_OUT':
    case 'TRANSFER_IN':
      throw new InvariantError(
        'Las transferencias se contabilizan con TransferService (asiento doble según la unidad financiera), no con las reglas simples.',
      );

    // Los movimientos de custodia tampoco caben en estas reglas simples: cada uno
    // genera DOS asientos (empresa dueña y unidad que custodia) y los construye
    // `CustodyService`, que conoce las dos unidades implicadas.
    case 'CUSTODY_IN':
    case 'CUSTODY_OUT':
    case 'CUSTODY_SETTLEMENT':
      throw new InvariantError(
        'Los movimientos de custodia se contabilizan con CustodyService (dos asientos: empresa dueña y unidad que custodia).',
      );

    default: {
      const exhaustive: never = context.kind;
      throw new InvariantError(`Tipo de movimiento no soportado: ${String(exhaustive)}`);
    }
  }
}

const INCOME_CODES = new Set([
  LEDGER.SALES_INCOME,
  LEDGER.SERVICE_INCOME,
  LEDGER.SUBSCRIPTION_INCOME,
  LEDGER.RENTAL_INCOME,
  '4500',
  LEDGER.OTHER_INCOME,
  LEDGER.INTEREST_INCOME,
  LEDGER.CASH_OVERAGE,
  '4990',
]);

const EXPENSE_CODES = new Set([
  LEDGER.COGS,
  LEDGER.MERCHANDISE_PURCHASES,
  '5200',
  LEDGER.PAYROLL,
  '6110',
  LEDGER.RENT,
  LEDGER.ADVERTISING,
  LEDGER.FUEL,
  LEDGER.DELIVERY,
  LEDGER.ELECTRICITY,
  LEDGER.WATER,
  LEDGER.INTERNET,
  LEDGER.TECHNOLOGY,
  LEDGER.MAINTENANCE,
  LEDGER.SUPPLIES,
  LEDGER.PROFESSIONAL_SERVICES,
  LEDGER.FOOD,
  '6950',
  '6960',
  '6970',
  '6980',
  LEDGER.OTHER_OPERATING_EXPENSE,
  LEDGER.INTEREST_EXPENSE,
  LEDGER.BANK_FEES,
  LEDGER.PENALTIES,
  LEDGER.CASH_SHORTAGE,
  LEDGER.ROUNDING_ADJUSTMENT,
]);

/**
 * Verifica que la categoría elegida sea coherente con el tipo de movimiento.
 * Evita que un gasto acabe en una cuenta de ingresos (y al revés), que es la
 * causa número uno de informes que no cuadran con la realidad.
 */
export function assertIncomeAccount(code: string): void {
  if (!INCOME_CODES.has(code)) {
    throw new InvariantError(
      `La cuenta ${code} no es una cuenta de ingresos. Una entrada de dinero no es un ingreso: registre el origen correcto.`,
    );
  }
}

export function assertExpenseAccount(code: string): void {
  if (!EXPENSE_CODES.has(code)) {
    throw new InvariantError(`La cuenta ${code} no es una cuenta de gastos.`);
  }
}

export function isIncomeAccount(code: string): boolean {
  return INCOME_CODES.has(code);
}

export function isExpenseAccount(code: string): boolean {
  return EXPENSE_CODES.has(code);
}

/** Tipos de movimiento que representan ingreso real (para reportes de resultado). */
export const INCOME_KINDS: TxnKind[] = ['INCOME'];

/** Tipos que representan gasto real y afectan al resultado. */
export const EXPENSE_KINDS: TxnKind[] = ['EXPENSE'];

/** Tipos que son sólo movimiento de efectivo y NUNCA resultado (ingreso/gasto). */
export const CASH_ONLY_KINDS: TxnKind[] = [
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'OWNER_WITHDRAWAL',
  'OWNER_CONTRIBUTION',
  'LOAN_DISBURSEMENT',
  'LOAN_PAYMENT',
  'CREDIT_CARD_PAYMENT',
  'RECEIVABLE_SETTLEMENT',
  'PAYABLE_SETTLEMENT',
  'CUSTODY_IN',
  'CUSTODY_OUT',
  'CUSTODY_SETTLEMENT',
];

/**
 * Tipos cuya reconciliación con la clasificación contable es importante:
 * se usan en los informes para no confundir entradas de dinero con ingresos.
 */
export function affectsResult(kind: TxnKind): boolean {
  return kind === 'INCOME' || kind === 'EXPENSE' || kind === 'ADJUSTMENT';
}
