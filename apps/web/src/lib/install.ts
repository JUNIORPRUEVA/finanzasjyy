/**
 * INSTALAR LA APLICACIÓN EN EL TELÉFONO
 * =====================================
 * En Chrome (Android y escritorio) el navegador avisa con el evento
 * `beforeinstallprompt` cuando la app cumple los requisitos para instalarse.
 * Ese evento hay que **guardarlo**: sólo se puede usar una vez, y si se deja
 * pasar, no vuelve a ofrecerse. Aquí se guarda y se dispara cuando el usuario
 * toca el botón del menú.
 *
 * En iPhone y iPad ningún navegador permite el diálogo automático: hay que
 * ir a Compartir → «Añadir a pantalla de inicio». Por eso, en iOS, el botón no
 * intenta instalar: explica los dos toques exactos.
 *
 * El botón nunca debe aparecer si la app YA está instalada: se comprueba el
 * modo de visualización (`standalone`) y el `navigator.standalone` de iOS.
 */
import { useCallback, useEffect, useState } from 'react';

interface EventoInstalacion extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type ResultadoInstalacion = 'aceptada' | 'rechazada' | 'no-disponible' | 'instrucciones';

/** ¿Se está usando la app instalada (no dentro del navegador)? */
export function estaInstalada(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const enModoApp = window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  const iosIndependiente = (navigator as unknown as { standalone?: boolean }).standalone === true;
  return enModoApp || iosIndependiente;
}

/** iPhone/iPad (cualquier navegador: todos usan WebKit y ninguno ofrece el diálogo). */
export function esIOS(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const porMarca = /iPad|iPhone|iPod/.test(navigator.userAgent);
  // Los iPad recientes se anuncian como Mac con pantalla táctil.
  const ipadModerno = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return porMarca || ipadModerno;
}

export interface InstalacionApp {
  /** Hay instalación disponible ahora mismo (Chrome con el evento pendiente). */
  disponible: boolean;
  /** La app ya está instalada: no se ofrece nada. */
  instalada: boolean;
  /** En iOS no hay diálogo: se muestran instrucciones. */
  requiereInstrucciones: boolean;
  /** Dispara la instalación (o pide instrucciones en iOS). */
  instalar: () => Promise<ResultadoInstalacion>;
}

export function useInstalacionApp(): InstalacionApp {
  const [evento, setEvento] = useState<EventoInstalacion | null>(null);
  const [instalada, setInstalada] = useState(() => estaInstalada());

  useEffect(() => {
    const alPoderInstalar = (event: Event) => {
      // Sin `preventDefault` el navegador muestra su propio aviso y el evento se
      // pierde: ya no se podría lanzar desde nuestro botón.
      event.preventDefault();
      setEvento(event as EventoInstalacion);
    };
    const alInstalar = () => {
      setInstalada(true);
      setEvento(null);
    };
    const alCambiarModo = () => setInstalada(estaInstalada());

    window.addEventListener('beforeinstallprompt', alPoderInstalar);
    window.addEventListener('appinstalled', alInstalar);
    const media = window.matchMedia?.('(display-mode: standalone)');
    media?.addEventListener?.('change', alCambiarModo);

    return () => {
      window.removeEventListener('beforeinstallprompt', alPoderInstalar);
      window.removeEventListener('appinstalled', alInstalar);
      media?.removeEventListener?.('change', alCambiarModo);
    };
  }, []);

  const instalar = useCallback(async (): Promise<ResultadoInstalacion> => {
    if (!evento) {
      return esIOS() ? 'instrucciones' : 'no-disponible';
    }
    await evento.prompt();
    const { outcome } = await evento.userChoice;
    // El evento es de un solo uso: se descarta pase lo que pase.
    setEvento(null);
    return outcome === 'accepted' ? 'aceptada' : 'rechazada';
  }, [evento]);

  return {
    disponible: evento !== null && !instalada,
    instalada,
    requiereInstrucciones: esIOS() && !instalada,
    instalar,
  };
}
