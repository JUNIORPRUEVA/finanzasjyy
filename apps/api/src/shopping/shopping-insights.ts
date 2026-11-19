/**
 * ANÁLISIS DE COMPRAS (SIN IA)
 * ============================
 * Todo lo que se puede saber con los datos que ya están guardados, calculado
 * aquí y no en el móvil:
 *   · Cuánto se ha gastado este mes y cuál es el ticket medio.
 *   · Qué productos se repiten y cómo ha cambiado su precio.
 *   · Qué grupos de alimentos aparecen y cuáles faltan.
 *   · Consejos concretos de aprovechamiento y de equilibrio.
 *
 * Es lógica PURA (sin base de datos ni red) para poder probarla con casos reales
 * y para que la misma regla valga aunque mañana se cambie la pantalla.
 *
 * Aviso importante sobre el lenguaje: esto orienta la compra, no da consejo
 * médico. Nunca se afirma que un alimento «cura» ni se etiqueta a nadie.
 */

/** Grupos con los que se mira el equilibrio de la compra. */
export type FoodGroup =
  | 'frutas'
  | 'verduras'
  | 'proteinas'
  | 'lacteos'
  | 'cereales'
  | 'legumbres'
  | 'grasas'
  | 'procesados'
  | 'bebidas'
  | 'hogar'
  | 'otros';

export const FOOD_GROUP_LABELS: Record<FoodGroup, string> = {
  frutas: 'Frutas',
  verduras: 'Verduras y hortalizas',
  proteinas: 'Carnes, pescados y huevos',
  lacteos: 'Lácteos',
  cereales: 'Cereales y tubérculos',
  legumbres: 'Legumbres',
  grasas: 'Aceites y frutos secos',
  procesados: 'Ultraprocesados y snacks',
  bebidas: 'Bebidas',
  hogar: 'Hogar y limpieza',
  otros: 'Otros',
};

/**
 * Palabras clave por grupo. Se comparan en minúsculas y sin acentos, y basta con
 * que aparezca una para clasificar el producto. El orden importa: «pan integral»
 * es cereal y «snack» es procesado, aunque lleven otras palabras.
 */
const GROUP_KEYWORDS: Array<{ group: FoodGroup; words: string[] }> = [
  {
    group: 'procesados',
    words: [
      'snack',
      'papas fritas',
      'chucheria',
      'chuche',
      'galleta',
      'bolleria',
      'pastel',
      'helado',
      'refresco',
      'soda',
      'energizante',
      'cerveza',
      'vino',
      'ron',
      'whisky',
      'embutido',
      'salchicha',
      'nugget',
      'pizza',
      'congelado preparado',
      'cereal azucarado',
      'azucar',
      'salsa',
      'mayonesa',
      'ketchup',
      'cafe instantaneo',
      'sopa sobre',
      'fritura',
    ],
  },
  {
    group: 'hogar',
    words: [
      'detergente',
      'jabon',
      'cloro',
      'lejia',
      'suavizante',
      'limpiador',
      'desinfectante',
      'papel higienico',
      'servilleta',
      'bolsa basura',
      'escoba',
      'fregona',
      'shampoo',
      'pasta dental',
      'desodorante',
      'panal',
    ],
  },
  {
    group: 'bebidas',
    words: ['agua', 'jugo', 'zumo', 'leche de', 'bebida', 'te ', 'cafe molido', 'cafe en grano'],
  },
  {
    group: 'verduras',
    words: [
      'tomate',
      'cebolla',
      'ajo',
      'pimiento',
      'lechuga',
      'repollo',
      'zanahoria',
      'papa',
      'patata',
      'yuca',
      'platano verde',
      'berenjena',
      'calabaza',
      'auyama',
      'brocoli',
      'coliflor',
      'espinaca',
      'acelga',
      'pepino',
      'apio',
      'ejote',
      'guandul',
      'habichuela',
      'vegetal',
      'verdura',
      'hortaliza',
    ],
  },
  {
    group: 'frutas',
    words: [
      'manzana',
      'platano',
      'banana',
      'guineo',
      'naranja',
      'mandarina',
      'limon',
      'pina',
      'mango',
      'papaya',
      'sandia',
      'melon',
      'uva',
      'fresa',
      'pera',
      'durazno',
      'melocoton',
      'kiwi',
      'aguacate',
      'coco',
      'fruta',
    ],
  },
  {
    group: 'legumbres',
    words: ['lenteja', 'frijol', 'habichuela seca', 'garbanzo', 'arveja', 'legumbre', 'soya'],
  },
  {
    group: 'proteinas',
    words: [
      'pollo',
      'carne',
      'res',
      'cerdo',
      'pescado',
      'atun',
      'sardina',
      'camaron',
      'huevo',
      'chuleta',
      'bistec',
      'muslo',
      'pechuga',
      'salmon',
      'tilapia',
      'proteina',
    ],
  },
  {
    group: 'lacteos',
    words: ['leche', 'yogur', 'yogurt', 'queso', 'mantequilla', 'crema', 'requeson', 'lacteo'],
  },
  {
    group: 'cereales',
    words: [
      'arroz',
      'pan',
      'harina',
      'avena',
      'pasta',
      'espagueti',
      'fideo',
      'maiz',
      'maiz',
      'cereal',
      'tortilla',
      'galleta de soda',
      'casabe',
    ],
  },
  {
    group: 'grasas',
    words: ['aceite', 'oliva', 'mani', 'almendra', 'nuez', 'avellana', 'semilla', 'mantequilla de mani'],
  },
];

