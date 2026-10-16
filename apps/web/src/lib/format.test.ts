import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  formatMoney,
  fromCents,
  isValidMoneyText,
  normalizeMoneyInput,
  sumMoney,
  toCents,
} from './format';

describe('Formato y aritmética monetaria del cliente', () => {
  describe('validación de importes', () => {
    it('acepta texto decimal con hasta 2 decimales', () => {
      expect(isValidMoneyText('1250.75')).toBe(true);
      expect(isValidMoneyText('0.5')).toBe(true);
      expect(isValidMoneyText('100')).toBe(true);
    });

    it('rechaza más de 2 decimales', () => {
      expect(isValidMoneyText('10.555')).toBe(false);
    });

    it('rechaza texto que no es un número', () => {
      expect(isValidMoneyText('mil pesos')).toBe(false);
      expect(isValidMoneyText('')).toBe(false);
    });
  });

  describe('normalización de lo que el usuario teclea', () => {
    it('completa los centavos que faltan', () => {
      expect(normalizeMoneyInput('1250.5')).toBe('1250.50');
      expect(normalizeMoneyInput('1250')).toBe('1250.00');
    });

    it('acepta la coma como separador decimal (formato español)', () => {
      expect(normalizeMoneyInput('1250,75')).toBe('1250.75');
    });

    it('rechaza el texto con letras en vez de "arreglarlo" solo', () => {
      // Regla: nunca se cambia en silencio lo que el usuario escribió. Si en el
      // importe hay letras, se descarta y el usuario lo corrige: interpretar
      // "12a34" como 1234 podría registrar un gasto que nadie escribió.
      expect(normalizeMoneyInput('12a34')).toBe('');
    });

    it('devuelve vacío si no hay nada aprovechable', () => {
      expect(normalizeMoneyInput('abc')).toBe('');
      expect(normalizeMoneyInput('   ')).toBe('');
    });

    it('acepta un importe escrito empezando por la coma', () => {
      expect(normalizeMoneyInput(',75')).toBe('0.75');
    });
  });

  describe('suma sin errores de coma flotante', () => {
    it('suma céntimos exactamente', () => {
      // 0.1 + 0.2 en coma flotante daría 0.30000000000000004
      expect(sumMoney(['0.1', '0.2'])).toBe('0.30');
    });

    it('suma importes grandes y pequeños', () => {
      expect(sumMoney(['1000000.01', '0.99'])).toBe('1000001.00');
    });

    it('convierte a céntimos y viceversa', () => {
      expect(toCents('1234.56')).toBe(123456);
      expect(fromCents(123456)).toBe('1234.56');
      expect(fromCents(-500)).toBe('-5.00');
    });

    it('trata los valores vacíos como cero', () => {
      expect(toCents(null)).toBe(0);
      expect(toCents(undefined)).toBe(0);
      expect(toCents('')).toBe(0);
    });
  });

  describe('presentación', () => {
    it('formatea el peso dominicano con separador de miles', () => {
      expect(formatMoney('1234567.5')).toBe('RD$ 1,234,567.50');
    });

    it('muestra los negativos con el signo delante', () => {
      expect(formatMoney('-250')).toBe('-RD$ 250.00');
    });

    it('usa el símbolo correcto según la moneda', () => {
      expect(formatMoney('100', 'USD')).toBe('US$ 100.00');
      expect(formatMoney('100', 'EUR')).toBe('€ 100.00');
    });

    it('muestra un guión cuando no hay dato (nunca un cero engañoso)', () => {
      expect(formatMoney(null)).toBe('—');
      expect(formatAmount(null)).toBe('—');
    });

    it('formatAmount no incluye el símbolo (tablas compactas)', () => {
      expect(formatAmount('1234.5')).toBe('1,234.50');
    });
  });
});
