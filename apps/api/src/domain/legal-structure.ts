/**
 * RELACIÓN JURÍDICA ENTRE DOS UNIDADES
 * ====================================
 * Regla única y comprobable: ¿mover dinero de una cuenta a otra cruza o no una
 * frontera entre personas jurídicas distintas?
 *
 * Por qué esto merece un módulo aparte (y no un `if` dentro de las
 * transferencias):
 *
 *  · **No se decide comparando nombres ni identificadores sueltos.** Se decide
 *    con la persona jurídica a la que pertenece cada unidad (`legalEntityId`),
 *    que es un dato validado en la base de datos. Dos unidades con nombres
 *    distintos pueden ser la MISMA sociedad (APPYRA es una marca de FULLTECH), y
 *    ese caso no puede tratarse como si fueran dos empresas.
 *
 *  · **Una unidad sin persona jurídica confirmada no es «de nadie»: es
 *    DESCONOCIDA.** El sistema no adivina: pregunta. Tratarla como una sociedad
 *    independiente inventaría una deuda entre partes que quizá no existe;
 *    tratarla como parte de FULLTECH inventaría lo contrario.
 *
 *  · **Los cuatro casos tienen consecuencias contables distintas**, y sólo dos de
 *    ellos se pueden contabilizar hoy sin una clasificación que aún no existe:
 *
 *      A · MISMA UNIDAD          → un solo asiento (ni siquiera hay traspaso).
 *      B · MISMA PERSONA JURÍDICA → dos asientos con la cuenta puente 1150,
 *          que es una cuenta INTERNA: al consolidar esa persona jurídica queda
 *          en CERO. No hay ingreso, ni gasto, ni deuda con terceros.
 *      C · PERSONAS DISTINTAS     → el dinero cambia de dueño. Eso es retirada,
 *          retribución, reembolso o préstamo, y hay que clasificarlo antes de
 *          contabilizarlo. Se RECHAZA hasta que exista esa clasificación.
 *      D · DESCONOCIDA            → se RECHAZA y se pide confirmar la relación.
 *
 * Nada de esto toca datos históricos: es una decisión que se toma al registrar
 * una operación nueva.
 */

/** Lo mínimo que hace falta saber de una unidad para clasificar el movimiento. */
export interface LegalUnit {
  id: string;
  code: string;
  name: string;
  /** `PERSONAL`, `BUSINESS`, `RENTAL`… Sólo se usa para detectar vínculos absurdos. */
  type: string;
  /** Persona jurídica a la que pertenece. `null` = pendiente de confirmar. */
  legalEntityId: string | null;
}

export type LegalRelation = 'SAME_UNIT' | 'SAME_LEGAL_ENTITY' | 'DIFFERENT_LEGAL_ENTITY' | 'UNKNOWN';

/** Cómo se contabiliza (o por qué no se puede). */
export type PostingStrategy = 'SINGLE_ENTRY' | 'TWO_ENTRIES_BRIDGE' | 'REQUIRES_CLASSIFICATION';

export interface TransferClassification {
  relation: LegalRelation;
  /** ¿Se puede registrar esta operación con las reglas contables aprobadas hoy? */
  allowed: boolean;
  posting: PostingStrategy;
  /** Código estable (para la interfaz y las pruebas). Nunca se traduce. */
  code: string;
  /** Frase corta y en lenguaje llano para mostrar al usuario. */
  reason: string;
}

/**
 * Clasifica un movimiento entre dos unidades.
 *
 * `from` y `to` son las unidades (no las cuentas): la cuenta sólo dice dónde
 * está el dinero, la unidad dice de quién es.
 */
