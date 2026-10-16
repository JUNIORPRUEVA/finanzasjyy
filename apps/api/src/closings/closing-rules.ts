import type { ClosingStatus } from '../generated/prisma/enums.js';
import { dec, eq, gt, lt, round2, type DecimalInput } from '../domain/money.js';

/**
 * REGLAS DEL CIERRE DIARIO
 * ------------------------
 * El cierre diario es el mecanismo que obliga a que NINGÚN peso quede sin
 * identificar. Estas reglas son puras y se prueban por separado: la base de
 * datos y el servicio sólo aplican lo que aquí se decide.
 *
 * Principios:
 *  1. Un cierre sólo se FINALIZA si todas las diferencias están explicadas y no
 *     hay movimientos locales pendientes de confirmar por el servidor.
 *  2. Sin conexión sólo se puede dejar el cierre PROVISIONAL. Nunca uno
 *     definitivo que luego contradiga lo que el servidor reciba.
 *  3. Las diferencias se cuantifican y se explican; no se "ajustan a cero" en
 *     silencio.
 */

export interface AccountCount {
  accountId: string;
  accountName: string;
  expected: DecimalInput;
  counted: DecimalInput;
  explanation?: string | null;
}

export interface AccountDifference {
  accountId: string;
  accountName: string;
  expected: string;
  counted: string;
  /** counted - expected: positivo = sobrante, negativo = faltante. */
  difference: string;
  hasDifference: boolean;
  explanation: string | null;
  explained: boolean;
  /** Diferencia sin explicación: bloquea el cierre definitivo. */
  blocksFinalization: boolean;
}

export interface ClosingAnalysis {
  differences: AccountDifference[];
  totalExpected: string;
  totalCounted: string;
  totalDifference: string;
  accountsWithDifference: number;
  unexplainedDifferences: number;
  hasAnyDifference: boolean;
  canFinalize: boolean;
  blockers: string[];
  suggestedStatus: ClosingStatus;
}

export interface ClosingRequirements {
  /** Movimientos registrados en el dispositivo que el servidor aún no confirmó. */
  pendingSyncOperations: number;
  /** ¿El cierre se está completando sin conexión? */
  isOffline: boolean;
  /** ¿Se registró todo el día? (pasos obligatorios del asistente) */
  checklistComplete: boolean;
  /** Cuentas contadas: si falta alguna cuenta en efectivo, no se puede cerrar. */
  missingAccounts: string[];
  /** Diferencia absoluta a partir de la cual se considera crítica. */
  criticalDifferenceThreshold?: DecimalInput;
}

/**
 * Compara lo esperado (calculado desde el libro mayor) con lo contado
 * (lo que el usuario tiene en la mano) y decide si el cierre puede finalizarse.
 */
