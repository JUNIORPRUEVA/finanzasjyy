import { PLANTILLAS, productosNuevos } from './shopping-templates';
import { classifyItem } from './shopping-assistant';

/**
 * Plantillas de compra.
 *
 * Lo que se comprueba aquí es lo que puede estropear la función sin que se note:
 * que ninguna plantilla se llame igual, que no tenga productos repetidos dentro,
 * que TODOS caigan en un pasillo reconocido (si no, la lista no se ordena en la
 * tienda) y que aplicarla dos veces no duplique nada.
 * Los precios no se comprueban porque, a propósito, las plantillas no los llevan.
 */
describe('plantillas de compra', () => {
  it('todas tienen identificador y nombre distintos', () => {
    const ids = PLANTILLAS.map((plantilla) => plantilla.id);
    const labels = PLANTILLAS.map((plantilla) => plantilla.label);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it.each(PLANTILLAS.map((plantilla) => [plantilla.label, plantilla] as const))(
    '«%s» no repite productos',
    (_label, plantilla) => {
      const nombres = plantilla.items.map((item) => item.name.toLowerCase());
      expect(new Set(nombres).size).toBe(nombres.length);
      // Y todos tienen cantidad usable (no vacía, no cero, sin texto raro).
      for (const item of plantilla.items) {
        expect(item.quantity.trim()).not.toBe('');
        expect(Number(item.quantity)).toBeGreaterThan(0);
      }
    },
  );

  it.each(PLANTILLAS.map((plantilla) => [plantilla.label, plantilla] as const))(
    '«%s»: todos los productos caen en un pasillo conocido',
    (_label, plantilla) => {
      const sinClasificar = plantilla.items.filter((item) => classifyItem(item.name) === 'otros');
      expect(sinClasificar.map((item) => item.name)).toEqual([]);
    },
  );

  it('aplicar una plantilla sobre una lista vacía no descarta nada', () => {
    const { nuevos, repetidos } = productosNuevos(PLANTILLAS[0], []);
    expect(repetidos).toBe(0);
    expect(nuevos).toHaveLength(PLANTILLAS[0].items.length);
  });

  it('aplicarla dos veces no duplica: los repetidos se descartan', () => {
    const lista = PLANTILLAS[0].items.map((item) => ({ name: item.name }));
    const { nuevos, repetidos } = productosNuevos(PLANTILLAS[0], lista);
    expect(nuevos).toHaveLength(0);
    expect(repetidos).toBe(PLANTILLAS[0].items.length);
  });

  it('reconoce el repetido aunque cambien acentos, mayúsculas o espacios', () => {
    const { nuevos, repetidos } = productosNuevos(PLANTILLAS[0], [
      { name: '  PLATANO  ' },
      { name: 'Huevos' },
    ]);
    expect(repetidos).toBe(2);
    expect(nuevos.some((item) => item.name === 'Plátano')).toBe(false);
    expect(nuevos.some((item) => item.name === 'Huevos')).toBe(false);
  });
});
