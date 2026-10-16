import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Este paquete es ESM (`"type": "module"`), así que la ruta del archivo se
// obtiene de `import.meta`, no de `__dirname`.
const projectDir = import.meta.dirname;

/**
 * PRUEBAS DE NAVEGADOR DE FINANZA (Playwright)
 * ===========================================
 *
 * QUÉ SE COMPRUEBA
 *  · Que se puede entrar y que la sesión SOBREVIVE a recargar la aplicación.
 *  · Que un corte del servidor NO expulsa al usuario a la pantalla de acceso.
 *  · Que se puede recorrer toda la aplicación sin errores en consola, sin
 *    desbordamiento horizontal y sin contenido tapado por la barra inferior.
 *  · Que los diálogos se abren y se cierran, y que los botones son alcanzables
 *    (mínimo 44 px de alto, pensado para el dedo).
 *  · Capturas de pantalla de cada pantalla en los tamaños de móvil reales.
 *
 * AISLAMIENTO (IMPORTANTE)
 *  Estas pruebas registran movimientos DE VERDAD, así que se ejecutan contra:
 *    · API en el puerto 3310 (no el 3010 de desarrollo)
 *    · Base de datos `finanza_test` (nunca `finanza`, la de trabajo)
 *  Los puertos de pruebas son distintos a propósito: `reuseExistingServer` está
 *  desactivado para que Playwright NO pueda reutilizar un servidor de desarrollo
 *  conectado a las cuentas reales por descuido.
 *
 * NAVEGADORES
 *  Se usan perfiles de dispositivo de Chromium (Android e iPhone) con sus
 *  tamaños, densidad y área segura. Esto NO es lo mismo que probar en teléfonos
 *  físicos: son tamaños de pantalla emulados, no hardware real.
 */

const API_PORT = Number(process.env.E2E_API_PORT ?? 3310);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5280);
const API_URL = `http://localhost:${API_PORT}/api/v1`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

/**
 * Base de datos de pruebas: se deriva de la de desarrollo cambiando el nombre.
 * Si no se puede deducir, se aborta: es preferible no ejecutar nada antes que
 * escribir movimientos en las cuentas reales.
 */
function resolveTestDatabaseUrl(): string {
  if (process.env.E2E_DATABASE_URL) {
    return process.env.E2E_DATABASE_URL;
  }

  const envPath = path.join(projectDir, '..', 'api', '.env');
  const contents = readFileSync(envPath, 'utf8');
  const line = contents.split(/\r?\n/).find((candidate) => candidate.startsWith('DATABASE_URL='));
  if (!line) {
    throw new Error(`No se encontró DATABASE_URL en ${envPath}`);
  }

  const url = line.slice('DATABASE_URL='.length).trim().replace(/^"|"$/g, '');
  if (!/\/finanza(\?|$)/.test(url)) {
    throw new Error(
      `La URL de la base de datos de desarrollo no tiene el formato esperado (se esperaba la base «finanza»): ${url.replace(/:[^:@/]+@/, ':***@')}`,
    );
  }

  const testUrl = url.replace(/\/finanza(\?|$)/, '/finanza_test$1');
  // Comprobación de seguridad: si no se ha cambiado de base, se aborta.
  if (testUrl === url) {
    throw new Error('No se pudo derivar la base de datos de pruebas. Ejecute scripts/create-test-db.ps1');
  }
  return testUrl;
}

const DATABASE_URL = resolveTestDatabaseUrl();

export default defineConfig({
  testDir: './e2e',
  // Las pruebas comparten la misma base de datos: se ejecutan en serie para que
  // una no vea los movimientos de la otra.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  // Un reintento sólo para absorber fallos del entorno (por ejemplo, que el
  // servidor de desarrollo se caiga un instante). Si un resultado aparece como
  // «flaky», se dice en el informe: no se oculta.
  retries: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',

  use: {
    baseURL: WEB_URL,
    locale: 'es-DO',
    timezoneId: 'America/Santo_Domingo',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    // La aplicación es una PWA: se prueba como se usa, en el navegador de verdad.
    serviceWorkers: 'allow',
  },

  projects: [
    {
      name: 'android-360x800',
      use: { ...devices['Pixel 5'], browserName: 'chromium', viewport: { width: 360, height: 800 }, deviceScaleFactor: 3 },
    },
    {
      name: 'android-390x844',
      use: { ...devices['Pixel 7'], browserName: 'chromium', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 },
    },
    {
      // Tamaño, densidad y táctil de un iPhone pequeño, sobre el motor Chromium.
      // IMPORTANTE: esto NO es Safari ni el motor WebKit de iOS. Un iPhone real
      // usa WebKit, así que este perfil comprueba el TAMAÑO, no el navegador de
      // Apple. Para eso habría que instalar el motor WebKit de Playwright.
      name: 'iphone-375x667',
      use: { ...devices['iPhone SE'], browserName: 'chromium', viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 },
    },
    {
      name: 'iphone-430x932',
      use: {
        ...devices['iPhone 15 Pro Max'],
        browserName: 'chromium',
        viewport: { width: 430, height: 932 },
        deviceScaleFactor: 3,
      },
    },
    {
      // Vista de escritorio: sirve para comprobar que el diseño móvil no rompe
      // la pantalla grande (no es el objetivo principal del proyecto).
      name: 'escritorio-1280x800',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],

  webServer: [
    {
      // API conectada a la base de datos de PRUEBAS.
      command: 'npm run build && node dist/main.js',
      cwd: path.join(projectDir, '..', 'api'),
      url: `${API_URL}/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        DATABASE_URL,
        PORT: String(API_PORT),
        NODE_ENV: 'test',
        CORS_ORIGINS: WEB_URL,
        // Autorización para trabajar sin conexión y duración de la sesión:
        // los mismos valores por defecto que en producción.
        SESSION_MAX_HOURS: '720',
        SESSION_IDLE_HOURS: '168',
        // Cada prueba abre un navegador limpio y entra una vez. La protección
        // contra fuerza bruta (5 intentos por minuto) es real y se mantiene en
        // la aplicación; aquí se levanta para que la verificación no falle por
        // el propio límite. Ver la nota en auth.controller.ts.
        E2E_AUTH_LOGIN_LIMIT: '500',
        E2E_AUTH_REFRESH_LIMIT: '5000',
      } as Record<string, string>,
    },
    {
      // PWA en modo desarrollo, hablando con la API de pruebas por el mismo origen.
      command: 'npm run dev',
      cwd: projectDir,
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        VITE_PORT: String(WEB_PORT),
        VITE_PROXY_TARGET: `http://localhost:${API_PORT}`,
        // `apps/web/.env` apunta al 3010 (desarrollo). Aquí se fuerza la ruta
        // relativa para que el navegador use el proxy de esta ejecución y hable
        // con la API de PRUEBAS, nunca con la de desarrollo. Las variables de
        // entorno tienen prioridad sobre el archivo `.env`.
        VITE_API_URL: '/api/v1',
      } as Record<string, string>,
    },
  ],
});