export function analyzeClosing(counts: AccountCount[], requirements: ClosingRequirements): ClosingAnalysis {
  const differences: AccountDifference[] = counts.map((count) => {
    const expected = dec(count.expected);
    const counted = dec(count.counted);
    const difference = round2(counted.minus(expected));
    const hasDifference = !difference.isZero();
    const explanation = count.explanation?.trim() ? count.explanation.trim() : null;
    // Una diferencia a favor (sobrante) también exige explicación: si no,
    // quedaría dinero sin origen identificado.
    const explained = !hasDifference || explanation !== null;

    return {
      accountId: count.accountId,
      accountName: count.accountName,
      expected: expected.toFixed(2),
      counted: counted.toFixed(2),
      difference: difference.toFixed(2),
      hasDifference,
      explanation,
      explained,
      blocksFinalization: hasDifference && !explained,
    };
  });

  const totalExpected = counts.reduce((acc, count) => acc.plus(dec(count.expected)), dec(0));
  const totalCounted = counts.reduce((acc, count) => acc.plus(dec(count.counted)), dec(0));
  const totalDifference = round2(totalCounted.minus(totalExpected));

  const accountsWithDifference = differences.filter((row) => row.hasDifference).length;
  const unexplainedDifferences = differences.filter((row) => row.blocksFinalization).length;

  const blockers: string[] = [];
  if (unexplainedDifferences > 0) {
    blockers.push(
      `${unexplainedDifferences} cuenta(s) con diferencia sin explicar. El cierre definitivo exige explicar cada diferencia.`,
    );
  }
  if (requirements.pendingSyncOperations > 0) {
    blockers.push(
      `${requirements.pendingSyncOperations} movimiento(s) registrados en el dispositivo aún no confirmados por el servidor.`,
    );
  }
  if (requirements.isOffline) {
    blockers.push('No hay conexión: sólo se puede guardar el cierre como PROVISIONAL.');
  }
  if (requirements.missingAccounts.length > 0) {
    blockers.push(`Falta contar: ${requirements.missingAccounts.join(', ')}.`);
  }
  if (!requirements.checklistComplete) {
    blockers.push('El asistente de cierre tiene pasos sin confirmar.');
  }

  let suggestedStatus: ClosingStatus;
  if (blockers.length > 0 && (requirements.isOffline || requirements.pendingSyncOperations > 0)) {
    suggestedStatus = 'PROVISIONAL';
  } else if (unexplainedDifferences > 0) {
    suggestedStatus = 'WITH_DIFFERENCES';
  } else if (blockers.length > 0) {
    suggestedStatus = 'IN_PROGRESS';
  } else if (accountsWithDifference > 0) {
    // Todo explicado: se puede finalizar, pero queda constancia de las diferencias.
    suggestedStatus = 'WITH_DIFFERENCES';
  } else {
    suggestedStatus = 'FINALIZED';
  }

  return {
    differences,
    totalExpected: totalExpected.toFixed(2),
    totalCounted: totalCounted.toFixed(2),
    totalDifference: totalDifference.toFixed(2),
    accountsWithDifference,
    unexplainedDifferences,
    hasAnyDifference: accountsWithDifference > 0,
    canFinalize: unexplainedDifferences === 0 && requirements.pendingSyncOperations === 0 && !requirements.isOffline && requirements.missingAccounts.length === 0 && requirements.checklistComplete,
    blockers,
    suggestedStatus,
  };
}

/**
 * Decide el asiento de ajuste por diferencia de caja.
 *   difference < 0 (falta dinero) → se carga 8010 Faltantes (gasto).
 *   difference > 0 (sobra dinero) → se abona 4920 Sobrantes (ingreso).
 * Nunca se "cuadra" la caja sin dejar el rastro contable.
 */
export function buildDifferenceAdjustmentLines(
  difference: DecimalInput,
  accountLedgerCode: string,
  financialAccountId: string,
): Array<{ ledgerCode: string; financialAccountId?: string; debit?: string; credit?: string; memo?: string }> {
  const amount = round2(difference);
  if (amount.isZero()) {
    return [];
  }

  if (amount.isNegative()) {
    const absolute = amount.abs();
    return [
      { ledgerCode: '8010', debit: absolute.toFixed(2), memo: 'Faltante detectado en el cierre diario' },
      {
        ledgerCode: accountLedgerCode,
        financialAccountId,
        credit: absolute.toFixed(2),
        memo: 'Cuadre de caja: faltante',
      },
    ];
  }

  return [
    {
      ledgerCode: accountLedgerCode,
      financialAccountId,
      debit: amount.toFixed(2),
      memo: 'Cuadre de caja: sobrante',
    },
    { ledgerCode: '4920', credit: amount.toFixed(2), memo: 'Sobrante detectado en el cierre diario' },
  ];
}

/** Semáforo de disciplina financiera, con criterios VERIFICABLES. */
export type DisciplineLevel = 'GREEN' | 'YELLOW' | 'RED';

export interface DisciplineInput {
  entityId: string;
  entityName: string;
  /** Días de negocio transcurridos que deberían tener cierre. */
  daysRequiringClosing: number;
  closingsFinalized: number;
  closingsWithUnexplainedDifferences: number;
  overdueObligations: number;
  pendingSyncOperations: number;
  budgetExceeded: number;
  budgetWarning: number;
  overdueClosings: number;
}

