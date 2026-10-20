// `defineConfig` se importa de vitest/config para poder declarar la sección
// `test` (Vitest reutiliza la configuración de Vite).
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// `process.env` sin depender de @types/node: este paquete es de navegador y no
// se quiere arrastrar los tipos de Node a todo el código de la aplicación.
const processEnv =
  (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

/**
 * CONFIGURACIÓN DE LA PWA DE FINANZA
 * ----------------------------------
 * DECISIÓN IMPORTANTE SOBRE EL CACHÉ:
 *   El Service Worker precachea SÓLO los recursos estáticos (HTML, JS, CSS,
 *   iconos). NO cachea respuestas de la API.
 *
 *   El motivo es de integridad financiera: si el SW sirviera saldos o
 *   movimientos cacheados y la app los mostrara como si fueran del servidor,
 *   el usuario podría tomar decisiones sobre datos viejos creyéndolos actuales.
 *   En su lugar, la aplicación guarda en IndexedDB (Dexie) lo que decide
 *   guardar y SIEMPRE lo marca como "sin conexión / provisional".
 */
export default defineConfig({
  // La versión y la fecha de compilación se incrustan en el código para poder
  // verlas dentro de la app y comparar el teléfono con el servidor cuando algo
  // «no cambia» (casi siempre es una copia vieja guardada por el móvil).
  define: {
    __APP_VERSION__: JSON.stringify(processEnv.npm_package_version ?? '0.0.0'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      // El registro lo hace la aplicación (ver `src/lib/pwa.ts`) para poder
      // avisar al usuario de que hay una versión nueva. Con 'auto' se registraba
      // sin avisar y la actualización se quedaba esperando para siempre: la app
      // del móvil se quedaba en la versión vieja indefinidamente.
      injectRegister: false,
      includeAssets: ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'FINANZA — Control financiero',
        short_name: 'FINANZA',
        description:
          'Control de ingresos, gastos, cuentas, deudas y cierres diarios por unidad financiera, con funcionamiento sin conexión.',
        lang: 'es-DO',
        dir: 'ltr',
        // Color de la barra del navegador y del arranque del móvil: el azul de
        // la identidad (antes era verde).
        theme_color: '#0B2748',
        background_color: '#0B2748',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        categories: ['finance', 'business', 'productivity'],
        // Los genera scripts/generate-icons.ps1 a partir del logotipo.
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: '/index.html',
        // Nada de la API entra en el caché del Service Worker (ver nota arriba).
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: false,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    // El puerto y el destino de la API se pueden cambiar por entorno. Es lo que
    // permite que las pruebas de navegador levanten su propia pareja
    // (API + PWA) apuntando a la base de datos de pruebas, sin tocar las cuentas
    // reales ni los puertos de desarrollo.
    port: Number(processEnv.VITE_PORT ?? 5180),
    strictPort: true,
    proxy: {
      // En desarrollo, el front habla con la API por el mismo origen.
      '/api': {
        target: processEnv.VITE_PROXY_TARGET ?? 'http://localhost:3010',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
