import type { Prisma } from '../generated/prisma/client.js';
import { InvariantError, NotFoundError, ValidationError } from '../common/errors.js';
import { add, dec, eq, gt, isZero, round2, sum, type DecimalInput } from '../domain/money.js';

/**
 * NÚCLEO DEL LIBRO MAYOR (partida doble)
 * --------------------------------------
 * Funciones puras sobre un cliente de transacción. Se usan tanto desde los
 * servicios Nest como desde los scripts de siembra, de modo que TODA la
 * contabilidad del sistema pasa por aquí.
 *
 * Reglas que se aplican antes de tocar la base de datos (y que además están
 * reforzadas por triggers SQL, por si algún día alguien escribe por otro camino):
 *   R1. Todo asiento tiene al menos 2 líneas.
 *   R2. SUM(debe) = SUM(haber) exactamente (Decimal, sin tolerancia).
 *   R3. Ningún importe es negativo; una línea es deudora o acreedora, no ambas.
 *   R4. Cada línea referencia una cuenta del catálogo existente.
 */

export type Tx = Prisma.TransactionClient;

export interface JournalLineInput {
  /** Código del catálogo contable (p. ej. '1010', '4100'). */
  ledgerCode: string;
  /** Cuenta financiera concreta, cuando el movimiento toca efectivo o banco. */
  financialAccountId?: string | null;
  debit?: DecimalInput;
  credit?: DecimalInput;
  memo?: string;
}

export interface PostEntryInput {
  entityId: string;
  businessDate: Date;
  description: string;
  sourceType: string;
  sourceId?: string | null;
  lines: JournalLineInput[];
  createdByUserId?: string | null;
}

