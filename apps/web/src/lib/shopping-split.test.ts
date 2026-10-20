import { describe, expect, it } from 'vitest';
import { SHOPPING_GROUPS } from './shopping-assistant';
import { repartirCompra, textoDeParte } from './shopping-split';

interface Item {
  name: string;
  quantity?: string;
  isPurchased?: boolean;
}

const items: Item[] = [
  { name: 'Plátano verde', quantity: '6' },
  { name: 'Tomate de ensalada', quantity: '2' },
  { name: 'Pechuga de pollo', quantity: '2' },
  { name: 'Huevos', quantity: '30' },
  { name: 'Leche entera', quantity: '4' },
  { name: 'Detergente', quantity: '1' },
  { name: 'Papel higiénico', quantity: '1' },
];

describe('repartir la compra', () => {
  it('parte en dos lo que falta por comprar', () => {
    const partes = repartirCompra(items, 2);
    expect(partes).toHaveLength(2);
    const total = partes.reduce((suma, parte) => suma + parte.items.length, 0);
    expect(total).toBe(items.length);
  });

  it('deja fuera lo que ya está comprado', () => {
    const conComprado: Item[] = [...items, { name: 'Arroz', isPurchased: true }];
    const partes = repartirCompra(conComprado, 2);
    const nombres = partes.flatMap((parte) => parte.items.map((item) => item.name));
    expect(nombres).not.toContain('Arroz');
  });

  it('no parte un pasillo entre las dos personas', () => {
    // Los dos tomates y el plátano son «frutas y verduras»: tienen que ir juntos.
    const partes = repartirCompra(items, 2);
    const frutas = partes.filter((parte) => parte.grupos.some((grupo) => grupo.id === 'frutas'));
    expect(frutas).toHaveLength(1);
  });

  it('reparte de forma equilibrada (nadie se lleva todo)', () => {
    const partes = repartirCompra(items, 2);
    const [a, b] = partes.map((parte) => parte.items.length);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(2);
    expect(Math.min(a, b)).toBeGreaterThan(0);
  });

  it('dentro de cada parte, los pasillos van en el orden del supermercado', () => {
    const orden = new Map(SHOPPING_GROUPS.map((grupo, indice) => [grupo.id, indice]));
    for (const parte of repartirCompra(items, 2)) {
      const indices = parte.grupos.map((grupo) => orden.get(grupo.id) ?? -1);
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
    }
  });

  it('admite tres o más partes', () => {
    const partes = repartirCompra(items, 3);
    expect(partes).toHaveLength(3);
    expect(partes.reduce((suma, parte) => suma + parte.items.length, 0)).toBe(items.length);
  });

  it('con la lista vacía devuelve partes vacías, sin fallar', () => {
    const partes = repartirCompra([], 2);
    expect(partes).toHaveLength(2);
    expect(partes.every((parte) => parte.items.length === 0)).toBe(true);
  });

  it('el texto de la parte lleva pasillo y cantidad', () => {
    const [primera] = repartirCompra(items, 2);
    const texto = textoDeParte(primera, 'Compra del sábado');
    expect(texto).toContain('Compra del sábado — Parte 1');
    expect(texto).toContain('☐');
    expect(texto).toContain(`Total: ${primera.items.length} producto(s).`);
  });
});