export function classifyTransfer(from: LegalUnit, to: LegalUnit): TransferClassification {
  if (from.id === to.id) {
    return {
      relation: 'SAME_UNIT',
      allowed: true,
      posting: 'SINGLE_ENTRY',
      code: 'SAME_UNIT',
      reason: 'Las dos cuentas son de la misma unidad: no hay frontera jurídica que cruzar.',
    };
  }

  // Cualquiera de las dos sin persona jurídica confirmada ⇒ no se sabe.
  // Se comprueba ANTES que la igualdad: dos unidades «desconocidas» no son por
  // eso «la misma sociedad».
  if (!from.legalEntityId || !to.legalEntityId) {
    const sinConfirmar = !from.legalEntityId ? from.name : to.name;
    return {
      relation: 'UNKNOWN',
      allowed: false,
      posting: 'REQUIRES_CLASSIFICATION',
      code: 'UNKNOWN_LEGAL_ENTITY',
      reason: `La relación jurídica de «${sinConfirmar}» todavía no está confirmada. Confírmela antes de mover dinero entre unidades.`,
    };
  }

  if (from.legalEntityId === to.legalEntityId) {
    return {
      relation: 'SAME_LEGAL_ENTITY',
      allowed: true,
      posting: 'TWO_ENTRIES_BRIDGE',
      code: 'SAME_LEGAL_ENTITY',
      reason:
        'Las dos unidades son de la misma persona jurídica: es un traslado interno y no cuenta como ingreso ni como gasto.',
    };
  }

  return {
    relation: 'DIFFERENT_LEGAL_ENTITY',
    allowed: false,
    posting: 'REQUIRES_CLASSIFICATION',
    code: 'DIFFERENT_LEGAL_ENTITY',
    reason:
      'Son dos personas jurídicas distintas: el dinero cambia de dueño. Hay que clasificar la operación (retirada, retribución, reembolso o préstamo) antes de contabilizarla.',
  };
}

/**
 * VÍNCULOS PERMITIDOS ENTRE UNA UNIDAD Y SU PERSONA JURÍDICA O SU UNIDAD PADRE
 * ---------------------------------------------------------------------------
 * Se valida aquí, en un solo sitio, para que no haya dos reglas distintas en el
 * formulario y en el servidor.
 *
 * Devuelve el motivo del rechazo, o `null` si el vínculo es correcto.
 */
export function validarVinculo(input: {
  /** Tipo de la unidad que se está modificando. */
  entityType: string;
  /** Persona jurídica que se quiere asignar (null = dejarla sin confirmar). */
  legalEntityId: string | null;
  legalEntityKind: 'COMPANY' | 'INDIVIDUAL' | null;
  /** Unidad padre que se quiere asignar (null = no depende de otra). */
  parentEntityId: string | null;
  /** Persona jurídica del padre, si se ha indicado uno. */
  parentLegalEntityId?: string | null;
  parentEntityType?: string | null;
}): string | null {
  if (input.legalEntityId && !input.legalEntityKind) {
    return 'La persona jurídica indicada no existe.';
  }

  // Una persona física no puede tener «negocios»: sus unidades son personales.
  if (input.legalEntityKind === 'INDIVIDUAL' && input.entityType !== 'PERSONAL') {
    return 'Una persona física sólo puede tener unidades de tipo personal.';
  }
  if (input.legalEntityKind === 'COMPANY' && input.entityType === 'PERSONAL') {
    return 'Las finanzas personales no pueden pertenecer a una sociedad: son de una persona física.';
  }

  if (!input.parentEntityId) {
    return null;
  }

  if (input.parentEntityType === 'PERSONAL') {
    return 'Una unidad de negocio no puede depender de las finanzas personales.';
  }

  // El padre y el hijo tienen que ser de la MISMA persona jurídica. Si alguna de
  // las dos no la tiene confirmada, no se puede afirmar que sean compatibles.
  if (input.legalEntityId && input.parentLegalEntityId && input.legalEntityId !== input.parentLegalEntityId) {
    return 'La unidad y la unidad de la que depende pertenecen a personas jurídicas distintas.';
  }

  return null;
}
