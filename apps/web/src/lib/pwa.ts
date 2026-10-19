/**
 * ACTUALIZACIONES DE LA APLICACIÓN (service worker)
 * =================================================
 * El problema que resuelve esto, y que costó una tarde de dudas:
 *
 *   La PWA estaba configurada con `registerType: 'prompt'` y `skipWaiting:
 *   false`. Eso significa que la versión nueva se descarga, se instala… y se
 *   queda **esperando** a que alguien le diga «adelante». Como la aplicación
 *   nunca enseñaba ese aviso, el teléfono se quedaba con la versión anterior
 *   para siempre: en el ordenador se veía el arreglo y en el móvil no. No era
 *   un fallo de código; era una actualización que nunca se aplicaba.
 *
 * Ahora la aplicación:
 *   · registra el service worker y se entera de cuándo hay una versión nueva,
 *   · avisa con una franja discreta («Hay una versión nueva»),
 *   · permite aplicarla al instante, y
 *   · vuelve a comprobarla al arrancar y cada 30 minutos.
 */
import { registerSW } from 'virtual:pwa-register';

/** Evento que se dispara cuando hay una versión nueva lista para usar. */
export const EVENTO_ACTUALIZACION = 'finanza:actualizacion-disponible';

/** `true` cuando el service worker ya está controlando la página. */
let aplicar: ((recargar?: boolean) => Promise<void>) | null = null;

/**
 * Registra el service worker. Se llama una sola vez, al arrancar (main.tsx).
 * En desarrollo no hay service worker: la función no hace nada.
 */
export function registrarServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }

  aplicar = registerSW({
    immediate: true,
    onNeedRefresh() {
      window.dispatchEvent(new Event(EVENTO_ACTUALIZACION));
    },
    onRegisteredSW(_url, registro) {
      if (!registro) {
        return;
      }
      // Volver a mirar cada media hora: si el usuario deja la app abierta en el
      // móvil, no debería tener que cerrarla para recibir la versión nueva.
      window.setInterval(() => void registro.update(), 30 * 60 * 1000);
      // Y al volver a la app (cambiar de pestaña o desbloquear el teléfono).
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          void registro.update();
        }
      });
    },
    onRegisterError(error) {
      console.warn('No se pudo registrar el service worker:', error);
    },
  });
}

/** Aplica la versión nueva y recarga. Si no hay nada pendiente, sólo recarga. */
export async function aplicarActualizacion(): Promise<void> {
  if (aplicar) {
    await aplicar(true);
    return;
  }
  window.location.reload();
}

/**
 * Busca una versión nueva a mano (botón «Buscar actualización»).
 * Devuelve qué ha pasado para poder decírselo al usuario con verdad.
 */
export async function buscarActualizacion(): Promise<'aplicada' | 'al-dia' | 'sin-servicio'> {
  if (!('serviceWorker' in navigator)) {
    return 'sin-servicio';
  }

  const registro = await navigator.serviceWorker.getRegistration();
  if (!registro) {
    return 'sin-servicio';
  }

  await registro.update();

  if (registro.waiting) {
    await aplicarActualizacion();
    return 'aplicada';
  }

  return 'al-dia';
}

/** Versión y fecha de compilación que está ejecutando este dispositivo. */
export function versionActual(): { version: string; compilada: string } {
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'desconocida';
  const compilada = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : '';
  return {
    version,
    compilada: compilada
      ? new Date(compilada).toLocaleString('es-DO', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'desconocida',
  };
}
