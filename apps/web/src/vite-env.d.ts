/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Valores que Vite inyecta al compilar (ver `vite.config.ts`).
 * Sirven para que la app pueda decir QUÉ versión está ejecutando: es la única
 * forma de distinguir «el servidor tiene la versión nueva» de «mi teléfono
 * guardó la vieja». Sin eso, la duda se resuelve a ciegas.
 */
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;
