import { DateTime } from 'luxon';
import {
  addBusinessDays,
  addBusinessMonths,
  businessDateToIso,
  businessToday,
  daysBetween,
  formatBusinessDate,
  parseBusinessDateIso,
  resolveRangePreset,
  startOfBusinessMonth,
  startOfBusinessWeek,
  toBusinessDate,
} from './business-date.js';

describe('Fechas de negocio (America/Santo_Domingo)', () => {
  const TZ = 'America/Santo_Domingo';

  describe('toBusinessDate()', () => {
    it('un gasto de las 11 de la noche pertenece a ESE día, no al siguiente', () => {
      // 2026-10-16 23:30 en Santo Domingo (UTC-4) = 2026-10-17T03:30Z
      const instant = DateTime.fromISO('2026-10-17T03:30:00.000Z').toJSDate();
      const businessDate = toBusinessDate(instant, TZ);
      expect(businessDateToIso(businessDate)).toBe('2026-10-16');
    });

    it('una madrugada pertenece al día que empieza', () => {
      // 2026-10-17 00:30 local = 2026-10-17T04:30Z
      const instant = DateTime.fromISO('2026-10-17T04:30:00.000Z').toJSDate();
      expect(businessDateToIso(toBusinessDate(instant, TZ))).toBe('2026-10-17');
    });

    it('normaliza a medianoche UTC para que la columna DATE no se desplace', () => {
      const businessDate = toBusinessDate('2026-10-16', TZ);
      expect(businessDate.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    });

    it('acepta una fecha ISO corta y la interpreta en la zona de negocio', () => {
      expect(businessDateToIso(parseBusinessDateIso('2026-03-01', TZ))).toBe('2026-03-01');
    });

    it('rechaza un formato de fecha inválido', () => {
      expect(() => parseBusinessDateIso('16/10/2026', TZ)).toThrow(/YYYY-MM-DD/);
    });

    it('la fecha de hoy se puede comparar con la de hoy', () => {
      expect(businessDateToIso(businessToday(TZ))).toBe(businessDateToIso(businessToday(TZ)));
    });
  });

  describe('formatBusinessDate()', () => {
    it('muestra en formato dominicano dd/mm/aaaa', () => {
      expect(formatBusinessDate(parseBusinessDateIso('2026-10-16', TZ))).toBe('16/10/2026');
    });
  });

  describe('addBusinessMonths() — fin de mes', () => {
    it('31 de enero + 1 mes = último día de febrero', () => {
      const jan31 = parseBusinessDateIso('2026-01-31', TZ);
      expect(businessDateToIso(addBusinessMonths(jan31, 1))).toBe('2026-02-28');
    });

    it('31 de enero + 1 mes en año bisiesto = 29 de febrero', () => {
      const jan31 = parseBusinessDateIso('2028-01-31', TZ);
      expect(businessDateToIso(addBusinessMonths(jan31, 1))).toBe('2028-02-29');
    });

    it('15 de marzo + 12 meses = 15 de marzo del año siguiente', () => {
      const mar15 = parseBusinessDateIso('2026-03-15', TZ);
      expect(businessDateToIso(addBusinessMonths(mar15, 12))).toBe('2027-03-15');
    });
  });

  describe('rangos', () => {
    it('la semana empieza en lunes', () => {
      // 2026-10-16 es viernes
      const friday = parseBusinessDateIso('2026-10-16', TZ);
      expect(businessDateToIso(startOfBusinessWeek(friday))).toBe('2026-10-12');
    });

    it('el mes empieza el día 1', () => {
      const friday = parseBusinessDateIso('2026-10-16', TZ);
      expect(businessDateToIso(startOfBusinessMonth(friday, TZ))).toBe('2026-10-01');
    });

    it('daysBetween cuenta días de negocio', () => {
      expect(daysBetween(parseBusinessDateIso('2026-10-01', TZ), parseBusinessDateIso('2026-10-16', TZ))).toBe(15);
    });

    it('addBusinessDays avanza correctamente', () => {
      expect(businessDateToIso(addBusinessDays(parseBusinessDateIso('2026-10-16', TZ), 7))).toBe('2026-10-23');
    });

    it('"AYER" devuelve el día anterior al de referencia', () => {
      const reference = parseBusinessDateIso('2026-10-16', TZ);
      const range = resolveRangePreset('YESTERDAY', reference);
      expect(businessDateToIso(range.from)).toBe('2026-10-15');
      expect(businessDateToIso(range.to)).toBe('2026-10-15');
    });

    it('"MES" abarca desde el día 1 hasta la fecha de referencia', () => {
      const reference = parseBusinessDateIso('2026-10-16', TZ);
      const range = resolveRangePreset('MONTH', reference);
      expect(businessDateToIso(range.from)).toBe('2026-10-01');
      expect(businessDateToIso(range.to)).toBe('2026-10-16');
    });

    it('"LAST_30_DAYS" cubre 30 días exactos', () => {
      const reference = parseBusinessDateIso('2026-10-30', TZ);
      const range = resolveRangePreset('LAST_30_DAYS', reference);
      expect(daysBetween(range.from, range.to) + 1).toBe(30);
    });
  });
});
