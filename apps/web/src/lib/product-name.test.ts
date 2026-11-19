import { describe, expect, it } from 'vitest';
import { normalizeProductName } from './product-name';

/**
 * La normalización del nombre es la que decide si dos compras son el MISMO
 * producto en el catálogo: si esto cambia, los precios dejan de compararse bien.
 */
describe('normalizeProductName', () => {
  it('junta mayúsculas, espacios y acentos', () => {
    expect(normalizeProductName('Arroz 5 lb')).toBe('arroz 5 lb');
    expect(normalizeProductName('  ARROZ   5  LB ')).toBe('arroz 5 lb');
    expect(normalizeProductName('Aceitúna verde')).toBe('aceituna verde');
  });

  it('quita signos que no aportan al nombre', () => {
    expect(normalizeProductName('Leche (1 L)')).toBe('leche 1 l');
    expect(normalizeProductName('Pan — integral')).toBe('pan integral');
  });

  it('no rompe con un texto vacío', () => {
    expect(normalizeProductName('   ')).toBe('');
  });
});
