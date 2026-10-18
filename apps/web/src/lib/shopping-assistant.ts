/**
 * ASISTENTE DE LA LISTA DE COMPRAS
 * ================================
 * Ordena la compra por pasillos y avisa de lo que falta para que la compra sea
 * sensata. Todo se calcula EN EL DISPOSITIVO: no se envía ni un nombre de
 * producto a ningún servidor externo. Se puede usar sin conexión, en el
 * supermercado, y responde al instante.
 *
 * Qué NO es: no es un modelo de lenguaje. Es un clasificador con un diccionario
 * de productos frecuentes en República Dominicana (Iberia, Nacional, Jumbo,
 * Bravo…). Acierta con lo común y, cuando no reconoce algo, lo deja en «Otros»
 * en vez de inventarse un pasillo. Si algún día se conecta un modelo real, esta
 * interfaz (`classifyItem`, `groupItems`, `nutritionAdvice`) es la que hay que
 * sustituir, y el resto de la aplicación no cambia.
 */

/** Pasillos, en el orden en que se recorre un supermercado (no alfabético). */
export const SHOPPING_GROUPS = [
  { id: 'frutas', label: 'Frutas y verduras', emoji: '🥬' },
  { id: 'carnes', label: 'Carnes, pollo y pescado', emoji: '🍗' },
  { id: 'lacteos', label: 'Lácteos y huevos', emoji: '🥛' },
  { id: 'panaderia', label: 'Panadería', emoji: '🍞' },
  { id: 'despensa', label: 'Despensa', emoji: '🥫' },
  { id: 'congelados', label: 'Congelados', emoji: '🧊' },
  { id: 'bebidas', label: 'Bebidas', emoji: '🧃' },
  { id: 'snacks', label: 'Snacks y dulces', emoji: '🍪' },
  { id: 'limpieza', label: 'Limpieza del hogar', emoji: '🧽' },
  { id: 'higiene', label: 'Higiene y cuidado personal', emoji: '🧼' },
  { id: 'bebes', label: 'Bebés', emoji: '🍼' },
  { id: 'mascotas', label: 'Mascotas', emoji: '🐶' },
  { id: 'otros', label: 'Otros', emoji: '🛒' },
] as const;

export type ShoppingGroupId = (typeof SHOPPING_GROUPS)[number]['id'];

/**
 * Diccionario de productos → pasillo.
 *
 * Se compara sobre el texto SIN acentos y en minúsculas, y con el plural
 * tolerado («huevos» y «huevo» caen en el mismo sitio). Gana la coincidencia más
 * LARGA, para que «leche en polvo» (despensa) no acabe en lácteos por «leche».
 */
