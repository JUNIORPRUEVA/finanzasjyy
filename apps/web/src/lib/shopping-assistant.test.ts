import { classifyItem, groupItems, listToPlainText, nutritionAdvice, SHOPPING_GROUPS } from './shopping-assistant';

/**
 * Asistente de compras.
 *
 * Lo que se comprueba aquí es lo que puede fallar de verdad: que clasifique
 * productos reales de un supermercado dominicano, que no se invente un pasillo
 * cuando no lo reconoce, que respete el orden del recorrido y que el texto que
 * se comparte sea correcto (con acentos y sin inventar precios).
 */
describe('classifyItem', () => {
  it.each([
    ['Plátano verde', 'frutas'],
    ['Guineos', 'frutas'],
    ['Tomate de ensalada', 'frutas'],
    ['Pechuga de pollo', 'carnes'],
    ['Huevos', 'lacteos'],
    ['Leche entera', 'lacteos'],
    ['Queso de hoja', 'lacteos'],
    ['Pan de agua', 'panaderia'],
    ['Arroz selecto', 'despensa'],
    ['Aceite de oliva', 'despensa'],
    ['Detergente en polvo', 'limpieza'],
    ['Papel higiénico', 'higiene'],
    ['Pañales talla 3', 'bebes'],
    ['Croquetas para perro', 'mascotas'],
    ['Refresco de cola', 'bebidas'],
    ['Galletas de chocolate', 'snacks'],
  ])('«%s» va a %s', (nombre, grupo) => {
    expect(classifyItem(nombre)).toBe(grupo);
  });

  it('con acentos y sin acentos da lo mismo', () => {
    expect(classifyItem('PLÁTANO')).toBe(classifyItem('platano'));
    expect(classifyItem('Jamón')).toBe('carnes');
  });

  it('«leche en polvo» es despensa, no lácteo (gana la coincidencia más larga)', () => {
    expect(classifyItem('Leche en polvo')).toBe('despensa');
  });

  it('«papel toalla» es limpieza y «papel higiénico» es higiene', () => {
    expect(classifyItem('Papel toalla')).toBe('limpieza');
    expect(classifyItem('Papel higiénico')).toBe('higiene');
  });

  it('lo que no reconoce queda en «otros» en vez de inventar un pasillo', () => {
    expect(classifyItem('Zzz producto raro xyz')).toBe('otros');
    expect(classifyItem('')).toBe('otros');
  });

  it('no se confunde por una subcadena: «sal» no atrapa «salami»', () => {
    expect(classifyItem('Salami')).toBe('carnes');
  });
});

describe('groupItems', () => {
  it('respeta el orden del recorrido del supermercado', () => {
    const grupos = groupItems([
      { name: 'Detergente' },
      { name: 'Manzanas' },
      { name: 'Pollo' },
    ]);
    expect(grupos.map((grupo) => grupo.id)).toEqual(['frutas', 'carnes', 'limpieza']);
  });

  it('conserva el orden dentro de cada grupo y no crea grupos vacíos', () => {
    const grupos = groupItems([{ name: 'Arroz' }, { name: 'Manzana' }, { name: 'Pasta' }]);
    expect(grupos).toHaveLength(2);
    expect(grupos[1].items.map((item) => item.name)).toEqual(['Arroz', 'Pasta']);
  });

  it('todos los grupos devueltos existen en la lista de pasillos', () => {
    const ids = SHOPPING_GROUPS.map((grupo) => grupo.id);
    for (const grupo of groupItems([{ name: 'cosa desconocida' }])) {
      expect(ids).toContain(grupo.id);
    }
  });
});

describe('nutritionAdvice', () => {
  it('avisa cuando no hay frutas ni verduras', () => {
    const consejos = nutritionAdvice([{ name: 'Arroz' }, { name: 'Pollo' }]).join(' ');
    expect(consejos).toContain('frutas ni verduras');
  });

  it('avisa cuando la mayoría son snacks', () => {
    const items = [
      { name: 'Galletas' },
      { name: 'Papitas' },
      { name: 'Chocolate' },
      { name: 'Caramelos' },
      { name: 'Manzana' },
    ];
    expect(nutritionAdvice(items).join(' ')).toContain('snacks o dulces');
  });

  it('con una lista equilibrada no inventa problemas', () => {
    const items = [
      { name: 'Pechuga de pollo' },
      { name: 'Lechuga' },
      { name: 'Tomate' },
      { name: 'Arroz' },
      { name: 'Huevos' },
    ];
    expect(nutritionAdvice(items).join(' ')).toContain('equilibrada');
  });

  it('nunca devuelve más de cuatro consejos', () => {
    const items = [
      { name: 'Galletas' },
      { name: 'Papitas' },
      { name: 'Chocolate' },
      { name: 'Caramelos' },
      { name: 'Refresco' },
      { name: 'Pizza congelada' },
    ];
    expect(nutritionAdvice(items).length).toBeLessThanOrEqual(4);
  });
});

describe('listToPlainText', () => {
  it('incluye el nombre, los pasillos y una casilla por producto', () => {
    const texto = listToPlainText({
      name: 'Compra del sábado',
      items: [{ name: 'Manzanas' }, { name: 'Arroz' }],
      total: '1200.00',
      currency: 'DOP',
    });
    expect(texto).toContain('Compra del sábado');
    expect(texto).toContain('FRUTAS Y VERDURAS');
    expect(texto).toContain('☐ Manzanas');
    expect(texto).toContain('1200.00');
  });

  it('no inventa un total cuando es cero', () => {
    const texto = listToPlainText({ name: 'X', items: [{ name: 'Arroz' }], total: '0.00' });
    expect(texto).not.toContain('Total estimado');
  });
});
