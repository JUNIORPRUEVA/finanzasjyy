import { catalogTrend, mergeCatalogEntry, normalizeProductName, sortCatalog, usableCatalogLines } from './catalog.js';

/**
 * CATÁLOGO DE PRODUCTOS
 * =====================
 * Lo que se comprueba: que dos formas de escribir el mismo producto acaben en
 * una sola ficha, que el último precio y el mínimo/máximo se actualicen bien, y
 * que una línea sin precio no ensucie el catálogo.
 */

describe('nombre normalizado', () => {
  it('junta las formas de escribir lo mismo', () => {
    expect(normalizeProductName('Arroz 5 lb')).toBe('arroz 5 lb');
    expect(normalizeProductName('  ARROZ   5  LB ')).toBe('arroz 5 lb');
    expect(normalizeProductName('Arroz 5lb')).toBe('arroz 5lb');
    expect(normalizeProductName('Aceitúna verde')).toBe('aceituna verde');
    expect(normalizeProductName('Leche (1 L)')).toBe('leche 1 l');
  });
});

describe('ficha del producto', () => {
  it('la primera compra crea la ficha con su precio', () => {
    const estado = mergeCatalogEntry(null, { name: 'Arroz 5 lb', unit: 'unidad', unitPrice: 250, quantity: 2 });
    expect(estado).toMatchObject({
      name: 'Arroz 5 lb',
      unit: 'unidad',
      lastUnitPrice: 250,
      minUnitPrice: 250,
      maxUnitPrice: 250,
      timesPurchased: 1,
      lastQuantity: 2,
    });
  });

  it('la segunda compra actualiza último, mínimo y máximo', () => {
    const primera = mergeCatalogEntry(null, { name: 'Arroz', unit: 'lb', unitPrice: 100, quantity: 1 });
    const segunda = mergeCatalogEntry(primera, { name: 'Arroz', unit: 'lb', unitPrice: 130, quantity: 3, supplier: 'Nacional' });

    expect(segunda.lastUnitPrice).toBe(130);
    expect(segunda.minUnitPrice).toBe(100);
    expect(segunda.maxUnitPrice).toBe(130);
    expect(segunda.timesPurchased).toBe(2);
    expect(segunda.lastSupplier).toBe('Nacional');
  });

  it('un precio más bajo también mueve el mínimo y conserva el máximo', () => {
    const primera = mergeCatalogEntry(null, { name: 'Aceite', unit: 'litro', unitPrice: 300, quantity: 1 });
    const segunda = mergeCatalogEntry(primera, { name: 'Aceite', unit: 'litro', unitPrice: 250, quantity: 1 });

    expect(segunda).toMatchObject({ lastUnitPrice: 250, minUnitPrice: 250, maxUnitPrice: 300 });
  });
});

describe('líneas que alimentan el catálogo', () => {
  it('descarta lo que no tiene precio y lo que no tiene nombre', () => {
    const lines = usableCatalogLines([
      { name: 'Arroz', unit: 'lb', unitPrice: 100, quantity: 1 },
      { name: 'Sin precio', unit: null, unitPrice: null, quantity: 1 },
      { name: 'Precio cero', unit: null, unitPrice: 0, quantity: 1 },
      { name: '   ', unit: null, unitPrice: 50, quantity: 1 },
    ]);

    expect(lines.map((line) => line.name)).toEqual(['Arroz']);
    expect(lines[0]?.key).toBe('arroz');
  });

  it('redondea el precio a dos decimales', () => {
    const [line] = usableCatalogLines([{ name: 'Pan', unit: null, unitPrice: 99.999, quantity: 1 }]);
    expect(line?.unitPrice).toBe(100);
  });
});

describe('orden y tendencia', () => {
  const fila = (name: string, times: number, last: number | null, min: number | null, seen: string) => ({
    name,
    unit: null,
    lastUnitPrice: last,
    minUnitPrice: min,
    maxUnitPrice: last,
    timesPurchased: times,
    lastSupplier: null,
    lastSeenAt: seen,
  });

  it('ordena por veces comprado y, en empate, por lo más reciente', () => {
    const orden = sortCatalog([
      fila('Pan', 2, 60, 50, '2026-11-01'),
      fila('Leche', 5, 70, 65, '2026-10-01'),
      fila('Huevos', 2, 90, 80, '2026-11-10'),
    ]).map((row) => row.name);

    expect(orden).toEqual(['Leche', 'Huevos', 'Pan']);
  });

  it('la tendencia compara el último precio con el mínimo pagado', () => {
    expect(catalogTrend(fila('Arroz', 3, 130, 100, '2026-11-01'))).toBe(30);
    expect(catalogTrend(fila('Arroz', 3, 100, 100, '2026-11-01'))).toBe(0);
    expect(catalogTrend(fila('Arroz', 1, null, null, '2026-11-01'))).toBeNull();
  });
});
