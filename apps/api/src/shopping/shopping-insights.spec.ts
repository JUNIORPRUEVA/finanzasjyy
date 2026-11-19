import { buildInsights, classifyProduct, normalizeText, type InsightLine } from './shopping-insights.js';

/**
 * ANÁLISIS DE COMPRAS
 * ===================
 * Lo que se comprueba aquí es lo que el usuario va a leer como consejo: que la
 * clasificación de alimentos sea razonable, que los precios que suben se
 * detecten con dos compras reales (no con una), y que sin datos no se invente
 * ningún consejo.
 */

const linea = (overrides: Partial<InsightLine> = {}): InsightLine => ({
  name: 'Arroz',
  quantity: 1,
  unit: 'lb',
  unitPrice: 50,
  total: 50,
  purchasedAt: '2026-11-01',
  listId: 'lista-1',
  ...overrides,
});

describe('clasificación de productos', () => {
  it('reconoce los grupos habituales de un supermercado', () => {
    expect(classifyProduct('Pechuga de pollo')).toBe('proteinas');
    expect(classifyProduct('Plátano verde')).toBe('verduras');
    expect(classifyProduct('Plátano maduro')).toBe('frutas');
    expect(classifyProduct('Leche entera')).toBe('lacteos');
    expect(classifyProduct('Arroz selecto')).toBe('cereales');
    expect(classifyProduct('Habichuelas rojas')).toBe('verduras');
    expect(classifyProduct('Lentejas')).toBe('legumbres');
    expect(classifyProduct('Aceite de oliva')).toBe('grasas');
    expect(classifyProduct('Detergente en polvo')).toBe('hogar');
    expect(classifyProduct('Papas fritas')).toBe('procesados');
  });

  it('no se deja engañar por acentos ni mayúsculas', () => {
    expect(normalizeText('  Aceitúna   VERDE ')).toBe('aceituna verde');
    expect(classifyProduct('ACEITE DE GIRASOL')).toBe('grasas');
  });

  it('lo que no reconoce va a «otros» y no rompe nada', () => {
    expect(classifyProduct('Producto raro xyz')).toBe('otros');
    expect(classifyProduct('')).toBe('otros');
  });
});

describe('análisis del historial', () => {
  const hoy = new Date('2026-11-19T12:00:00Z');

  it('sin compras no inventa consejos ni cifras', () => {
    const resultado = buildInsights([], hoy);
    expect(resultado.totals.purchases).toBe(0);
    expect(resultado.totals.spent).toBe(0);
    expect(resultado.totals.averageTicket).toBeNull();
    expect(resultado.topProducts).toHaveLength(0);
    expect(resultado.tips).toHaveLength(1);
    expect(resultado.tips[0]).toMatch(/todavía no hay compras/i);
  });

  it('suma el gasto y calcula el ticket medio por lista', () => {
    const resultado = buildInsights(
      [
        linea({ name: 'Arroz', total: 100, listId: 'a' }),
        linea({ name: 'Pollo', total: 300, listId: 'a' }),
        linea({ name: 'Leche', total: 200, listId: 'b' }),
      ],
      hoy,
    );

    expect(resultado.totals.purchases).toBe(2);
    expect(resultado.totals.spent).toBe(600);
    expect(resultado.totals.averageTicket).toBe(300);
  });

  it('cuenta veces comprado y detecta subidas de precio reales', () => {
    const resultado = buildInsights(
      [
        linea({ name: 'Aceite', unitPrice: 100, total: 100, purchasedAt: '2026-10-01', listId: 'a' }),
        linea({ name: 'Aceite', unitPrice: 130, total: 130, purchasedAt: '2026-11-01', listId: 'b' }),
      ],
      hoy,
    );

    expect(resultado.topProducts[0]).toMatchObject({
      name: 'Aceite',
      times: 2,
      lastPrice: 130,
      previousPrice: 100,
      changePct: 30,
    });
    expect(resultado.priceIncreases[0]).toMatchObject({ name: 'Aceite', from: 100, to: 130, changePct: 30 });
    expect(resultado.tips.some((tip) => /subió un 30%/i.test(tip))).toBe(true);
  });

  it('no marca subida con una sola compra', () => {
    const resultado = buildInsights([linea({ name: 'Café', unitPrice: 300 })], hoy);
    const producto = resultado.topProducts.find((row) => row.name === 'Café');
    expect(producto?.times).toBe(1);
    expect(producto?.changePct).toBeNull();
    expect(resultado.priceIncreases).toHaveLength(0);
  });

  it('mide el equilibrio y avisa cuando faltan verduras o frutas', () => {
    const resultado = buildInsights(
      [
        linea({ name: 'Arroz', total: 100 }),
        linea({ name: 'Pollo', total: 100 }),
        linea({ name: 'Papas fritas', total: 100 }),
      ],
      hoy,
    );

    expect(resultado.balance.missingGroups).toContain('verduras');
    expect(resultado.balance.missingGroups).toContain('frutas');
    expect(resultado.tips.some((tip) => /no aparecen verduras y frutas/i.test(tip))).toBe(true);
    expect(resultado.balance.ultraProcessedShare).toBe(33);
  });

  it('el consejo de aprovechamiento aparece cuando hay comida fresca', () => {
    const resultado = buildInsights(
      [
        linea({ name: 'Pechuga de pollo', total: 400 }),
        linea({ name: 'Tomate', total: 100 }),
        linea({ name: 'Leche', total: 100 }),
        linea({ name: 'Arroz', total: 100 }),
      ],
      hoy,
    );

    expect(resultado.balance.score).toBeGreaterThan(0);
    expect(resultado.tips.some((tip) => /congele/i.test(tip))).toBe(true);
  });

  it('ignora líneas sin nombre y no divide por cero', () => {
    const resultado = buildInsights([linea({ name: '   ', total: 500 }), linea({ name: 'Arroz', total: 50 })], hoy);
    expect(resultado.totals.spent).toBe(50);
    expect(resultado.totals.purchases).toBe(1);
  });
});
