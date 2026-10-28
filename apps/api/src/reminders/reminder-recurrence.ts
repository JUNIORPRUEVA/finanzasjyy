import { DateTime } from 'luxon';
import type { ReminderRepeat } from '../generated/prisma/enums.js';

/**
 * REPETICIÓN DE UN RECORDATORIO
 * -----------------------------
 * Reglas puras (sin base de datos ni Nest) para que se puedan probar en
 * milisegundos:
 *
 *  · ONCE    — un solo aviso, en la fecha y hora indicadas.
 *  · DAILY   — todos los días a esa misma hora.
 *  · MONTHLY — cada mes el mismo día. Si el mes es más corto (31 en febrero),
 *              se usa el último día de ese mes; nunca se salta el aviso.
 *
 * Todo se calcula en la zona horaria del recordatorio: el usuario piensa en su
 * hora local, no en UTC.
 */

export interface ReminderSchedule {
  alertAt: Date | null;
  repeat: ReminderRepeat;
  timezone: string;
}

/** El primer aviso, ya en la zona horaria del recordatorio. */
export function reminderBase(schedule: ReminderSchedule): DateTime | null {
  if (!schedule.alertAt) {
    return null;
  }
  const base = DateTime.fromJSDate(schedule.alertAt, { zone: 'utc' }).setZone(schedule.timezone || 'UTC');
  return base.isValid ? base : null;
}

/** Día del mes en el que cae el aviso, ajustado al largo real del mes. */
function dueDayOfMonth(base: DateTime, month: DateTime): number {
  const daysInMonth = month.daysInMonth ?? 31;
  return Math.min(base.day, daysInMonth);
}

/** Próxima vez que tocará avisar (para mostrar «le avisaremos el…»). */
export function nextOccurrence(schedule: ReminderSchedule, from: DateTime): DateTime | null {
  const base = reminderBase(schedule);
  if (!base) {
    return null;
  }
  const ref = from.setZone(schedule.timezone || 'UTC');
  if (ref <= base) {
    return base;
  }

  switch (schedule.repeat) {
    case 'ONCE':
      return null;

    case 'DAILY': {
      let candidate = ref
        .startOf('day')
        .set({ hour: base.hour, minute: base.minute, second: 0, millisecond: 0 });
      if (candidate < ref) {
        candidate = candidate.plus({ days: 1 });
      }
      return candidate;
    }

    case 'MONTHLY': {
      let cursor = ref.startOf('month');
      for (let index = 0; index < 24; index += 1) {
        const day = dueDayOfMonth(base, cursor);
        const candidate = cursor
          .startOf('month')
          .set({ day, hour: base.hour, minute: base.minute, second: 0, millisecond: 0 });
        if (candidate >= ref) {
          return candidate;
        }
        cursor = cursor.plus({ months: 1 });
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * ¿Le toca avisar AHORA? La ventana la controla el planificador (cada 5
 * minutos) y la deduplicación evita repetir el mismo aviso.
 */
export function isDueNow(schedule: ReminderSchedule, now: DateTime): boolean {
  const base = reminderBase(schedule);
  if (!base) {
    return false;
  }
  const local = now.setZone(schedule.timezone || 'UTC');
  if (local < base) {
    return false;
  }

  switch (schedule.repeat) {
    case 'ONCE':
      // Si el servidor estuvo apagado, el aviso se recupera hasta 24 h después.
      return local.diff(base, 'hours').hours < 24;

    case 'DAILY': {
      const todayAtBaseTime = local
        .startOf('day')
        .set({ hour: base.hour, minute: base.minute, second: 0, millisecond: 0 });
      return local >= todayAtBaseTime;
    }

    case 'MONTHLY': {
      const day = dueDayOfMonth(base, local);
      if (local.day !== day) {
        return false;
      }
      const dueMoment = local
        .startOf('month')
        .set({ day, hour: base.hour, minute: base.minute, second: 0, millisecond: 0 });
      return local >= dueMoment;
    }

    default:
      return false;
  }
}

/**
 * Clave de deduplicación del aviso que toca: una por día (o una sola para los
 * avisos de una única vez). Reiniciar el servidor no repite el aviso.
 */
export function dueOccurrenceKey(schedule: ReminderSchedule, now: DateTime): string | null {
  if (!isDueNow(schedule, now)) {
    return null;
  }
  const base = reminderBase(schedule);
  if (!base) {
    return null;
  }
  if (schedule.repeat === 'ONCE') {
    return `once:${base.toUTC().toISO()}`;
  }
  return now.setZone(schedule.timezone || 'UTC').toISODate() ?? now.toUTC().toISODate();
}

/** Regla de repetición para el calendario (ICS/RRULE); null si es una sola vez. */
export function toRrule(schedule: ReminderSchedule): string | null {
  const base = reminderBase(schedule);
  if (!base) {
    return null;
  }
  switch (schedule.repeat) {
    case 'DAILY':
      return 'FREQ=DAILY';
    case 'MONTHLY':
      return `FREQ=MONTHLY;BYMONTHDAY=${base.day}`;
    default:
      return null;
  }
}

/** Texto para la interfaz: «Una vez», «Todos los días», «Cada mes». */
export function repeatLabel(repeat: ReminderRepeat): string {
  switch (repeat) {
    case 'DAILY':
      return 'Todos los días';
    case 'MONTHLY':
      return 'Cada mes';
    default:
      return 'Una vez';
  }
}
