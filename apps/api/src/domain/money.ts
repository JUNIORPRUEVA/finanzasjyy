import { Prisma } from '../generated/prisma/client.js';

/**
 * POLÍTICA MONETARIA DE FINANZA (ver docs/INVARIANTES-FINANCIEROS.md)
 * -------------------------------------------------------------------
 * 1. Todo importe se almacena en PostgreSQL como `numeric(18,2)` (Decimal),
 *    nunca como coma flotante. Este módulo es el ÚNICO punto por el que entra
 *    y sale dinero hacia la base de datos.
 * 2. Los importes de las operaciones son siempre POSITIVOS; el signo lo aporta
 *    la naturaleza del movimiento (`TxnKind`) y el asiento contable.
 * 3. Redondeo: HALF_UP a 2 decimales. Ninguna operación se guarda con más
 *    decimales de los que admite la columna.
 * 4. Comparaciones siempre con `eq/gt/lt` (Decimal), nunca con `===` o `>`.
 */

export const MONEY_SCALE = 2;

/** Importe máximo aceptado en una sola operación (evita errores de tecleo y desbordes). */
export const MAX_AMOUNT = new Prisma.Decimal('1000000000'); // 1.000.000.000,00

export type DecimalInput = string | number | Prisma.Decimal;

/** Error de dominio: los datos monetarios recibidos no son válidos. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Convierte cualquier entrada a Decimal de forma exacta.
 * Los `number` se convierten a través de su representación decimal para no
 * arrastrar el error binario del punto flotante.
 */
export function dec(value: DecimalInput): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MoneyError(`Importe no numérico: ${value}`);
    }
    return new Prisma.Decimal(value.toString());
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(',', '.');
    if (trimmed.length === 0) {
      throw new MoneyError('Importe vacío');
    }
    try {
      return new Prisma.Decimal(trimmed);
    } catch {
      throw new MoneyError(`Importe con formato inválido: "${value}"`);
    }
  }
  throw new MoneyError('Tipo de importe no soportado');
}

export const ZERO = new Prisma.Decimal(0);

export function zero(): Prisma.Decimal {
  return new Prisma.Decimal(0);
}

/** Redondeo monetario estándar (medio hacia arriba) a 2 decimales. */
export function round2(value: DecimalInput): Prisma.Decimal {
  return dec(value).toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_HALF_UP);
}

export function add(...values: DecimalInput[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((acc, v) => acc.plus(dec(v)), zero());
}

export function sub(a: DecimalInput, b: DecimalInput): Prisma.Decimal {
  return dec(a).minus(dec(b));
}

export function mul(a: DecimalInput, b: DecimalInput): Prisma.Decimal {
  return dec(a).times(dec(b));
}

export function div(a: DecimalInput, b: DecimalInput): Prisma.Decimal {
  const divisor = dec(b);
  if (divisor.isZero()) {
    throw new MoneyError('División por cero en un cálculo monetario');
  }
  return dec(a).dividedBy(divisor);
}

export function negate(value: DecimalInput): Prisma.Decimal {
  return dec(value).negated();
}

export function abs(value: DecimalInput): Prisma.Decimal {
  return dec(value).abs();
}

export function sum(values: DecimalInput[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((acc, v) => acc.plus(dec(v)), zero());
}

export function sumOf<T>(items: T[], selector: (item: T) => DecimalInput): Prisma.Decimal {
  return items.reduce<Prisma.Decimal>((acc, item) => acc.plus(dec(selector(item))), zero());
}

export function isZero(value: DecimalInput): boolean {
  return dec(value).isZero();
}

export function eq(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).equals(dec(b));
}

export function gt(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).greaterThan(dec(b));
}

export function gte(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).greaterThanOrEqualTo(dec(b));
}

export function lt(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).lessThan(dec(b));
}

export function lte(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).lessThanOrEqualTo(dec(b));
}

export function min(a: DecimalInput, b: DecimalInput): Prisma.Decimal {
  return dec(a).lessThanOrEqualTo(dec(b)) ? dec(a) : dec(b);
}

export function max(a: DecimalInput, b: DecimalInput): Prisma.Decimal {
  return dec(a).greaterThanOrEqualTo(dec(b)) ? dec(a) : dec(b);
}

/** Porcentaje de `part` respecto a `total`, redondeado a 2 decimales. 0 si total = 0. */
export function percentOf(part: DecimalInput, total: DecimalInput): Prisma.Decimal {
  const t = dec(total);
  if (t.isZero()) {
    return zero();
  }
  return round2(dec(part).dividedBy(t).times(100));
}

/** Nº de decimales significativos que trae el valor (para rechazar 10.555). */
export function decimalPlaces(value: DecimalInput): number {
  const d = dec(value);
  return d.decimalPlaces();
}

export interface MoneyValidationOptions {
  field?: string;
  allowNegative?: boolean;
  allowZero?: boolean;
  max?: DecimalInput;
}

/**
 * Valida un importe recibido del exterior y lo devuelve redondeado.
 * Rechaza NaN, infinitos, más de 2 decimales, negativos inesperados y
 * valores por encima del máximo operativo.
 */
export function validateMoney(value: DecimalInput, options: MoneyValidationOptions = {}): Prisma.Decimal {
  const {
    field = 'importe',
    allowNegative = false,
    allowZero = false,
    max = MAX_AMOUNT,
  } = options;

  const amount = dec(value);

  if (amount.isNaN() || !amount.isFinite()) {
    throw new MoneyError(`El ${field} no es un número válido`);
  }
  if (amount.decimalPlaces() > MONEY_SCALE) {
    throw new MoneyError(
      `El ${field} no puede tener más de ${MONEY_SCALE} decimales (recibido: ${amount.toString()})`,
    );
  }
  if (!allowZero && amount.isZero()) {
    throw new MoneyError(`El ${field} debe ser mayor que cero`);
  }
  if (!allowNegative && amount.isNegative()) {
    throw new MoneyError(`El ${field} no puede ser negativo`);
  }
  if (amount.abs().greaterThan(dec(max))) {
    throw new MoneyError(`El ${field} supera el máximo permitido (${dec(max).toFixed(2)})`);
  }

  return round2(amount);
}

/** Representación en texto con 2 decimales, apta para JSON y CSV. */
export function toMoneyString(value: DecimalInput): string {
  return round2(value).toFixed(2);
}

/**
 * Serializa importes para la API: el cliente recibe siempre string decimal
 * ("1234.50"), nunca un número flotante. Evita que JSON.stringify convierta
 * el importe a coma flotante y reintroduzca el error que este módulo elimina.
 */
export function serializeMoney(value: DecimalInput | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return toMoneyString(value);
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  DOP: 'RD$',
  USD: 'US$',
  EUR: '€',
};

/** Formato de presentación (sólo para mostrar; nunca para calcular). */
export function formatMoney(value: DecimalInput, currency = 'DOP'): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency;
  const rounded = round2(value);
  const negative = rounded.isNegative();
  const [intPart, decPart] = rounded.abs().toFixed(2).split('.');
  const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${symbol} ${withThousands}.${decPart}`;
}