/** Quita acentos y deja minúsculas: «Aguacaté» y «aguacate» deben coincidir. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clasifica un producto en un grupo de alimentos (o hogar/otros). */
export function classifyProduct(name: string): FoodGroup {
  const text = ` ${normalizeText(name)} `;
  for (const bucket of GROUP_KEYWORDS) {
    for (const word of bucket.words) {
      if (text.includes(` ${word}`) || text.includes(`${word} `)) {
        return bucket.group;
      }
    }
  }
  return 'otros';
}

/** Grupo que cuenta para el equilibrio de la alimentación (sin hogar ni bebidas). */
const FOOD_GROUPS: FoodGroup[] = ['frutas', 'verduras', 'proteinas', 'lacteos', 'cereales', 'legumbres', 'grasas'];

/** Una línea ya comprada, tal como llega de la base de datos. */
export interface InsightLine {
  name: string;
  quantity: number;
  unit: string | null;
  unitPrice: number | null;
  /** Importe de la línea (precio real × cantidad). */
  total: number | null;
  /** Fecha de la compra (ISO) o null si la lista no está cerrada. */
  purchasedAt: string | null;
  /** Nombre de la lista de la que viene (para agrupar compras). */
  listId: string;
}

export interface ProductSummary {
  name: string;
  group: FoodGroup;
  times: number;
  quantity: number;
  unit: string | null;
  lastPrice: number | null;
  previousPrice: number | null;
  /** Variación porcentual entre la compra anterior y la última (null si no hay dos). */
  changePct: number | null;
}

export interface PriceIncrease {
  name: string;
  from: number;
  to: number;
  changePct: number;
}

export interface ShoppingInsights {
  totals: {
    purchases: number;
    spent: number;
    averageTicket: number | null;
    since: string | null;
    until: string | null;
  };
  topProducts: ProductSummary[];
  priceIncreases: PriceIncrease[];
  balance: {
    groups: Array<{ group: FoodGroup; label: string; products: number; share: number }>;
    ultraProcessedShare: number;
    missingGroups: FoodGroup[];
    /** 0-100: cuántos grupos aparece y cuánto pesa lo ultraprocesado. */
    score: number;
  };
  tips: string[];
}

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Construye el análisis completo a partir de las líneas compradas.
 * `today` se pasa desde fuera para que el resultado sea determinista en pruebas.
 */