export interface PostEntryResult {
  id: string;
  sequence: number;
  businessDate: Date;
  description: string;
  totalDebit: string;
  totalCredit: string;
  lines: Array<{
    id: string;
    ledgerCode: string;
    ledgerAccountId: string;
    financialAccountId: string | null;
    debit: string;
    credit: string;
    memo: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

export async function ledgerAccountsByCode(tx: Tx, codes: string[]) {
  const unique = [...new Set(codes)];
  const accounts = await tx.ledgerAccount.findMany({
    where: { code: { in: unique } },
    select: { id: true, code: true, name: true, type: true, normalBalance: true, isPostable: true },
  });

  const map = new Map(accounts.map((account) => [account.code, account]));
  const missing = unique.filter((code) => !map.has(code));
  if (missing.length > 0) {
    throw new InvariantError(
      `El catálogo contable no tiene estas cuentas: ${missing.join(', ')}. Ejecute la semilla (npm run db:seed).`,
    );
  }

  const notPostable = accounts.filter((account) => !account.isPostable);
  if (notPostable.length > 0) {
    throw new InvariantError(
      `No se puede registrar directamente en cuentas de agrupación: ${notPostable
        .map((account) => `${account.code} ${account.name}`)
        .join(', ')}`,
    );
  }

  return map;
}

// ---------------------------------------------------------------------------
// Registro de asientos
// ---------------------------------------------------------------------------

export async function postEntry(tx: Tx, input: PostEntryInput): Promise<PostEntryResult> {
  const normalized = input.lines.map((line, index) => {
    const debit = round2(line.debit ?? 0);
    const credit = round2(line.credit ?? 0);

    if (debit.isNegative() || credit.isNegative()) {
      throw new ValidationError(`La línea ${index + 1} del asiento tiene un importe negativo`);
    }
    if (gt(debit, 0) && gt(credit, 0)) {
      throw new ValidationError(
        `La línea ${index + 1} del asiento no puede ser deudora y acreedora a la vez (debe=${debit.toFixed(2)}, haber=${credit.toFixed(2)})`,
      );
    }
    if (isZero(debit) && isZero(credit)) {
      throw new ValidationError(`La línea ${index + 1} del asiento no tiene importe`);
    }

    return { ...line, debit, credit };
  });

  if (normalized.length < 2) {
    throw new InvariantError(
      `Un asiento contable necesita al menos 2 líneas (recibidas ${normalized.length}). La partida doble exige una contrapartida.`,
    );
  }

  const totalDebit = sum(normalized.map((line) => line.debit));
  const totalCredit = sum(normalized.map((line) => line.credit));

  if (!eq(totalDebit, totalCredit)) {
    throw new InvariantError(
      `Asiento contable descuadrado: debe=${totalDebit.toFixed(2)} haber=${totalCredit.toFixed(2)} ` +
        `(diferencia ${totalDebit.minus(totalCredit).toFixed(2)}).`,
    );
  }

  const accounts = await ledgerAccountsByCode(
    tx,
    normalized.map((line) => line.ledgerCode),
  );

  const entry = await tx.journalEntry.create({
    data: {
      entityId: input.entityId,
      businessDate: input.businessDate,
      description: input.description,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      status: 'POSTED',
      createdByUserId: input.createdByUserId ?? null,
      lines: {
        create: normalized.map((line) => ({
          ledgerAccountId: accounts.get(line.ledgerCode)!.id,
          financialAccountId: line.financialAccountId ?? null,
          debit: line.debit,
          credit: line.credit,
          memo: line.memo ?? null,
        })),
      },
    },
    include: { lines: { include: { ledgerAccount: { select: { code: true } } } } },
  });

  return {
    id: entry.id,
    sequence: entry.sequence,
    businessDate: entry.businessDate,
    description: entry.description,
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
    lines: entry.lines.map((line) => ({
      id: line.id,
      ledgerCode: line.ledgerAccount.code,
      ledgerAccountId: line.ledgerAccountId,
      financialAccountId: line.financialAccountId,
      debit: line.debit.toFixed(2),
      credit: line.credit.toFixed(2),
      memo: line.memo,
    })),
  };
}

/**
 * ASIENTO DE REVERSO
 * ------------------
 * Es la ÚNICA forma de corregir un asiento contable. No se borra ni se modifica
 * nada: se crea un asiento espejo (debe <-> haber) enlazado al original, y el
 * original pasa a estado REVERSED. La historia queda intacta y auditable.
 */
export async function reverseEntry(
  tx: Tx,
  params: {
    entryId: string;
    reason: string;
    businessDate: Date;
    createdByUserId?: string | null;
  },
): Promise<PostEntryResult> {
  const original = await tx.journalEntry.findUnique({
    where: { id: params.entryId },
    include: { lines: { include: { ledgerAccount: { select: { code: true } } } } },
  });

  if (!original) {
    throw new NotFoundError('Asiento contable', params.entryId);
  }
  if (original.status === 'REVERSED') {
    throw new InvariantError(`El asiento ${original.id} ya fue reversado`);
  }
  if (original.reversesEntryId) {
    throw new InvariantError('No se puede reversar un asiento que ya es un reverso');
  }

  const reversal = await postEntry(tx, {
    entityId: original.entityId,
    businessDate: params.businessDate,
    description: `REVERSO de ${original.description} — motivo: ${params.reason}`,
    sourceType: 'REVERSAL',
    sourceId: original.id,
    createdByUserId: params.createdByUserId ?? null,
    lines: original.lines.map((line) => ({
      ledgerCode: line.ledgerAccount.code,
      financialAccountId: line.financialAccountId,
      // Se invierten debe y haber.
      debit: line.credit,
      credit: line.debit,
      memo: `Reverso de ${line.memo ?? 'línea de asiento'}`,
    })),
  });

  await tx.journalEntry.update({
    where: { id: original.id },
    data: { status: 'REVERSED', reversesEntryId: null },
  });

  await tx.journalEntry.update({
    where: { id: reversal.id },
    data: { reversesEntryId: original.id },
  });

  return reversal;
}

// ---------------------------------------------------------------------------
// Saldos
// ---------------------------------------------------------------------------

export interface AccountBalance {
  financialAccountId: string;
  ledgerCode: string;
  /** Saldo calculado desde el libro mayor (incluye el saldo de apertura). */
  balance: string;
  totalDebit: string;
  totalCredit: string;
  movementCount: number;
}

interface BalanceRow {
  financialAccountId: string | null;
  debit: unknown;
  credit: unknown;
  count: bigint | number;
}

/**
 * Saldo de una cuenta financiera, CALCULADO a partir de los asientos.
 * Nunca se almacena un "saldo actual" editable a mano: eso permitiría que el
 * saldo dejara de cuadrar con el libro. Todo ajuste es un asiento auditable.
 *
 * Convención de signo:
 *   - Cuenta de activo (normalBalance DEBIT):  saldo = debe - haber
 *   - Cuenta de pasivo/patrimonio (CREDIT):    saldo = haber - debe
 * Así, el saldo de una tarjeta de crédito es positivo cuando se debe dinero.
 */
export async function accountBalance(
  tx: Tx,
  params: { financialAccountId: string; asOf?: Date },
): Promise<AccountBalance> {
  const account = await tx.financialAccount.findUnique({
    where: { id: params.financialAccountId },
    select: {
      id: true,
      openingBalance: true,
      ledgerAccount: { select: { code: true, normalBalance: true } },
    },
  });

  if (!account) {
    throw new NotFoundError('Cuenta financiera', params.financialAccountId);
  }

  const rows = await tx.journalLine.findMany({
    where: {
      financialAccountId: params.financialAccountId,
      entry: {
        status: { in: ['POSTED', 'REVERSED'] },
        businessDate: params.asOf ? { lte: params.asOf } : undefined,
      },
    },
    select: { debit: true, credit: true },
  });

  const totalDebit = sum(rows.map((row) => row.debit));
  const totalCredit = sum(rows.map((row) => row.credit));
  const movement = totalDebit.minus(totalCredit);
  const signed = account.ledgerAccount.normalBalance === 'DEBIT' ? movement : movement.negated();

  return {
    financialAccountId: account.id,
    ledgerCode: account.ledgerAccount.code,
    balance: round2(dec(account.openingBalance).plus(signed)).toFixed(2),
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
    movementCount: rows.length,
  };
}

/** Saldos de varias cuentas en una sola consulta (dashboard y cierre diario). */
export async function balancesForAccounts(
  tx: Tx,
  params: { financialAccountIds: string[]; asOf?: Date },
): Promise<Map<string, { balance: ReturnType<typeof dec>; totalDebit: ReturnType<typeof dec>; totalCredit: ReturnType<typeof dec>; movementCount: number }>> {
  const result = new Map<string, { balance: any; totalDebit: any; totalCredit: any; movementCount: number }>();

  if (params.financialAccountIds.length === 0) {
    return result;
  }

  const accounts = await tx.financialAccount.findMany({
    where: { id: { in: params.financialAccountIds } },
    select: { id: true, openingBalance: true, ledgerAccount: { select: { normalBalance: true } } },
  });

  const rows = await tx.journalLine.groupBy({
    by: ['financialAccountId'],
    where: {
      financialAccountId: { in: params.financialAccountIds },
      entry: { businessDate: params.asOf ? { lte: params.asOf } : undefined },
    },
    _sum: { debit: true, credit: true },
    _count: { _all: true },
  });

  const byAccount = new Map(
    rows.map((row) => [
      row.financialAccountId as string,
      {
        debit: dec(row._sum.debit ?? 0),
        credit: dec(row._sum.credit ?? 0),
        count: row._count._all,
      },
    ]),
  );

  for (const account of accounts) {
    const movement = byAccount.get(account.id) ?? { debit: dec(0), credit: dec(0), count: 0 };
    const delta = movement.debit.minus(movement.credit);
    const signed = account.ledgerAccount.normalBalance === 'DEBIT' ? delta : delta.negated();
    result.set(account.id, {
      balance: round2(dec(account.openingBalance).plus(signed)),
      totalDebit: movement.debit,
      totalCredit: movement.credit,
      movementCount: movement.count,
    });
  }

  return result;
}

export interface TrialBalanceRow {
  ledgerAccountId: string;
  ledgerCode: string;
  ledgerName: string;
  type: string;
  normalBalance: string;
  debit: string;
  credit: string;
  balance: string;
}

/** Balance de comprobación: el informe que prueba que el libro cuadra. */
export async function trialBalance(
  tx: Tx,
  params: { entityIds: string[]; from?: Date; to?: Date },
): Promise<{ rows: TrialBalanceRow[]; totalDebit: string; totalCredit: string; balanced: boolean }> {
  const rows = await tx.journalLine.groupBy({
    by: ['ledgerAccountId'],
    where: {
      entry: {
        entityId: { in: params.entityIds },
        businessDate:
          params.from || params.to
            ? {
                gte: params.from,
                lte: params.to,
              }
            : undefined,
      },
    },
    _sum: { debit: true, credit: true },
  });

  const accounts = await tx.ledgerAccount.findMany({
    where: { id: { in: rows.map((row) => row.ledgerAccountId) } },
    select: { id: true, code: true, name: true, type: true, normalBalance: true },
  });
  const accountMap = new Map(accounts.map((account) => [account.id, account]));

  const mapped: TrialBalanceRow[] = rows.map((row) => {
    const account = accountMap.get(row.ledgerAccountId)!;
    const debit = dec(row._sum.debit ?? 0);
    const credit = dec(row._sum.credit ?? 0);
    const delta = debit.minus(credit);
    return {
      ledgerAccountId: account.id,
      ledgerCode: account.code,
      ledgerName: account.name,
      type: account.type,
      normalBalance: account.normalBalance,
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
      balance: (account.normalBalance === 'DEBIT' ? delta : delta.negated()).toFixed(2),
    };
  });

  mapped.sort((a, b) => a.ledgerCode.localeCompare(b.ledgerCode));

  const totalDebit = add(...mapped.map((row) => row.debit));
  const totalCredit = add(...mapped.map((row) => row.credit));

  return {
    rows: mapped,
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
    balanced: eq(totalDebit, totalCredit),
  };
}

/**
 * Comprobación de integridad: recorre los asientos y verifica que cada uno
 * cuadra, y que los importes de los movimientos financieros coinciden con sus
 * líneas contables. Se expone en /ledger/integrity para poder auditarlo.
 */
export async function ledgerIntegrityReport(
  tx: Tx,
  params: { entityIds: string[] },
): Promise<{
  ok: boolean;
  entriesChecked: number;
  unbalanced: Array<{ entryId: string; description: string; debit: string; credit: string }>;
  transactionsWithoutEntry: number;
  intercompanyBalance: string;
}> {
  const entries = await tx.journalEntry.findMany({
    where: { entityId: { in: params.entityIds } },
    select: {
      id: true,
      description: true,
      lines: { select: { debit: true, credit: true } },
    },
  });

  const unbalanced: Array<{ entryId: string; description: string; debit: string; credit: string }> = [];
  for (const entry of entries) {
    const debit = sum(entry.lines.map((line) => line.debit));
    const credit = sum(entry.lines.map((line) => line.credit));
    if (!eq(debit, credit)) {
      unbalanced.push({
        entryId: entry.id,
        description: entry.description,
        debit: debit.toFixed(2),
        credit: credit.toFixed(2),
      });
    }
  }

  const transactionsWithoutEntry = await tx.financialTransaction.count({
    where: { entityId: { in: params.entityIds }, journalEntryId: null, status: 'POSTED' },
  });

  // La cuenta puente intercompañía debe quedar en cero al consolidar todas las
  // unidades: si no, hay una transferencia registrada a medias.
  const intercompany = await tx.journalLine.findMany({
    where: {
      ledgerAccount: { code: '1150' },
      entry: { entityId: { in: params.entityIds } },
    },
    select: { debit: true, credit: true },
  });
  const intercompanyBalance = sum(intercompany.map((line) => line.debit))
    .minus(sum(intercompany.map((line) => line.credit)))
    .toFixed(2);

  return {
    ok:
      unbalanced.length === 0 &&
      transactionsWithoutEntry === 0 &&
      eq(intercompanyBalance, 0),
    entriesChecked: entries.length,
    unbalanced,
    transactionsWithoutEntry,
    intercompanyBalance,
  };
}
