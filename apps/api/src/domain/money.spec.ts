import {
  add,
  dec,
  formatMoney,
  gt,
  lt,
  max,
  min,
  MoneyError,
  percentOf,
  round2,
  serializeMoney,
  sub,
  sum,
  toMoneyString,
  validateMoney,
} from './money.js';

describe('Política monetaria (domain/money)', () => {
  describe('dec() — conversión exacta', () => {
    it('acepta texto decimal sin pérdida', () => {
      expect(dec('1250.75').toFixed(2)).toBe('1250.75');
      expect(dec('0.1').toString()).toBe('0.1');
    });

    it('acepta coma decimal (formato en español)', () => {
      expect(dec('1234,56').toFixed(2)).toBe('1234.56');
    });

    it('rechaza texto que no es un número', () => {
      expect(() => dec('mil pesos')).toThrow(MoneyError);
    });

    it('rechaza NaN e infinito', () => {
      expect(() => dec(Number.NaN)).toThrow(MoneyError);
      expect(() => dec(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
    });

    it('no arrastra el error binario del punto flotante', () => {
      // 0.1 + 0.2 en coma flotante da 0.30000000000000004
      const total = add('0.1', '0.2');
      expect(total.toFixed(2)).toBe('0.30');
      expect(total.toString()).toBe('0.3');
    });
  });

  describe('round2() — redondeo monetario HALF_UP', () => {
    it('redondea al alza en el medio', () => {
      expect(round2('10.005').toFixed(2)).toBe('10.01');
      expect(round2('10.004').toFixed(2)).toBe('10.00');
      expect(round2('2.675').toFixed(2)).toBe('2.68');
    });
  });

  describe('validateMoney() — validación de importes de entrada', () => {
    it('acepta un importe normal', () => {
      expect(validateMoney('1500.25').toFixed(2)).toBe('1500.25');
    });

    it('rechaza más de 2 decimales (evita importes con céntimos imposibles)', () => {
      expect(() => validateMoney('10.555')).toThrow(/2 decimales/);
    });

    it('rechaza cero por defecto', () => {
      expect(() => validateMoney('0')).toThrow(/mayor que cero/);
    });

    it('permite cero cuando se indica explícitamente', () => {
      expect(validateMoney('0', { allowZero: true }).toFixed(2)).toBe('0.00');
    });

    it('rechaza importes negativos salvo autorización explícita', () => {
      expect(() => validateMoney('-5')).toThrow(MoneyError);
      expect(validateMoney('-5', { allowNegative: true }).toFixed(2)).toBe('-5.00');
    });

    it('rechaza importes por encima del máximo operativo', () => {
      expect(() => validateMoney('1000000001')).toThrow(/máximo permitido/);
    });
  });

  describe('aritmética y comparaciones', () => {
    it('suma sin errores de precisión', () => {
      expect(sum(['0.1', '0.2', '0.3', '0.4']).toFixed(2)).toBe('1.00');
    });

    it('resta correctamente', () => {
      expect(sub('100', '33.33').toFixed(2)).toBe('66.67');
    });

    it('compara sin usar operadores de coma flotante', () => {
      expect(gt('0.3', '0.1')).toBe(true);
      expect(lt('0.1', '0.3')).toBe(true);
      expect(gt('0.30000000000000004', '0.3')).toBe(true);
    });

    it('min y max devuelven el valor correcto', () => {
      expect(min('5', '10').toFixed(2)).toBe('5.00');
      expect(max('5', '10').toFixed(2)).toBe('10.00');
    });
  });

  describe('porcentajes y presentación', () => {
    it('calcula el porcentaje sobre el total', () => {
      expect(percentOf('25', '200').toFixed(2)).toBe('12.50');
    });

    it('devuelve 0 cuando el total es cero (sin dividir por cero)', () => {
      expect(percentOf('25', '0').toFixed(2)).toBe('0.00');
    });

    it('serializa a texto con 2 decimales para la API', () => {
      expect(serializeMoney('1234.5')).toBe('1234.50');
      expect(serializeMoney(null)).toBeNull();
      expect(toMoneyString('7')).toBe('7.00');
    });

    it('formatea el peso dominicano para mostrar', () => {
      expect(formatMoney('1234567.5', 'DOP')).toBe('RD$ 1,234,567.50');
      expect(formatMoney('-250', 'DOP')).toBe('-RD$ 250.00');
    });
  });
});
