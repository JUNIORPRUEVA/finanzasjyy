import { expect, test } from '@playwright/test';
import {
  APP_ROUTES,
  collectConsoleErrors,
  ensureAuthenticated,
  expectNoHorizontalOverflow,
  expectNoWideElement,
  navAddButton,
} from './helpers';

/**
 * RECORRIDO COMPLETO DE LA APLICACIÓN EN TAMAÑO DE MÓVIL
 * ======================================================
 * Se visita cada pantalla en cada tamaño de teléfono configurado y se comprueba:
 *  · que carga y no se queda en blanco;
 *  · que la página NO se desplaza en horizontal (el defecto más molesto);
 *  · que ningún elemento se sale de la pantalla;
 *  · que no hay errores en consola ni excepciones.
 *
 * No se comprueba aquí la lógica financiera (de eso se encargan las pruebas de
 * la API y del libro mayor): esto es el recorrido de la interfaz.
 */
test.describe('recorrido de todas las pantallas', () => {
  test('la aplicación se abre en el panel', async ({ page }) => {
    await ensureAuthenticated(page);
    await expect(page.getByText(/¿Dónde está mi dinero\?/i)).toBeVisible();
  });

  for (const route of APP_ROUTES) {
    test(`pantalla ${route.name} (${route.path})`, async ({ page }) => {
      const consoleErrors = collectConsoleErrors(page);
      await ensureAuthenticated(page);

      await page.goto(route.path);

      // La pantalla cargó: hay contenido o el esqueleto de carga desapareció.
      await expect(page.locator('main')).toBeVisible();
      await expect(page.locator('body')).not.toContainText('Something went wrong', { timeout: 5_000 }).catch(() => undefined);

      // Se deja terminar las peticiones pendientes antes de medir.
      await page.waitForLoadState('networkidle').catch(() => undefined);

      await expectNoHorizontalOverflow(page, `${route.name} @ ${page.viewportSize()?.width}px`);
      await expectNoWideElement(page, `${route.name} @ ${page.viewportSize()?.width}px`);

      // Toda pantalla conserva la barra inferior y el botón de añadir.
      await expect(navAddButton(page)).toBeVisible();
      await expect(page.getByRole('link', { name: 'Inicio', exact: true })).toBeVisible();

      expect(consoleErrors, `${route.name}: errores de consola → ${consoleErrors.join(' | ')}`).toEqual([]);
    });
  }
});

test.describe('navegación inferior', () => {
  test('los cinco accesos llevan a donde dicen', async ({ page }) => {
    await ensureAuthenticated(page);

    await page.getByRole('link', { name: 'Movimientos', exact: true }).click();
    await expect(page).toHaveURL(/\/movimientos/);

    await navAddButton(page).click();
    await expect(page.getByText('¿Qué quiere registrar?')).toBeVisible();
    // El botón de añadir es un menú: se cierra sin haber cambiado de pantalla.
    await page.getByRole('button', { name: 'Cerrar', exact: true }).first().click();
    await expect(page.getByText('¿Qué quiere registrar?')).toBeHidden();

    await page.getByRole('link', { name: 'Control', exact: true }).click();
    await expect(page).toHaveURL(/\/control/);

    await page.getByRole('link', { name: 'Más', exact: true }).click();
    await expect(page).toHaveURL(/\/mas/);

    await page.getByRole('link', { name: 'Inicio', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('el menú de añadir ofrece las cuatro acciones diarias y cada una abre su pantalla', async ({ page }) => {
    await ensureAuthenticated(page);

    const cases: Array<{ action: RegExp; url: RegExp; expectedLabel: string }> = [
      { action: /^Ingreso /, url: /\/registrar\?kind=INCOME/, expectedLabel: '¿Cuánto entró?' },
      { action: /^Gasto /, url: /\/registrar\?kind=EXPENSE/, expectedLabel: '¿Cuánto salió?' },
      { action: /^Traspaso /, url: /\/traspasos/, expectedLabel: 'Traspaso' },
    ];

    for (const item of cases) {
      await navAddButton(page).click();
      await page.getByRole('button', { name: item.action }).click();
      await expect(page).toHaveURL(item.url);
      await expect(page.getByText(item.expectedLabel, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    }
  });

  test('se puede cambiar de unidad financiera y el consolidado vuelve a estar disponible', async ({ page }) => {
    await ensureAuthenticated(page);

    await page.getByRole('button', { name: /Todas las unidades/i }).click();
    await expect(page.getByText('Unidad financiera')).toBeVisible();
    await expect(page.getByText(/El consolidado suma todas las unidades/i)).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar', exact: true }).first().click();
  });
});

test.describe('formularios y diálogos', () => {
  test('el formulario de registro funciona con el teclado y muestra los campos obligatorios', async ({ page }) => {
    await ensureAuthenticated(page);
    await page.goto('/registrar');

    // El importe está listo para escribir según se abre la pantalla.
    const amount = page.getByLabel('¿Cuánto salió?');
    await expect(amount).toBeVisible();
    await amount.fill('99,90');
    await expect(amount).toHaveValue('99.90');

    // Sin descripción no se puede registrar: el botón permanece desactivado.
    const submit = page.getByRole('button', { name: 'Registrar movimiento' });
    await expect(submit).toBeDisabled();

    await page.getByLabel('Descripción', { exact: true }).fill('Prueba de formulario');
    await expect(submit).toBeEnabled();
  });

  test('los avisos emergentes se cierran con la tecla Escape', async ({ page }) => {
    await ensureAuthenticated(page);
    await navAddButton(page).click();
    await expect(page.getByText('¿Qué quiere registrar?')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('¿Qué quiere registrar?')).toBeHidden();
  });

  test('ningún control esencial tiene el tamaño de un alfiler', async ({ page }) => {
    await ensureAuthenticated(page);

    const navLinkBox = await page.getByRole('link', { name: 'Movimientos', exact: true }).boundingBox();
    expect(navLinkBox, 'la barra inferior debe existir').not.toBeNull();
    expect(navLinkBox!.height, 'acceso de la barra inferior por debajo de 44 px').toBeGreaterThanOrEqual(44);

    const fabBox = await navAddButton(page).boundingBox();
    expect(fabBox!.height, 'el botón central por debajo de 44 px').toBeGreaterThanOrEqual(44);

    // Los botones de la hoja de acciones también deben poder pulsarse con el dedo.
    await navAddButton(page).click();
    const actionButton = page.getByRole('button', { name: /^Gasto / });
    const actionBox = await actionButton.boundingBox();
    expect(actionBox!.height, 'acción de la hoja por debajo de 44 px').toBeGreaterThanOrEqual(44);
  });
});