export function buildInsights(lines: InsightLine[], today: Date): ShoppingInsights {
  const valid = lines.filter((line) => line.name.trim().length > 0);
  const listIds = new Set(valid.map((line) => line.listId));
  const spent = round2(valid.reduce((acc, line) => acc + (line.total ?? 0), 0));

  const dates = valid
    .map((line) => line.purchasedAt)
    .filter((value): value is string => Boolean(value))
    .sort();

  const purchases = listIds.size;

  // --- Productos: veces comprado y evolución del precio ---------------------
  const byProduct = new Map<string, { name: string; unit: string | null; prices: Array<{ price: number; at: string | null; quantity: number }> }>();
  for (const line of valid) {
    const key = normalizeText(line.name);
    if (key.length === 0) {
      continue;
    }
    const bucket = byProduct.get(key) ?? { name: line.name.trim(), unit: line.unit, prices: [] };
    bucket.prices.push({ price: line.unitPrice ?? 0, at: line.purchasedAt, quantity: line.quantity });
    if (line.unit && !bucket.unit) {
      bucket.unit = line.unit;
    }
    byProduct.set(key, bucket);
  }

  const topProducts: ProductSummary[] = [];
  const priceIncreases: PriceIncrease[] = [];

  for (const bucket of byProduct.values()) {
    const ordered = bucket.prices
      .slice()
      .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
    const last = ordered.at(-1);
    const previous = ordered.length > 1 ? ordered.at(-2) : undefined;
    const lastPrice = last && last.price > 0 ? round2(last.price) : null;
    const previousPrice = previous && previous.price > 0 ? round2(previous.price) : null;
    const changePct =
      lastPrice !== null && previousPrice !== null && previousPrice > 0
        ? round2(((lastPrice - previousPrice) / previousPrice) * 100)
        : null;

    topProducts.push({
      name: bucket.name,
      group: classifyProduct(bucket.name),
      times: ordered.length,
      quantity: round2(ordered.reduce((acc, row) => acc + row.quantity, 0)),
      unit: bucket.unit,
      lastPrice,
      previousPrice,
      changePct,
    });

    if (changePct !== null && changePct >= 10 && lastPrice !== null && previousPrice !== null) {
      priceIncreases.push({ name: bucket.name, from: previousPrice, to: lastPrice, changePct });
    }
  }

  topProducts.sort((a, b) => b.times - a.times || a.name.localeCompare(b.name, 'es'));
  priceIncreases.sort((a, b) => b.changePct - a.changePct);

  // --- Equilibrio por grupos ------------------------------------------------
  const foodLines = valid.filter((line) => {
    const group = classifyProduct(line.name);
    return group !== 'hogar' && group !== 'bebidas';
  });
  const foodSpend = foodLines.reduce((acc, line) => acc + (line.total ?? 0), 0);
  const groupSpend = new Map<FoodGroup, number>();
  const groupProducts = new Map<FoodGroup, number>();
  for (const line of foodLines) {
    const group = classifyProduct(line.name);
    groupSpend.set(group, (groupSpend.get(group) ?? 0) + (line.total ?? 0));
    groupProducts.set(group, (groupProducts.get(group) ?? 0) + 1);
  }

  const groups = [...groupSpend.entries()]
    .map(([group, amount]) => ({
      group,
      label: FOOD_GROUP_LABELS[group],
      products: groupProducts.get(group) ?? 0,
      share: foodSpend > 0 ? Math.round((amount / foodSpend) * 100) : 0,
    }))
    .sort((a, b) => b.share - a.share);

  const presentFoodGroups = new Set(groups.filter((row) => row.share > 0 && FOOD_GROUPS.includes(row.group)).map((row) => row.group));
  const missingGroups = FOOD_GROUPS.filter((group) => !presentFoodGroups.has(group));
  const ultraProcessedShare = foodSpend > 0 ? Math.round(((groupSpend.get('procesados') ?? 0) / foodSpend) * 100) : 0;
  const coverage = FOOD_GROUPS.length > 0 ? presentFoodGroups.size / FOOD_GROUPS.length : 0;
  const score = Math.max(0, Math.min(100, Math.round(coverage * 100 - ultraProcessedShare * 0.8)));

  return {
    totals: {
      purchases,
      spent,
      averageTicket: purchases > 0 ? round2(spent / purchases) : null,
      since: dates[0] ?? null,
      until: dates.at(-1) ?? null,
    },
    topProducts: topProducts.slice(0, 12),
    priceIncreases: priceIncreases.slice(0, 6),
    balance: isFinite(score) ? { groups, ultraProcessedShare, missingGroups, score } : { groups, ultraProcessedShare, missingGroups, score: 0 },
    tips: buildTips({ groups, missingGroups, ultraProcessedShare, priceIncreases, topProducts, today, purchases, averageTicket: purchases > 0 ? spent / purchases : null }),
  };
}