const KEYWORDS: Array<[palabra: string, group: ShoppingGroupId]> = [
  // --- Frutas y verduras ---
  ['manzana', 'frutas'], ['platano', 'frutas'], ['guineo', 'frutas'], ['naranja', 'frutas'],
  ['limon', 'frutas'], ['tomate', 'frutas'], ['cebolla', 'frutas'], ['ajo', 'frutas'],
  ['papa', 'frutas'], ['yuca', 'frutas'], ['yautia', 'frutas'], ['batata', 'frutas'],
  ['zanahoria', 'frutas'], ['lechuga', 'frutas'], ['repollo', 'frutas'], ['pepino', 'frutas'],
  ['pimiento', 'frutas'], ['aji', 'frutas'], ['cilantro', 'frutas'], ['perejil', 'frutas'],
  ['apio', 'frutas'], ['brocoli', 'frutas'], ['coliflor', 'frutas'], ['espinaca', 'frutas'],
  ['aguacate', 'frutas'], ['mango', 'frutas'], ['pina', 'frutas'], ['papaya', 'frutas'],
  ['sandia', 'frutas'], ['melon', 'frutas'], ['uva', 'frutas'], ['fresa', 'frutas'],
  ['pera', 'frutas'], ['durazno', 'frutas'], ['kiwi', 'frutas'], ['habichuela', 'frutas'],
  ['guandul', 'frutas'], ['berenjena', 'frutas'], ['calabaza', 'frutas'], ['remolacha', 'frutas'],
  ['rabano', 'frutas'], ['jengibre', 'frutas'], ['toronja', 'frutas'], ['mandarina', 'frutas'],
  ['coco', 'frutas'], ['vegetal', 'frutas'], ['verdura', 'frutas'], ['fruta', 'frutas'],
  ['ensalada', 'frutas'],

  // --- Carnes, pollo y pescado ---
  ['pechuga', 'carnes'], ['muslo', 'carnes'], ['pollo', 'carnes'], ['carne de res', 'carnes'],
  ['carne', 'carnes'], ['cerdo', 'carnes'], ['chuleta', 'carnes'], ['costilla', 'carnes'],
  ['salami', 'carnes'], ['salchicha', 'carnes'], ['tocineta', 'carnes'], ['jamon', 'carnes'],
  ['pescado', 'carnes'], ['tilapia', 'carnes'], ['merluza', 'carnes'], ['camaron', 'carnes'],
  ['langosta', 'carnes'], ['molida', 'carnes'], ['bistec', 'carnes'], ['higado', 'carnes'],
  ['chorizo', 'carnes'], ['longaniza', 'carnes'], ['pavo', 'carnes'], ['salmon', 'carnes'],

  // --- Lácteos y huevos ---
  ['huevo', 'lacteos'], ['queso', 'lacteos'], ['yogurt', 'lacteos'], ['yogur', 'lacteos'],
  ['mantequilla', 'lacteos'], ['margarina', 'lacteos'], ['crema', 'lacteos'], ['nata', 'lacteos'],
  ['requeson', 'lacteos'], ['cuajada', 'lacteos'], ['leche', 'lacteos'],

  // --- Panadería ---
  ['pan de', 'panaderia'], ['pan integral', 'panaderia'], ['pan', 'panaderia'],
  ['baguette', 'panaderia'], ['arepa', 'panaderia'], ['tortilla', 'panaderia'],
  ['bizcocho', 'panaderia'], ['croissant', 'panaderia'], ['hojaldre', 'panaderia'],
  ['panqueque', 'panaderia'], ['masa', 'panaderia'],

  // --- Despensa ---
  ['leche en polvo', 'despensa'], ['arroz', 'despensa'], ['pasta', 'despensa'],
  ['espagueti', 'despensa'], ['fideo', 'despensa'], ['aceite', 'despensa'], ['vinagre', 'despensa'],
  ['sal', 'despensa'], ['azucar', 'despensa'], ['cafe', 'despensa'], ['te', 'despensa'],
  ['avena', 'despensa'], ['harina', 'despensa'], ['maiz', 'despensa'], ['lenteja', 'despensa'],
  ['garbanzo', 'despensa'], ['atun', 'despensa'], ['sardina', 'despensa'], ['enlatad', 'despensa'],
  ['salsa', 'despensa'], ['catsup', 'despensa'], ['ketchup', 'despensa'], ['mayonesa', 'despensa'],
  ['mostaza', 'despensa'], ['adobo', 'despensa'], ['oregano', 'despensa'], ['comino', 'despensa'],
  ['pimienta', 'despensa'], ['caldo', 'despensa'], ['sopa', 'despensa'], ['cereal', 'despensa'],
  ['mantequilla de mani', 'despensa'], ['miel', 'despensa'], ['mermelada', 'despensa'],
  ['chocolate en polvo', 'despensa'], ['levadura', 'despensa'], ['vinagre', 'despensa'],
  ['aceituna', 'despensa'], ['frijol', 'despensa'], ['guandules enlatados', 'despensa'],

  // --- Congelados ---
  ['congelad', 'congelados'], ['helado', 'congelados'], ['nuggets', 'congelados'],
  ['pizza congelada', 'congelados'], ['papas fritas congeladas', 'congelados'],

  // --- Bebidas ---
  ['agua', 'bebidas'], ['refresco', 'bebidas'], ['soda', 'bebidas'], ['jugo', 'bebidas'],
  ['cerveza', 'bebidas'], ['vino', 'bebidas'], ['ron', 'bebidas'], ['whisky', 'bebidas'],
  ['energetica', 'bebidas'], ['malta', 'bebidas'], ['batida', 'bebidas'], ['gaseosa', 'bebidas'],

  // --- Snacks y dulces ---
  ['galleta', 'snacks'], ['papitas', 'snacks'], ['chitos', 'snacks'], ['snack', 'snacks'],
  ['chocolate', 'snacks'], ['caramelo', 'snacks'], ['dulce', 'snacks'], ['mani', 'snacks'],
  ['nuez', 'snacks'], ['palomitas', 'snacks'], ['doritos', 'snacks'], ['platanitos', 'snacks'],
  ['golosina', 'snacks'],

  // --- Limpieza del hogar ---
  ['detergente', 'limpieza'], ['cloro', 'limpieza'], ['lejia', 'limpieza'],
  ['suavizante', 'limpieza'], ['desinfectante', 'limpieza'], ['limpiador', 'limpieza'],
  ['esponja', 'limpieza'], ['funda', 'limpieza'], ['bolsa de basura', 'limpieza'],
  ['papel toalla', 'limpieza'], ['servilleta', 'limpieza'], ['fregona', 'limpieza'],
  ['escoba', 'limpieza'], ['ambientador', 'limpieza'], ['lavaloza', 'limpieza'],
  ['jabon de fregar', 'limpieza'], ['insecticida', 'limpieza'], ['suavitel', 'limpieza'],

  // --- Higiene y cuidado personal ---
  ['papel higienico', 'higiene'], ['jabon', 'higiene'], ['shampoo', 'higiene'],
  ['champu', 'higiene'], ['acondicionador', 'higiene'], ['pasta dental', 'higiene'],
  ['cepillo de dientes', 'higiene'], ['desodorante', 'higiene'], ['afeitadora', 'higiene'],
  ['toallas sanitarias', 'higiene'], ['tampones', 'higiene'], ['protector solar', 'higiene'],
  ['enjuague bucal', 'higiene'], ['crema corporal', 'higiene'], ['seda dental', 'higiene'],

  // --- Bebés ---
  ['panal', 'bebes'], ['toallitas', 'bebes'], ['formula', 'bebes'], ['biberon', 'bebes'],
  ['compota', 'bebes'], ['cereal de bebe', 'bebes'],

  // --- Mascotas ---
  ['perro', 'mascotas'], ['gato', 'mascotas'], ['croqueta', 'mascotas'],
  ['alimento para mascota', 'mascotas'], ['arena para gato', 'mascotas'], ['collar', 'mascotas'],
];

