import { expect, test, type Page } from '@playwright/test';
import { ensureAuthenticated } from './helpers';

/**
 * APARIENCIA (CLARO / OSCURO / COMO EL SISTEMA)
 * ============================================
 * Se comprueba lo que el usuario nota:
 *  · Se aplica AL INSTANTE, sin recargar y sin quedarse a medias.
 *  · Se recuerda: al reabrir la aplicación sigue el tema elegido.
 *  · NO hay destello blanco: el tema ya está puesto cuando el navegador termina
 *    de leer el documento (si no, en un móvil de noche se ve un fogonazo).
 *  · «Como el sistema» cambia cuando cambia el sistema.
 */

async function themeOf(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

async function storedTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem('finanza.theme'));
}

async function openAppearance(page: Page): Promise<void> {
  await page.goto('/ajustes?tab=apariencia');
  await expect(page.getByRole('heading', { name: 'Tema', exact: true })).toBeVisible({ timeout: 20_000 });
}

test.describe('apariencia', () => {
  test('elegir un tema se aplica al instante, se marca como «En uso» y sobrevive a recargar', async ({ page }) => {
    await ensureAuthenticated(page);
    await openAppearance(page);

    await page.getByRole('button', { name: /Oscuro/ }).first().click();
    await expect.poll(() => themeOf(page)).toBe('dark');
    await expect.poll(() => storedTheme(page)).toBe('dark');
    // La opción elegida queda marcada: se ve cuál está en uso sin tener que
    // adivinar por el color de la pantalla.
    await expect(page.locator('[aria-pressed="true"]').getByText('En uso', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: /Claro/ }).first().click();
    await expect.poll(() => themeOf(page)).toBe('light');
    await expect.poll(() => storedTheme(page)).toBe('light');

    // Recargar y volver a entrar: sigue claro.
    await page.reload();
    await expect.poll(() => themeOf(page)).toBe('light');
  });

  test('no hay destello blanco: el tema está puesto antes de que se pinte la pantalla', async ({ page }) => {
    await ensureAuthenticated(page);
    await openAppearance(page);

    await page.getByRole('button', { name: /Oscuro/ }).first().click();
    await expect.poll(() => themeOf(page)).toBe('dark');

    // `domcontentloaded` es ANTES de que la aplicación se dibuje. Si en ese
    // instante ya está el tema oscuro, no hay fogonazo posible.
    await page.goto('/compras', { waitUntil: 'domcontentloaded' });
    expect(await themeOf(page), 'el tema debe estar aplicado antes de pintar').toBe('dark');
  });

  test('«como el sistema» sigue al teléfono: cambia solo cuando el teléfono cambia', async ({ page }) => {
    await ensureAuthenticated(page);
    await openAppearance(page);

    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByRole('button', { name: /Como el sistema/ }).first().click();
    await expect.poll(() => themeOf(page)).toBe('light');

    // El usuario no toca nada: es el sistema el que cambia de modo.
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => themeOf(page), { timeout: 5_000 }).toBe('dark');

    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => themeOf(page), { timeout: 5_000 }).toBe('light');
  });

  test('el tema de la cuenta se adopta en un dispositivo que todavía no ha elegido', async ({ page }) => {
    await ensureAuthenticated(page);

    // La cuenta tiene guardado un tema (se elige aquí y viaja al servidor).
    await openAppearance(page);
    await page.getByRole('button', { name: /Oscuro/ }).first().click();
    await expect.poll(() => storedTheme(page)).toBe('dark');

    // Se simula un teléfono nuevo: sin preferencia guardada en el dispositivo.
    await page.evaluate(() => localStorage.removeItem('finanza.theme'));
    await page.reload();

    // Debe abrir con el tema de la cuenta, no con el del sistema por defecto.
    await expect.poll(() => themeOf(page), { timeout: 20_000 }).toBe('dark');
  });
});