/**
 * Consejos concretos y comprobables. Se evita cualquier promesa de salud: son
 * recomendaciones de compra y de aprovechamiento de la comida.
 */
function buildTips(input: {
  groups: ShoppingInsights['balance']['groups'];
  missingGroups: FoodGroup[];
  ultraProcessedShare: number;
  priceIncreases: PriceIncrease[];
  topProducts: ProductSummary[];
  today: Date;
  purchases: number;
  averageTicket: number | null;
}): string[] {
  const tips: string[] = [];

  if (input.purchases === 0) {
    tips.push('Todavía no hay compras cerradas: al registrar la primera, aquí aparecerán sus patrones y consejos.');
    return tips;
  }

  if (input.missingGroups.includes('verduras') || input.missingGroups.includes('frutas')) {
    const faltan = [
      input.missingGroups.includes('verduras') ? 'verduras' : null,
      input.missingGroups.includes('frutas') ? 'frutas' : null,
    ]
      .filter(Boolean)
      .join(' y ');
    tips.push(`En sus últimas compras no aparecen ${faltan}: añadirlas una vez por semana suele rendir más que comprar más cantidad de lo mismo.`);
  }

  if (input.missingGroups.includes('legumbres')) {
    tips.push('No hay legumbres registradas. Un paquete rinde varias comidas y aguanta meses en la alacena.');
  }

  if (input.ultraProcessedShare >= 25) {
    tips.push(
      `El ${input.ultraProcessedShare}% del gasto en comida va a ultraprocesados y snacks. Bajar ese porcentaje es la forma más rápida de gastar menos sin comer menos.`,
    );
  }

  if (input.priceIncreases.length > 0) {
    const first = input.priceIncreases[0]!;
    tips.push(`«${first.name}» subió un ${Math.round(first.changePct)}% desde la compra anterior: conviene revisar si compensa o cambiar de marca.`);
  }

  const repeated = input.topProducts.filter((row) => row.times >= 3).slice(0, 3);
  if (repeated.length >= 2) {
    tips.push(`Se repiten ${repeated.map((row) => row.name).join(', ')}: son buenos candidatos para comprar en mayor cantidad y bajar el precio por unidad.`);
  }

  if (input.averageTicket !== null && input.averageTicket > 0) {
    tips.push('Hacer una sola compra semanal grande suele salir más barato que tres compras pequeñas.');
  }

  const hasFresh = input.groups.some((row) => (row.group === 'verduras' || row.group === 'proteinas') && row.share > 0);
  if (hasFresh) {
    tips.push('Aprovechamiento: cocine el doble de verduras y proteínas y congele la mitad; se recalienta bien y evita tirar comida a mitad de semana.');
  }
  tips.push('Congele lo que sobre ya cocinado en porciones: dura hasta 3 meses y se descongela en la nevera la noche anterior.');

  return tips.slice(0, 6);
}