/** Quita acentos y pasa a minúsculas: «Plátano» → «platano». */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Quita el plural simple: «huevos» → «huevo», «manzanas» → «manzana». */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith('es')) {
    return word.slice(0, -2);
  }
  if (word.length > 3 && word.endsWith('s')) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * Devuelve el pasillo de un producto. Si no reconoce nada devuelve `otros`:
 * preferimos dejarlo sin clasificar antes que mandarlo a un pasillo equivocado.
 */
export function classifyItem(name: string): ShoppingGroupId {
  const texto = fold(name);
  if (!texto) {
    return 'otros';
  }
  const conSingular = texto
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular)
    .join(' ');

  let mejor: { largo: number; group: ShoppingGroupId } | null = null;
  for (const [palabra, group] of KEYWORDS) {
    const clave = fold(palabra);
    const estaEnTexto = texto.includes(clave) || conSingular.includes(clave);
    if (estaEnTexto && (!mejor || clave.length > mejor.largo)) {
      mejor = { largo: clave.length, group };
    }
  }
  return mejor?.group ?? 'otros';
}

export interface GroupableItem {
  name: string;
}

export interface ItemGroup<T> {
  id: ShoppingGroupId;
  label: string;
  emoji: string;
  items: T[];
}

/**
 * Agrupa por pasillo respetando el orden del supermercado. Dentro de cada grupo
 * se conserva el orden en que el usuario añadió los productos.
 */
