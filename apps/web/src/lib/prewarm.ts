import { api } from './api';
import { limpiarCacheDeRespuestas } from './read-cache';

/**
 * PREPARAR LA COPIA PARA CUANDO NO HAYA SEÑAL
 * ===========================================
 * Estar sin conexión no se avisa con antelación. El caso real es el del súper:
 * se entra con cobertura y a mitad de la compra se pierde. Si la app sólo
 * guardara las pantallas que se han abierto, al quedarse sin señal el usuario se
 * encontraría con huecos (deudas, presupuestos, control del día…) justo cuando
 * los necesita.
 *
 * Por eso, mientras hay conexión, la app **prepara la copia** de las consultas
 * que sostienen las pantallas principales. Son consultas de sólo lectura, se
 * hacen en segundo plano, sin bloquear nada y sin avisar; si alguna falla, se
 * ignora y se sigue con la siguiente (no se muestra un error por algo que el
 * usuario no ha pedido).
 *
 * Reglas:
 *  · Nunca se ejecuta sin conexión.
 *  · Como mucho, una vez cada 10 minutos (no se machaca ni la batería ni el
 *    servidor).
 *  · No incluye nada que se calcule con saldos del momento (cierres) ni nada de
 *    escritura.
 */

const CLAVE_ULTIMA_PREPARACION = 'finanza.prepare.at';
const ESPERA_MINIMA_MS = 10 * 60_000;

/**
 * Consultas esenciales, en el mismo formato con el que las piden las pantallas
 * (si cambia la ruta, la copia dejaría de servir: por eso se escribe igual).
 */
export const RUTAS_ESENCIALES: readonly string[] = [
  '/auth/preferences',
  '/entities',
  '/accounts',
  '/accounts?includeClosed=true',
  '/categories',
  '/dashboard/summary?preset=TODAY',
  '/dashboard/charts?days=30',
  '/daily-control',
  '/notifications/tasks',
  '/transactions?page=1&limit=50',
  '/transfers?limit=30',
  '/loans?limit=100',
  '/loans/summary',
  '/budgets?limit=100',
  '/budgets/alerts',
  '/obligations/recurring',
  '/obligations/receivables?limit=100',
  '/obligations/payables?limit=100',
  '/obligations/upcoming?days=15',
  '/shopping-lists/summary',
];

function ultimaPreparacion(): number {
  try {
    const guardado = Number(localStorage.getItem(CLAVE_ULTIMA_PREPARACION));
    return Number.isFinite(guardado) ? guardado : 0;
  } catch {
    return 0;
  }
}

function marcarPreparacion(): void {
  try {
    localStorage.setItem(CLAVE_ULTIMA_PREPARACION, String(Date.now()));
  } catch {
    // Sin almacenamiento: simplemente se volverá a intentar en la próxima.
  }
}

/**
 * Descarga y guarda la copia de las consultas esenciales.
 *
 * Devuelve cuántas se han podido guardar. `forzar` sirve para la primera vez
 * tras iniciar sesión, cuando interesa tener la copia ya.
 */
export async function prepararCopiaSinConexion(forzar = false): Promise<number> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 0;
  }
  if (!forzar && Date.now() - ultimaPreparacion() < ESPERA_MINIMA_MS) {
    return 0;
  }

  let guardadas = 0;
  for (const ruta of RUTAS_ESENCIALES) {
    try {
      // `api.get` guarda la respuesta en la caché de lectura si el servidor
      // contesta bien: no hace falta hacer nada más aquí.
      await api.get(ruta);
      guardadas += 1;
    } catch {
      // Una consulta que falla no debe impedir preparar las demás.
    }
  }

  marcarPreparacion();
  await limpiarCacheDeRespuestas();
  return guardadas;
}
