import { DateTime } from 'luxon';
import {
  dueOccurrenceKey,
  isDueNow,
  nextOccurrence,
  reminderBase,
  repeatLabel,
  toRrule,
  type ReminderSchedule,
} from './reminder-recurrence.js';

/**
 * Las reglas de repetición son la parte que más fácil se rompe (meses de 31 y
 * 28 días, zonas horarias, avisos recuperados tras una caída). Se prueban sin
 * base de datos: son funciones puras.
 *
 * Zona usada: America/Santo_Domingo (UTC−4 todo el año). Por eso las 13:00 UTC
 * son las 09:00 locales.
 */

const TZ = 'America/Santo_Domingo';
const atLocalNine = (isoDate: string): Date => new Date(`${isoDate}T13:00:00.000Z`);

const once = (isoDate: string): ReminderSchedule => ({ alertAt: atLocalNine(isoDate), repeat: 'ONCE', timezone: TZ });
const daily = (isoDate: string): ReminderSchedule => ({ alertAt: atLocalNine(isoDate), repeat: 'DAILY', timezone: TZ });
const monthly = (isoDate: string): ReminderSchedule => ({
  alertAt: atLocalNine(isoDate),
  repeat: 'MONTHLY',
  timezone: TZ,
});

const at = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' });

describe('recordatorios · repetición', () => {
  it('la hora base se interpreta en la zona del recordatorio', () => {
    const base = reminderBase(once('2026-03-15'));
    expect(base?.hour).toBe(9);
    expect(base?.zoneName).toBe(TZ);
  });

  it('un aviso de una sola vez no suena antes de su hora', () => {
    const schedule = once('2026-03-15');
    expect(isDueNow(schedule, at('2026-03-15T12:59:00Z'))).toBe(false);
    expect(isDueNow(schedule, at('2026-03-15T13:00:00Z'))).toBe(true);
  });

  it('un aviso de una sola vez se recupera hasta 24 h después (servidor caído)', () => {
    const schedule = once('2026-03-15');
    expect(isDueNow(schedule, at('2026-03-16T12:00:00Z'))).toBe(true);
    expect(isDueNow(schedule, at('2026-03-17T14:00:00Z'))).toBe(false);
  });

  it('diario: suena a su hora y solo una vez por día', () => {
    const schedule = daily('2026-03-01');
    expect(isDueNow(schedule, at('2026-03-20T12:00:00Z'))).toBe(false); // 08:00 local
    expect(isDueNow(schedule, at('2026-03-20T13:30:00Z'))).toBe(true); // 09:30 local
    expect(dueOccurrenceKey(schedule, at('2026-03-20T13:30:00Z'))).toBe('2026-03-20');
    expect(dueOccurrenceKey(schedule, at('2026-03-20T22:00:00Z'))).toBe('2026-03-20');
    expect(dueOccurrenceKey(schedule, at('2026-03-21T13:30:00Z'))).toBe('2026-03-21');
  });

  it('mensual: cae el mismo día de cada mes', () => {
    const schedule = monthly('2026-01-15');
    expect(isDueNow(schedule, at('2026-02-14T13:30:00Z'))).toBe(false);
    expect(isDueNow(schedule, at('2026-02-15T12:00:00Z'))).toBe(false); // aún no son las 09:00
    expect(isDueNow(schedule, at('2026-02-15T13:30:00Z'))).toBe(true);
  });

  it('mensual: el 31 cae el último día de los meses cortos', () => {
    const schedule = monthly('2026-01-31');
    expect(isDueNow(schedule, at('2026-02-27T13:30:00Z'))).toBe(false);
    expect(isDueNow(schedule, at('2026-02-28T13:30:00Z'))).toBe(true);
    expect(isDueNow(schedule, at('2026-03-30T13:30:00Z'))).toBe(false);
    expect(isDueNow(schedule, at('2026-03-31T13:30:00Z'))).toBe(true);
  });

  it('la próxima vez se puede calcular para mostrarla en la pantalla', () => {
    expect(nextOccurrence(daily('2026-03-01'), at('2026-03-20T14:00:00Z'))?.toUTC().toISO()).toBe(
      '2026-03-21T13:00:00.000Z',
    );
    expect(nextOccurrence(monthly('2026-01-31'), at('2026-02-28T14:00:00Z'))?.toUTC().toISO()).toBe(
      '2026-03-31T13:00:00.000Z',
    );
    expect(nextOccurrence(once('2026-03-01'), at('2026-03-20T14:00:00Z'))).toBeNull();
  });

  it('la regla del calendario coincide con la repetición', () => {
    expect(toRrule(once('2026-03-15'))).toBeNull();
    expect(toRrule(daily('2026-03-15'))).toBe('FREQ=DAILY');
    expect(toRrule(monthly('2026-03-31'))).toBe('FREQ=MONTHLY;BYMONTHDAY=31');
    expect(repeatLabel('MONTHLY')).toBe('Cada mes');
  });
});