export interface DisciplineStatus {
  level: DisciplineLevel;
  reasons: string[];
  /** Criterios evaluados, para que el usuario entienda POR QUÉ está en rojo. */
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

/**
 * Calcula el semáforo. No se inventa nada: cada razón se corresponde con un
 * dato verificable del sistema.
 */
export function evaluateDiscipline(input: DisciplineInput): DisciplineStatus {
  const reasons: string[] = [];
  const checks: DisciplineStatus['checks'] = [];

  const closingsOk = input.overdueClosings === 0;
  checks.push({
    name: 'Cierres al día',
    ok: closingsOk,
    detail: closingsOk
      ? `${input.closingsFinalized}/${input.daysRequiringClosing} días cerrados`
      : `${input.overdueClosings} día(s) sin cerrar`,
  });
  if (!closingsOk) {
    reasons.push(`${input.overdueClosings} día(s) sin cierre`);
  }

  const differencesOk = input.closingsWithUnexplainedDifferences === 0;
  checks.push({
    name: 'Diferencias de caja explicadas',
    ok: differencesOk,
    detail: differencesOk ? 'Sin diferencias pendientes' : `${input.closingsWithUnexplainedDifferences} diferencia(s) sin explicar`,
  });
  if (!differencesOk) {
    reasons.push(`${input.closingsWithUnexplainedDifferences} diferencia(s) sin explicar`);
  }

  const overdueOk = input.overdueObligations === 0;
  checks.push({
    name: 'Obligaciones vencidas',
    ok: overdueOk,
    detail: overdueOk ? 'Ninguna obligación vencida' : `${input.overdueObligations} obligación(es) vencida(s)`,
  });
  if (!overdueOk) {
    reasons.push(`${input.overdueObligations} obligación(es) vencida(s)`);
  }

  const syncOk = input.pendingSyncOperations === 0;
  checks.push({
    name: 'Sincronización',
    ok: syncOk,
    detail: syncOk ? 'Todo confirmado por el servidor' : `${input.pendingSyncOperations} operación(es) pendientes`,
  });
  if (!syncOk) {
    reasons.push(`${input.pendingSyncOperations} operación(es) sin confirmar`);
  }

  const budgetOk = input.budgetExceeded === 0;
  checks.push({
    name: 'Presupuestos',
    ok: budgetOk,
    detail: budgetOk
      ? input.budgetWarning > 0
        ? `${input.budgetWarning} presupuesto(s) por agotarse`
        : 'Dentro de presupuesto'
      : `${input.budgetExceeded} presupuesto(s) excedido(s)`,
  });
  if (!budgetOk) {
    reasons.push(`${input.budgetExceeded} presupuesto(s) excedido(s)`);
  }

  let level: DisciplineLevel;
  const criticalFailures = Number(!closingsOk) + Number(!differencesOk) + Number(!overdueOk) + Number(!syncOk);
  if (criticalFailures > 0) {
    level = 'RED';
  } else if (input.budgetExceeded > 0 || input.budgetWarning > 0 || input.daysRequiringClosing > input.closingsFinalized) {
    level = 'YELLOW';
  } else {
    level = 'GREEN';
  }

  return { level, reasons, checks };
}

/** ¿Se puede reabrir un cierre y en qué estado queda? */
export function assertCanReopen(status: ClosingStatus, reason: string): void {
  if (status === 'REOPENED') {
    throw new Error('El cierre ya está reabierto');
  }
  if (!reason || reason.trim().length < 10) {
    throw new Error('La reapertura exige un motivo detallado (mínimo 10 caracteres)');
  }
}

/** Etiqueta en español para mostrar el estado sin jerga. */
export function closingStatusLabel(status: ClosingStatus): string {
  switch (status) {
    case 'PENDING':
      return 'Pendiente';
    case 'IN_PROGRESS':
      return 'En proceso';
    case 'PROVISIONAL':
      return 'Provisional (sin confirmar por el servidor)';
    case 'WITH_DIFFERENCES':
      return 'Con diferencias';
    case 'FINALIZED':
      return 'Finalizado';
    case 'REOPENED':
      return 'Reabierto';
    default:
      return status;
  }
}

/** ¿La diferencia supera el umbral crítico configurado por el usuario? */
export function isCriticalDifference(difference: DecimalInput, threshold: DecimalInput): boolean {
  return gt(dec(difference).abs(), dec(threshold));
}

export function differenceIsCreditable(difference: DecimalInput): boolean {
  return !eq(dec(difference), 0) && lt(dec(difference), 0);
}
