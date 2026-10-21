import { DateTime } from 'luxon';
import { ValidationError } from '../common/errors.js';

/**
 * FECHAS DE NEGOCIO (ver docs/INVARIANTES-FINANCIEROS.md)
 * ------------------------------------------------------
 * Todas las columnas `@db.Date` de FINANZA guardan el DÍA DE NEGOCIO en
 * America/Santo_Domingo, normalizado como medianoche UTC de ese día
 * (p. ej. el 16/10/2026 a las 21:00 en Santo Domingo se guarda como
 * 2026-10-16T00:00:00.000Z).
 *
 * Esto evita el error clásico de que un gasto de las 11 de la noche acabe
 * contado en el día siguiente (o anterior) por culpa de la zona horaria.
 *
 * Reglas:
 *  - Para ESCRIBIR usar `toBusinessDate(...)`.
 *  - Para LEER y mostrar usar `formatBusinessDate(...)` / `businessDateToIso(...)`.
 *  - Nunca usar `new Date()` directamente para una fecha de negocio.
 */

export const DEFAULT_TIMEZONE = 'America/Santo_Domingo';
export const DEFAULT_CURRENCY = 'DOP';

export interface BusinessDateContext {
  timeZone?: string;
}

function resolveZone(context?: BusinessDateContext | string): string {
  if (typeof context === 'string') {
    return context;
  }
  return context?.timeZone ?? process.env.BUSINESS_TIMEZONE ?? DEFAULT_TIMEZONE;
}

/** Día de negocio actual (o de la fecha indicada) como `Date` a medianoche UTC. */
export function toBusinessDate(input?: Date | string | DateTime, context?: BusinessDateContext | string): Date {
  const zone = resolveZone(context);

  let dt: DateTime;
  if (input === undefined || input === null) {
    dt = DateTime.now().setZone(zone);
  } else if (typeof input === 'string' && input.trim() === '') {
    // Una fecha vacía significa «la de hoy», no un error del servidor. Antes
    // llegaba como cadena vacía desde un formulario y reventaba con un 500.
    dt = DateTime.now().setZone(zone);
  } else if (DateTime.isDateTime(input)) {
    dt = input.setZone(zone);
  } else if (input instanceof Date) {
    dt = DateTime.fromJSDate(input).setZone(zone);
  } else {
    // 'YYYY-MM-DD' se interpreta directamente en la zona de negocio.
    const parsed = DateTime.fromISO(input, { zone });
    if (!parsed.isValid) {
      // Es un dato que el usuario puede corregir: 400 y mensaje claro.
      throw new ValidationError(
        `La fecha "${input}" no es válida. Use el formato año-mes-día (por ejemplo 2026-10-21).`,
      );
    }
    dt = parsed;
  }

  if (!dt.isValid) {
    throw new ValidationError(`No se pudo interpretar la fecha: ${dt.invalidReason ?? 'desconocido'}`);
  }

  return new Date(Date.UTC(dt.year, dt.month - 1, dt.day));
}

/** Día de negocio de "hoy" según la zona configurada. */
export function businessToday(context?: BusinessDateContext | string): Date {
  return toBusinessDate(undefined, context);
}

/** Fecha de negocio en formato ISO corto: '2026-10-16'. */
export function businessDateToIso(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Presentación local para el usuario: '16/10/2026'. */
export function formatBusinessDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${d.getUTCFullYear()}`;
}

export function parseBusinessDateIso(iso: string, context?: BusinessDateContext | string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`Se esperaba una fecha 'YYYY-MM-DD' y se recibió "${iso}"`);
  }
  return toBusinessDate(iso, context);
}

export function addBusinessDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function addBusinessMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const targetMonth = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const day = d.getUTCDate();
  // Día 31 en un mes de 30: se ajusta al último día del mes destino.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)));
}

export function startOfBusinessMonth(date: Date, context?: BusinessDateContext | string): Date {
  const zone = resolveZone(context);
  const dt = DateTime.fromJSDate(date, { zone: 'utc' }).setZone(zone, { keepLocalTime: false });
  return new Date(Date.UTC(dt.year, dt.month - 1, 1));
}

export function endOfBusinessMonth(date: Date, context?: BusinessDateContext | string): Date {
  const zone = resolveZone(context);
  const dt = DateTime.fromJSDate(date, { zone: 'utc' }).setZone(zone);
  const lastDay = DateTime.utc(dt.year, dt.month, 1).endOf('month').day;
  return new Date(Date.UTC(dt.year, dt.month - 1, lastDay));
}

/** Semana ISO: lunes como primer día. */
export function startOfBusinessWeek(date: Date): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDay(); // 0 = domingo
  const diff = day === 0 ? 6 : day - 1;
  return addBusinessDays(d, -diff);
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

export function isSameBusinessDate(a: Date, b: Date): boolean {
  return businessDateToIso(a) === businessDateToIso(b);
}

export function businessRange(startIso: string, endIso: string): { from: Date; to: Date } {
  return { from: parseBusinessDateIso(startIso), to: parseBusinessDateIso(endIso) };
}

/**
 * Resuelve rangos rápidos usados por el dashboard ('HOY', 'AYER', 'SEMANA', ...).
 */
export type RangePreset =
  | 'TODAY'
  | 'YESTERDAY'
  | 'WEEK'
  | 'MONTH'
  | 'QUARTER'
  | 'YEAR'
  | 'LAST_30_DAYS';

export function resolveRangePreset(
  preset: RangePreset,
  reference: Date = businessToday(),
): { from: Date; to: Date } {
  switch (preset) {
    case 'TODAY':
      return { from: reference, to: reference };
    case 'YESTERDAY': {
      const yesterday = addBusinessDays(reference, -1);
      return { from: yesterday, to: yesterday };
    }
    case 'WEEK':
      return { from: startOfBusinessWeek(reference), to: reference };
    case 'MONTH':
      return { from: startOfBusinessMonth(reference), to: reference };
    case 'QUARTER': {
      const month = reference.getUTCMonth();
      const quarterStartMonth = Math.floor(month / 3) * 3;
      const from = new Date(Date.UTC(reference.getUTCFullYear(), quarterStartMonth, 1));
      return { from, to: reference };
    }
    case 'YEAR':
      return { from: new Date(Date.UTC(reference.getUTCFullYear(), 0, 1)), to: reference };
    case 'LAST_30_DAYS':
      return { from: addBusinessDays(reference, -29), to: reference };
    default:
      return { from: reference, to: reference };
  }
}

/** Marca temporal legible en la zona de negocio (para logs e informes). */
export function nowInBusinessZone(context?: BusinessDateContext | string): DateTime {
  return DateTime.now().setZone(resolveZone(context));
}
