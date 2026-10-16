import { test } from '@playwright/test';
import path from 'node:path';
import { APP_ROUTES, ensureAuthenticated } from './helpers';

/**
 * CAPTURAS DE REFERENCIA
 * ======================
 * Guarda una imagen de cada pantalla en su tamaño de teléfono. Sirven para tres
 * cosas concretas:
 *   1. Revisar el aspecto sin tener que abrir la aplicación pantalla por pantalla.
 *   2. Detectar cambios visuales no deseados comparando con la versión anterior.
 *   3. Documentar la aplicación tal y como se ve hoy.
 *
 * Las imágenes se escriben en `docs/capturas/<tamaño>/`.
 *
 * AVISO IMPORTANTE: son capturas de un navegador con un tamaño de pantalla
 * emulado (Chromium). NO son fotografías de un teléfono físico: el
 * comportamiento real del notch, del teclado y del gesto de retroceso no se
 * prueba aquí.
 */

// `process.cwd()` es `apps/web` cuando Playwright se ejecuta desde aquí.
const OUTPUT_DIR = path.join(process.cwd(), '..', '..', 'docs', 'capturas');

test.beforeEach(({}, testInfo) => {
  test.skip(
    !['android-390x844', 'iphone-375x667'].includes(testInfo.project.name),
    'Se guardan capturas de dos tamaños representativos, no de los cinco',
  );
});

test('capturas de todas las pantallas', async ({ page }, testInfo) => {
  await ensureAuthenticated(page);

  for (const route of APP_ROUTES) {
    await page.goto(route.path);
    await page.waitForLoadState('networkidle').catch(() => undefined);

    const fileName = `${route.path === '/' ? 'panel' : route.path.replace(/^\//, '').replace(/\//g, '-')}.png`;
    await page.screenshot({
      path: path.join(OUTPUT_DIR, testInfo.project.name, fileName),
      fullPage: true,
    });
  }
});
