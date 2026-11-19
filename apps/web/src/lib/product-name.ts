/**
 * NOMBRE DE PRODUCTO (lado del navegador)
 * =======================================
 * La misma normalización que usa el servidor para el catálogo: minúsculas, sin
 * acentos, sin signos y con un solo espacio. Así «Arroz 5 lb» y «arroz 5 LB»
 * se reconocen como el mismo producto al buscar su último precio.
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
