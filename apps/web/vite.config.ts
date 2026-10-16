// `defineConfig` se importa de vitest/config para poder declarar la sección
// `test` (Vitest reutiliza la configuración de Vite).
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

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
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'FINANZA — Control financiero',
        short_name: 'FINANZA',
        description:
          'Control de ingresos, gastos, cuentas, deudas y cierres diarios por unidad financiera, con funcionamiento sin conexión.',
        lang: 'es-DO',
        dir: 'ltr',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        categories: ['finance', 'business', 'productivity'],
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
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
    port: 5180,
    strictPort: true,
    proxy: {
      // En desarrollo, el front habla con la API por el mismo origen.
      '/api': {
        target: 'http://localhost:3010',
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
