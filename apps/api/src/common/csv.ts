/**
 * SERIALIZACIÓN CSV
 * -----------------
 * Exportaciones reproducibles: los mismos datos producen exactamente el mismo
 * archivo. Se exportan los importes como texto decimal (nunca como número
 * flotante) para que la hoja de cálculo no pierda precisión.
 */

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

/** Escapa un valor según RFC 4180. */
function escapeCsvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = String(value);
  if (/[",;\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv<T>(rows: T[], columns: Array<CsvColumn<T>>): string {
  const header = columns.map((column) => escapeCsvValue(column.header)).join(',');
  const lines = rows.map((row) => columns.map((column) => escapeCsvValue(column.value(row))).join(','));
  return [header, ...lines].join('\r\n');
}

/**
 * BOM UTF-8: sin él, Excel en español muestra los acentos corruptos.
 */
export const CSV_BOM = '\uFEFF';

export function csvResponse(filename: string, content: string): {
  filename: string;
  contentType: string;
  body: string;
} {
  return {
    filename,
    contentType: 'text/csv; charset=utf-8',
    body: `${CSV_BOM}${content}`,
  };
}
