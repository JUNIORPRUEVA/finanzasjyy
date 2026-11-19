/**
 * CATÁLOGO DE PRODUCTOS (lógica pura)
 * ===================================
 * Convierte lo que se compró en una ficha por producto: nombre normalizado,
 * último precio, mínimo, máximo y cuántas veces se compró.
 *
 * El nombre normalizado es la clave: «Arroz 5 lb», «arroz 5 LB» y «Arroz  5lb»
 * son la misma ficha. Sin esto el catálogo se llena de duplicados y deja de
 * servir para comparar precios.
 */

export interface CatalogLine {
  name: string;
  unit: string | null;
  /** Precio por unidad. Si es null o 0, la línea no aporta precio. */
  unitPrice: number | null;
  quantity: number | null;
  supplier?: string | null;
}

export interface CatalogState {
  name: string;
  unit: string | null;
  lastUnitPrice: number;
  minUnitPrice: number;
  maxUnitPrice: number;
  lastQuantity: number | null;
  lastSupplier: string | null;
  timesPurchased: number;
}

/**
 * Clave del producto: minúsculas, sin acentos, sin signos y con un solo espacio.
 * «Arroz 5 lb» → «arroz 5 lb».
 */
export function normalizeProductName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ% ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Une lo que ya había en el catálogo con una compra nueva.
 * `previous` es null la primera vez.
 */
export function mergeCatalogEntry(previous: CatalogState | null, line: CatalogLine): CatalogState {
  const price = Math.round(((line.unitPrice ?? 0) + Number.EPSILON) * 100) / 100;
  const name = line.name.trim().slice(0, 120);

  if (!previous) {
    return {
      name,
      unit: line.unit,
      lastUnitPrice: price,
      minUnitPrice: price,
      maxUnitPrice: price,
      lastQuantity: line.quantity,
      lastSupplier: line.supplier ?? null,
      timesPurchased: 1,
    };
  }

  return {
    name,
    unit: line.unit ?? previous.unit,
    lastUnitPrice: price,
    minUnitPrice: Math.min(previous.minUnitPrice, price),
    maxUnitPrice: Math.max(previous.maxUnitPrice, price),
    lastQuantity: line.quantity ?? previous.lastQuantity,
    lastSupplier: line.supplier ?? previous.lastSupplier,
    timesPurchased: previous.timesPurchased + 1,
  };
}

/**
 * Líneas que sí alimentan el catálogo: con nombre y con precio mayor que cero.
 * Una línea sin precio no enseña nada sobre cuánto cuesta.
 */
export function usableCatalogLines(lines: CatalogLine[]): Array<CatalogLine & { key: string; unitPrice: number }> {
  const result: Array<CatalogLine & { key: string; unitPrice: number }> = [];
  for (const line of lines) {
    const key = normalizeProductName(line.name);
    if (key.length < 2) {
      continue;
    }
    if (line.unitPrice === null || !Number.isFinite(line.unitPrice) || line.unitPrice <= 0) {
      continue;
    }
    result.push({ ...line, key, unitPrice: Math.round((line.unitPrice + Number.EPSILON) * 100) / 100 });
  }
  return result;
}

export interface CatalogRow {
  name: string;
  unit: string | null;
  lastUnitPrice: number | null;
  minUnitPrice: number | null;
  maxUnitPrice: number | null;
  timesPurchased: number;
  lastSupplier: string | null;
  lastSeenAt: string | null;
}

/** Orden útil para la pantalla: lo que más se repite y lo último visto. */
export function sortCatalog(rows: CatalogRow[]): CatalogRow[] {
  return rows.slice().sort((a, b) => {
    if (b.timesPurchased !== a.timesPurchased) {
      return b.timesPurchased - a.timesPurchased;
    }
    return (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '');
  });
}

/** Variación de precio entre el mínimo y el último: positiva = está más caro. */
export function catalogTrend(row: CatalogRow): number | null {
  if (row.lastUnitPrice === null || row.minUnitPrice === null || row.minUnitPrice <= 0) {
    return null;
  }
  return Math.round(((row.lastUnitPrice - row.minUnitPrice) / row.minUnitPrice) * 1000) / 10;
}
