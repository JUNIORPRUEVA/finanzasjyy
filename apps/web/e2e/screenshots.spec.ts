import { expect, test } from '@playwright/test';
import path from 'node:path';
import { APP_ROUTES, ensureAuthenticated, openMenu } from './helpers';

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

/**
 * Capturas del menú lateral y de los dos temas. Estas no salen del recorrido de
 * rutas porque son ESTADOS (menú abierto, claro, oscuro) y no direcciones: sin
 * ellas, en la revisión no se puede comprobar cómo se ve lo que más se usa.
 */
test('capturas del menú lateral y de la apariencia', async ({ page }, testInfo) => {
  await ensureAuthenticated(page);
  const dir = path.join(OUTPUT_DIR, testInfo.project.name);

  // Menú lateral abierto, sobre el inicio.
  await page.goto('/');
  await openMenu(page);
  await page.screenshot({ path: path.join(dir, 'menu-lateral.png') });

  // Apariencia: las tres opciones y cómo queda cada tema.
  await page.keyboard.press('Escape');
  await page.goto('/ajustes?tab=apariencia');
  await expect(page.getByRole('heading', { name: 'Tema', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: path.join(dir, 'apariencia-ajustes.png'), fullPage: true });

  await page.getByRole('button', { name: /Claro/ }).first().click();
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: path.join(dir, 'inicio-claro.png') });

  await page.goto('/ajustes?tab=apariencia');
  await page.getByRole('button', { name: /Oscuro/ }).first().click();
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: path.join(dir, 'inicio-oscuro.png') });

  // Se deja la apariencia como estaba (claro) para no sorprender a nadie.
  await page.goto('/ajustes?tab=apariencia');
  await page.getByRole('button', { name: /Claro/ }).first().click();
});
