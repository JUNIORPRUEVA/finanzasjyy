/**
 * LECTURA DE FACTURAS: NORMALIZACIÓN
 * ==================================
 * La IA devuelve texto; antes de tocar nada, todo pasa por aquí:
 *   · Los importes se convierten a texto decimal con dos cifras (nada de float).
 *   · Las fechas se validan como YYYY-MM-DD y, si no son válidas, se descartan.
 *   · Si una línea no trae precio total pero sí cantidad y precio unitario, se
 *     calcula; si no hay suficiente información, el precio queda vacío (y la
 *     pantalla lo pide) en lugar de inventarlo.
 *
 * Este módulo es puro a propósito: se puede probar con las respuestas raras que
 * dan los modelos (números, comas decimales, «RD$ 1,234.50», nulos…).
 */

export interface InvoiceLineDraft {
  name: string;
  /** Cantidad como texto decimal (máximo 3 decimales). */
  quantity: string;
  unit: string | null;
  /** Precio por unidad, texto decimal. */
  unitPrice: string | null;
  /** Importe de la línea, texto decimal. */
  total: string | null;
  /** Categoría de gasto que sugiere el modelo (nombre, no id). */
  suggestedCategory: string | null;
}

export interface InvoiceDraft {
  supplier: string | null;
  date: string | null;
  currency: string | null;
  total: string | null;
  taxAmount: string | null;
  lines: InvoiceLineDraft[];
  /** Avisos que la pantalla muestra al usuario (no son errores). */
  warnings: string[];
}

export const EMPTY_INVOICE: InvoiceDraft = {
  supplier: null,
  date: null,
  currency: null,
  total: null,
  taxAmount: null,
  lines: [],
  warnings: [],
};

export class InvoiceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceParseError';
  }
}

const MAX_LINES = 200;

/**
 * Convierte lo que venga (número, texto, «RD$ 1,234.50», «1.234,50») a texto
 * decimal con dos cifras. Devuelve null si no hay un número razonable.
 */
export function toMoneyText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2) : null;
  }
  if (typeof value !== 'string') {
    return null;
  }

  let text = value.trim().replace(/[^\d.,-]/g, '');
  if (text.length === 0) {
    return null;
  }

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Hay los dos separadores: el que aparece al final es el decimal.
    text = lastComma > lastDot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // «1,234» es mil doscientos treinta y cuatro; «1,5» es uno con cinco.
    const decimals = text.length - lastComma - 1;
    text = decimals === 3 ? text.replace(/,/g, '') : text.replace(',', '.');
  } else if (lastDot >= 0) {
    // «1.234» se lee como miles salvo que el entero sea 0 («0.500» = medio).
    const decimals = text.length - lastDot - 1;
    const integerPart = text.slice(0, lastDot);
    if (decimals === 3 && integerPart !== '0') {
      text = text.replace(/\./g, '');
    }
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return (Math.round((parsed + Number.EPSILON) * 100) / 100).toFixed(2);
}

/** Cantidad con hasta 3 decimales; por defecto 1. */
export function toQuantityText(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '1';
  }
  const asNumber = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(asNumber) || asNumber <= 0) {
    return '1';
  }
  const clamped = Math.min(asNumber, 1_000_000);
  return (Math.round(clamped * 1000) / 1000).toFixed(3).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') || '1';
}

/** Fecha ISO corta válida, o null. */
export function toDateText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) {
    return null;
  }
  return `${year}-${month}-${day}`;
}

/** Moneda de tres letras, o null. */
export function toCurrencyText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(text) ? text : null;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length === 0 ? null : text.slice(0, max);
}

/**
 * Normaliza la respuesta del modelo. Es tolerante: si algo no encaja, se anota
 * un aviso y se sigue, porque el usuario revisa y corrige antes de guardar.
 */
export function parseInvoiceDraft(raw: unknown): InvoiceDraft {
  if (!raw || typeof raw !== 'object') {
    throw new InvoiceParseError('La respuesta no es un objeto con la factura');
  }

  const source = raw as Record<string, unknown>;
  const rawLines = Array.isArray(source.lines) ? source.lines : Array.isArray(source.lineas) ? source.lineas : [];

  const warnings: string[] = [];
  const lines: InvoiceLineDraft[] = [];

  for (const candidate of rawLines.slice(0, MAX_LINES)) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const row = candidate as Record<string, unknown>;
    const name = cleanText(row.name ?? row.nombre ?? row.description ?? row.descripcion, 120);
    if (!name) {
      continue;
    }

    const quantity = toQuantityText(row.quantity ?? row.cantidad);
    const unitPrice = toMoneyText(row.unitPrice ?? row.precioUnitario ?? row.price ?? row.precio);
    const declaredTotal = toMoneyText(row.total ?? row.importe ?? row.subtotal);

    let total = declaredTotal;
    if (total === null && unitPrice !== null) {
      total = (Number(quantity) * Number(unitPrice)).toFixed(2);
    }
    if (total === null) {
      warnings.push(`«${name}» no trae precio: se queda en blanco para que lo complete.`);
    }

    lines.push({
      name,
      quantity,
      unit: cleanText(row.unit ?? row.unidad, 16),
      unitPrice,
      total,
      suggestedCategory: cleanText(row.category ?? row.categoria ?? row.suggestedCategory, 80),
    });
  }

  if (lines.length === 0) {
    throw new InvoiceParseError('No se reconoció ningún producto en la factura');
  }

  const sums = lines.reduce((acc, line) => acc + (line.total === null ? 0 : Number(line.total)), 0);
  const declared = toMoneyText(source.total);

  // Si el total de la factura no coincide con la suma, se avisa: puede faltar una
  // línea o venir mal un precio. Nunca se corrige solo.
  if (declared !== null && Math.abs(sums - Number(declared)) > 0.05) {
    warnings.push(
      `La suma de las líneas (${sums.toFixed(2)}) no coincide con el total de la factura (${declared}). Revise si falta algún producto.`,
    );
  }

  return {
    supplier: cleanText(source.supplier ?? source.proveedor ?? source.merchant, 80),
    date: toDateText(source.date ?? source.fecha),
    currency: toCurrencyText(source.currency ?? source.moneda),
    total: declared ?? (lines.length > 0 ? sums.toFixed(2) : null),
    taxAmount: toMoneyText(source.taxAmount ?? source.impuesto ?? source.itbis),
    lines,
    warnings,
  };
}
