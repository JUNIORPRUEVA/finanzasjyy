/**
 * PLANTILLAS DE COMPRA
 * ====================
 * Listas de arranque para lo que se repite: la compra semanal, la despensa, la
 * limpieza del mes, la higiene y el desayuno. Evitan teclear veinte productos
 * cada vez que se va al supermercado.
 *
 * DOS DECISIONES DELIBERADAS:
 *
 *  · **Sin precios.** Un precio de plantilla sería un número inventado que
 *    terminaría sumando en «estimado» y falseando lo que va a gastar. El precio
 *    lo pone usted (o ningún precio, que también vale).
 *
 *  · **Sin duplicados.** Al aplicar una plantilla se saltan los productos que ya
 *    están en la lista, así que se puede usar dos veces sin miedo.
 *
 * Los nombres están elegidos para que el clasificador de pasillos los reconozca:
 * una plantilla cuyos productos cayeran en «Otros» no ordenaría nada en la tienda.
 */

export interface PlantillaItem {
  name: string;
  quantity: string;
}

export interface Plantilla {
  id: string;
  label: string;
  description: string;
  emoji: string;
  items: PlantillaItem[];
}

export const PLANTILLAS: Plantilla[] = [
  {
    id: 'semanal',
    label: 'Compra semanal equilibrada',
    description: 'Frescos, proteína y despensa para una semana. Lo básico que no debería faltar.',
    emoji: '🛒',
    items: [
      { name: 'Plátano', quantity: '6' },
      { name: 'Manzana', quantity: '6' },
      { name: 'Tomate', quantity: '1.5' },
      { name: 'Cebolla', quantity: '2' },
      { name: 'Lechuga', quantity: '1' },
      { name: 'Zanahoria', quantity: '1' },
      { name: 'Pechuga de pollo', quantity: '2' },
      { name: 'Huevos', quantity: '30' },
      { name: 'Leche', quantity: '4' },
      { name: 'Queso', quantity: '1' },
      { name: 'Arroz', quantity: '5' },
      { name: 'Espagueti', quantity: '2' },
      { name: 'Aceite', quantity: '1' },
      { name: 'Atún', quantity: '3' },
      { name: 'Pan de agua', quantity: '3' },
      { name: 'Café', quantity: '1' },
      { name: 'Agua', quantity: '6' },
    ],
  },
  {
    id: 'despensa',
    label: 'Despensa básica',
    description: 'Lo que se guarda y no se echa a perder. Sirve para no quedarse sin fondo de armario.',
    emoji: '🥫',
    items: [
      { name: 'Arroz', quantity: '10' },
      { name: 'Lentejas', quantity: '2' },
      { name: 'Espagueti', quantity: '3' },
      { name: 'Aceite', quantity: '2' },
      { name: 'Azúcar', quantity: '2' },
      { name: 'Sal', quantity: '1' },
      { name: 'Harina', quantity: '1' },
      { name: 'Atún', quantity: '4' },
      { name: 'Salsa', quantity: '2' },
      { name: 'Vinagre', quantity: '1' },
      { name: 'Avena', quantity: '1' },
      { name: 'Café', quantity: '2' },
      { name: 'Maíz', quantity: '1' },
      { name: 'Miel', quantity: '1' },
    ],
  },
  {
    id: 'limpieza',
    label: 'Limpieza del mes',
    description: 'Los productos de limpieza que se acaban sin avisar.',
    emoji: '🧽',
    items: [
      { name: 'Detergente', quantity: '1' },
      { name: 'Cloro', quantity: '1' },
      { name: 'Suavizante', quantity: '1' },
      { name: 'Desinfectante', quantity: '1' },
      { name: 'Esponja', quantity: '3' },
      { name: 'Bolsas de basura', quantity: '1' },
      { name: 'Papel toalla', quantity: '2' },
      { name: 'Servilletas', quantity: '2' },
      { name: 'Lavaloza', quantity: '1' },
      { name: 'Ambientador', quantity: '1' },
    ],
  },
  {
    id: 'higiene',
    label: 'Higiene personal',
    description: 'Cuidado personal para el mes: se repone de una vez.',
    emoji: '🧼',
    items: [
      { name: 'Papel higiénico', quantity: '12' },
      { name: 'Jabón', quantity: '2' },
      { name: 'Shampoo', quantity: '1' },
      { name: 'Pasta dental', quantity: '2' },
      { name: 'Cepillo de dientes', quantity: '2' },
      { name: 'Desodorante', quantity: '1' },
      { name: 'Afeitadora', quantity: '1' },
      { name: 'Enjuague bucal', quantity: '1' },
    ],
  },
  {
    id: 'desayuno',
    label: 'Desayuno de la semana',
    description: 'Para que la semana empiece con algo en el estómago, no con prisa.',
    emoji: '🍞',
    items: [
      { name: 'Huevos', quantity: '15' },
      { name: 'Pan de agua', quantity: '4' },
      { name: 'Leche', quantity: '2' },
      { name: 'Avena', quantity: '1' },
      { name: 'Café', quantity: '1' },
      { name: 'Mantequilla', quantity: '1' },
      { name: 'Plátano', quantity: '6' },
      { name: 'Queso', quantity: '1' },
    ],
  },
];

/** Quita acentos, mayúsculas y espacios de más: «Plátano  Verde» ≡ «platano verde». */
function normalizar(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Productos de la plantilla que aún NO están en la lista, comparando por nombre.
 * Así se puede aplicar la misma plantilla dos semanas seguidas sin duplicar nada.
 */
export function productosNuevos(
  plantilla: Plantilla,
  existentes: Array<{ name: string }>,
): { nuevos: PlantillaItem[]; repetidos: number } {
  const yaEstan = new Set(existentes.map((item) => normalizar(item.name)));
  const nuevos = plantilla.items.filter((item) => !yaEstan.has(normalizar(item.name)));
  return { nuevos, repetidos: plantilla.items.length - nuevos.length };
}
