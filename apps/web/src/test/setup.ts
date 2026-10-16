import 'fake-indexeddb/auto';

/**
 * Entorno de pruebas del frontend.
 * · `fake-indexeddb` da un IndexedDB real en memoria: la cola de operaciones
 *   pendientes se prueba DE VERDAD, no con simulaciones.
 * · Se simulan las APIs del navegador que jsdom no implementa.
 */

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// Las pruebas no dependen de la API de almacenamiento del navegador: se deja
// sin definir para comprobar que la app funciona aunque no exista.
if ('storage' in window.navigator) {
  Object.defineProperty(window.navigator, 'storage', {
    value: undefined,
    configurable: true,
  });
}

// Por defecto las pruebas se ejecutan como si hubiera conexión; cada prueba
// decide lo contrario si lo necesita.
Object.defineProperty(window.navigator, 'onLine', {
  value: true,
  writable: true,
  configurable: true,
});