export function groupItems<T extends GroupableItem>(items: T[]): Array<ItemGroup<T>> {
  const porGrupo = new Map<ShoppingGroupId, T[]>();
  for (const item of items) {
    const grupo = classifyItem(item.name);
    const actual = porGrupo.get(grupo);
    if (actual) {
      actual.push(item);
    } else {
      porGrupo.set(grupo, [item]);
    }
  }

  return SHOPPING_GROUPS.filter((grupo) => porGrupo.has(grupo.id)).map((grupo) => ({
    id: grupo.id,
    label: grupo.label,
    emoji: grupo.emoji,
    items: porGrupo.get(grupo.id) ?? [],
  }));
}

/**
 * Consejos para que la compra sea buena: se fijan en la COMPOSICIÓN de la lista
 * (pasillos presentes y proporción), no en el nombre de la persona. Son
 * observaciones, no órdenes: la decisión es del usuario.
 */
export function nutritionAdvice(items: GroupableItem[]): string[] {
  if (items.length === 0) {
    return ['Añada productos y le diré cómo va la compra.'];
  }

  const cuenta = new Map<ShoppingGroupId, number>();
  for (const item of items) {
    const grupo = classifyItem(item.name);
    cuenta.set(grupo, (cuenta.get(grupo) ?? 0) + 1);
  }
  const hay = (grupo: ShoppingGroupId) => (cuenta.get(grupo) ?? 0) > 0;
  const cuantos = (grupo: ShoppingGroupId) => cuenta.get(grupo) ?? 0;
  const total = items.length;

  const consejos: string[] = [];

  if (!hay('frutas')) {
    consejos.push('No hay frutas ni verduras: es lo primero que conviene añadir en una compra semanal.');
  }

  if (!hay('carnes') && !hay('lacteos') && !hay('despensa')) {
    consejos.push('No veo ninguna fuente de proteína (pollo, pescado, huevos, granos). La lista quedaría incompleta.');
  }

  const snacks = cuantos('snacks');
  const bebidas = cuantos('bebidas');
  if (snacks > 0 && snacks / total >= 0.35) {
    consejos.push(
      `${snacks} de ${total} productos son snacks o dulces. Están bien como gusto; si busca comer mejor, baje esa proporción.`,
    );
  }
  if (bebidas > 0) {
    consejos.push('Incluya agua: es la bebida que nunca sobra y la que menos cuesta por litro.');
  }

  const pasillos = SHOPPING_GROUPS.filter((grupo) => hay(grupo.id) && grupo.id !== 'otros').length;
  if (pasillos >= 6) {
    consejos.push(`La compra toca ${pasillos} pasillos distintos: es una compra completa, no de emergencia.`);
  }

  if (hay('congelados') && hay('carnes')) {
    consejos.push('Si compra carne y congelados, déjelos para el final del recorrido para que no se rompa la cadena de frío.');
  }

  if (consejos.length === 0) {
    consejos.push('La lista se ve equilibrada: hay frescos, proteína y despensa.');
  }

  return consejos.slice(0, 4);
}

/** Texto plano listo para pegar en WhatsApp o enviar por Bluetooth. */
export function listToPlainText(input: {
  name: string;
  entityName?: string | null;
  plannedDate?: string | null;
  items: GroupableItem[];
  currency?: string;
  total?: string;
}): string {
  const lineas: string[] = [];
  lineas.push(`🛒 ${input.name}`);
  if (input.entityName) {
    lineas.push(input.entityName);
  }
  if (input.plannedDate) {
    lineas.push(`Para el ${input.plannedDate}`);
  }
  lineas.push('');

  for (const grupo of groupItems(input.items)) {
    lineas.push(`${grupo.emoji} ${grupo.label.toUpperCase()}`);
    for (const item of grupo.items) {
      lineas.push(`  ☐ ${item.name}`);
    }
    lineas.push('');
  }

  if (input.total && input.total !== '0.00') {
    lineas.push(`Total estimado: ${input.total} ${input.currency ?? ''}`.trim());
  }
  lineas.push('— Hecho con FINANZA');

  return lineas.join('\n');
}
