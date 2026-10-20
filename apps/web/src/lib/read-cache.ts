import { useSyncExternalStore } from 'react';
import { countCachedResponses, getCachedResponse, pruneCachedResponses, putCachedResponse } from './db';

/**
 * CACHÉ DE LECTURA INTELIGENTE
 * ============================
 * El problema que resuelve: sin conexión, la app abría las pantallas pero se
 * quedaba sin cifras. El panel decía «No se pudo cargar el panel», y peor aún,
 * las cuentas y las deudas aparecían a CERO o como «no hay nada registrado»,
 * que es una información FALSA: no es que no haya deudas, es que no se pudo
 * preguntar.
 *
 * Cómo funciona, y por qué así:
 *
 *  1. SÓLO SE GUARDA LO QUE EL SERVIDOR CONTESTÓ. Cada respuesta correcta de una
 *     consulta (GET) se copia con la hora exacta a la que llegó. Nunca se estima
 *     un saldo ni se rellena un hueco con ceros.
 *  2. SÓLO SE USA CUANDO EL SERVIDOR NO PUEDE RESPONDER (sin red, timeout,
 *     5xx). Con conexión, la app siempre lee del servidor: la caché no puede
 *     tapar un dato nuevo.
 *  3. SIEMPRE SE DICE. Cuando una pantalla se pinta con datos guardados, la app
 *     lo avisa con la hora de esos datos (`useDatosGuardados`). No se presenta
 *     como información del momento algo que no lo es.
 *  4. NUNCA SE GUARDAN LOS ENDPOINTS DE ESCRITURA ni los que pueden cambiar el
 *     dinero (POST, cierres, sincronización). Ver `rutaCacheable` en `api.ts`.
 *  5. CADUCA. Pasados 7 días, una respuesta ya no se usa aunque siga en disco, y
 *     el número de entradas tiene tope para que el teléfono no se llene.
 *
 * Esto NO es una base de datos local paralela: no hay tablas de negocio, no hay
 * réplicas que conciliar y no hay escrituras que sobrevivan al servidor. Es una
 * copia de la última respuesta buena, con fecha, para poder seguir trabajando.
 */

/** Antigüedad máxima de una respuesta guardada (7 días). */
export const CADUCIDAD_CACHE_MS = 7 * 24 * 3_600_000;

/** Tope de respuestas guardadas (las más antiguas se descartan antes). */
export const MAX_RESPUESTAS = 400;

/** Una respuesta por encima de este tamaño no se guarda (por prudencia). */
const MAX_BYTES = 400 * 1024;

/**
 * Guarda la respuesta de una consulta. Los fallos al escribir (cuota llena,
 * navegador en modo privado) NO rompen la petición: la app sigue funcionando
 * con el servidor, simplemente se queda sin copia para después.
 */
export async function rememberResponse(path: string, data: unknown): Promise<void> {
  try {
    const body = JSON.stringify(data);
    if (typeof body !== 'string' || body.length === 0 || body.length > MAX_BYTES) {
      return;
    }
    await putCachedResponse(path, body);
  } catch {
    // Sin espacio o sin almacenamiento: no es un error del usuario.
  }
}

/** Lee la última respuesta buena de una consulta, si existe y no ha caducado. */
export async function readCachedResponse<T>(
  path: string,
  maxAgeMs = CADUCIDAD_CACHE_MS,
): Promise<{ data: T; cachedAt: string } | null> {
  try {
    const row = await getCachedResponse(path);
    if (!row) {
      return null;
    }
    const edad = Date.now() - new Date(row.cachedAt).getTime();
    if (!Number.isFinite(edad) || edad > maxAgeMs) {
      return null;
    }
    return { data: JSON.parse(row.body) as T, cachedAt: row.cachedAt };
  } catch {
    return null;
  }
}

/** Mantiene la caché dentro de un tamaño razonable. */
export async function limpiarCacheDeRespuestas(): Promise<void> {
  try {
    await pruneCachedResponses(CADUCIDAD_CACHE_MS, MAX_RESPUESTAS);
  } catch {
    // Nada que hacer.
  }
}

export async function estadoDeLaCache(): Promise<{ respuestas: number }> {
  try {
    return { respuestas: await countCachedResponses() };
  } catch {
    return { respuestas: 0 };
  }
}

// ---------------------------------------------------------------------------
// Aviso «esto son datos guardados»
// ---------------------------------------------------------------------------

export interface AvisoDatosGuardados {
  /** Hora ISO de los datos que se están mostrando. */
  cachedAt: string;
  /** Ruta de la consulta que se sirvió desde la caché. */
  path: string;
}

let avisoActual: AvisoDatosGuardados | null = null;
const oyentes = new Set<() => void>();

function notificar(): void {
  for (const oyente of oyentes) {
    oyente();
  }
}

/** Se llama cuando una pantalla se ha pintado con datos guardados. */
export function avisarDatosGuardados(cachedAt: string, path: string): void {
  if (avisoActual && avisoActual.cachedAt === cachedAt && avisoActual.path === path) {
    return;
  }
  avisoActual = { cachedAt, path };
  notificar();
}

/** Se llama cuando el servidor ha vuelto a responder: el aviso desaparece. */
export function olvidarDatosGuardados(): void {
  if (avisoActual === null) {
    return;
  }
  avisoActual = null;
  notificar();
}

const suscribir = (oyente: () => void): (() => void) => {
  oyentes.add(oyente);
  return () => oyentes.delete(oyente);
};

const instantanea = (): AvisoDatosGuardados | null => avisoActual;

/**
 * Hook para que la interfaz pueda decir con todas las letras que lo que se ve
 * son datos guardados, y de cuándo son.
 */
export function useDatosGuardados(): AvisoDatosGuardados | null {
  return useSyncExternalStore(suscribir, instantanea, instantanea);
}
