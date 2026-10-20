import { groupItems, type GroupableItem, type ItemGroup } from './shopping-assistant';

/**
 * REPARTIR LA COMPRA ENTRE DOS PERSONAS
 * =====================================
 * En el súper se va mejor de dos en dos: uno coge lo de un lado y el otro lo del
 * otro. Esto parte lo que FALTA por comprar en dos partes **sin romper los
 * pasillos**: un pasillo entero va a una persona, nunca medio, porque si no las
 * dos acaban dando vueltas por el mismo pasillo.
 *
 * No cambia nada de la lista ni envía nada: sólo calcula el reparto para que cada
 * uno se lleve su parte (se puede compartir por WhatsApp o Bluetooth y no hace
 * falta conexión).
 */

export interface ParteCompra<T> {
  numero: number;
  etiqueta: string;
  grupos: Array<ItemGroup<T>>;
  items: T[];
}

/**
 * Reparte los productos pendientes en `partes` partes lo más parecidas posible.
 *
 * Se asignan los pasillos del más grande al más pequeño a la parte que menos
 * lleva (así el reparto queda equilibrado), y al final cada parte se devuelve
 * ordenada como el supermercado, para poder caminar en línea recta.
 */
export function repartirCompra<T extends GroupableItem & { isPurchased?: boolean }>(
  items: T[],
  partes = 2,
): Array<ParteCompra<T>> {
  const cuantas = Math.max(2, Math.min(6, Math.trunc(partes) || 2));
  const pendientes = items.filter((item) => item.isPurchased !== true);
  const porPasillo = groupItems(pendientes);

  const carga = new Array(cuantas).fill(0);
  const asignados: Array<Array<ItemGroup<T>>> = Array.from({ length: cuantas }, () => []);

  // De mayor a menor: los pasillos gordos primero, para que el reparto no acabe
  // con una parte llena y otra casi vacía.
  const ordenados = [...porPasillo].sort((a, b) => b.items.length - a.items.length);

  for (const grupo of ordenados) {
    let destino = 0;
    for (let i = 1; i < cuantas; i += 1) {
      if (carga[i] < carga[destino]) {
        destino = i;
      }
    }
    asignados[destino].push(grupo);
    carga[destino] += grupo.items.length;
  }

  // Dentro de cada parte, el orden del supermercado (no el de asignación).
  return asignados.map((grupos, indice) => {
    const enOrden = porPasillo.filter((grupo) => grupos.some((asignado) => asignado.id === grupo.id));
    return {
      numero: indice + 1,
      etiqueta: `Parte ${indice + 1}`,
      grupos: enOrden,
      items: enOrden.flatMap((grupo) => grupo.items),
    };
  });
}

/**
 * Texto para enviar una parte (WhatsApp, Bluetooth, nota del teléfono). Lleva lo
 * justo: qué comprar, cuánto y en qué pasillo, para no tener que abrir la app.
 */
export function textoDeParte<T extends GroupableItem & { quantity?: string; unit?: string | null }>(
  parte: ParteCompra<T>,
  nombreLista: string,
): string {
  const lineas: string[] = [`${nombreLista} — ${parte.etiqueta}`, ''];

  for (const grupo of parte.grupos) {
    lineas.push(`${grupo.emoji} ${grupo.label.toUpperCase()}`);
    for (const item of grupo.items) {
      const cantidad = item.quantity ? `${item.quantity}${item.unit ? ` ${item.unit}` : ''} · ` : '';
      lineas.push(`☐ ${cantidad}${item.name}`);
    }
    lineas.push('');
  }

  lineas.push(`Total: ${parte.items.length} producto(s).`);
  return lineas.join('\n').trim();
}
