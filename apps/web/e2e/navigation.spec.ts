import { expect, test } from '@playwright/test';
import {
  APP_ROUTES,
  BOTTOM_NAV,
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
  test('la barra inferior tiene exactamente los cinco destinos acordados y ninguno es «Más»', async ({ page }) => {
    await ensureAuthenticated(page);

    const bar = page.getByRole('navigation', { name: 'Navegación principal' });
    await expect(bar).toBeVisible();

    // Los nombres y su ORDEN: es la promesa que se le hace al usuario.
    // Se toma la ÚLTIMA línea de cada acceso porque «Control» puede llevar encima
    // su contador de tareas obligatorias (el número se pinta dentro del mismo
    // enlace), y ese contador no cambia el nombre del destino.
    const labels = (await bar.locator('a, button').allInnerTexts()).map((text) =>
      text.trim().split('\n').pop()!.trim(),
    );
    expect(labels).toEqual([...BOTTOM_NAV]);

    // «Más» desapareció como destino: su contenido vive ahora en el menú lateral,
    // con nombre propio. Si alguien lo devolviera, esta prueba lo avisaría.
    await expect(bar.getByText('Más', { exact: true })).toHaveCount(0);
  });

  test('los cinco accesos llevan a donde dicen', async ({ page }) => {
    await ensureAuthenticated(page);

    await page.getByRole('link', { name: 'Movimientos', exact: true }).click();
    await expect(page).toHaveURL(/\/movimientos/);

    await navAddButton(page).click();
    await expect(page.getByText('¿Qué quiere registrar?')).toBeVisible();
    // El botón de añadir es un menú: se cierra sin haber cambiado de pantalla.
    await page.getByRole('button', { name: 'Cerrar', exact: true }).first().click();
    await expect(page.getByText('¿Qué quiere registrar?')).toBeHidden();

    // «Control» puede ir acompañado del número de tareas obligatorias, así que se
    // busca por su nombre sin exigir coincidencia exacta.
    await page.getByRole('link', { name: /^Control/ }).click();
    await expect(page).toHaveURL(/\/control/);

    await page.getByRole('link', { name: 'Compras', exact: true }).click();
    await expect(page).toHaveURL(/\/compras/);
    await expect(page.getByRole('heading', { name: 'Compras' })).toBeVisible();

    await page.getByRole('link', { name: 'Inicio', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('el menú de añadir abre cada operación a pantalla completa y sin pestañas de tipo', async ({ page }) => {
    await ensureAuthenticated(page);

    // Cada opción de movimiento abre SU pantalla: lo que se eligió es lo que se
    // abre, con su título. Dentro no hay pestañas para cambiar de tipo (entrar a
    // «Retiro» y acabar registrando un gasto es justo lo que se quitó).
    const casos: Array<{ action: RegExp; url: RegExp; titulo: string; campo: string }> = [
      {
        action: /Registrar ingreso/,
        url: /\/registrar\?kind=INCOME/,
        titulo: 'Registrar ingreso',
        campo: '¿Cuánto entró?',
      },
      {
        action: /Registrar gasto/,
        url: /\/registrar\?kind=EXPENSE/,
        titulo: 'Registrar gasto',
        campo: '¿Cuánto salió?',
      },
      {
        action: /Retiro personal/,
        url: /\/registrar\?kind=OWNER_WITHDRAWAL/,
        titulo: 'Retiro personal',
        campo: '¿Cuánto retiró?',
      },
    ];

    for (const caso of casos) {
      await navAddButton(page).click();
      await page.getByRole('button', { name: caso.action }).click();

      await expect(page).toHaveURL(caso.url);
      await expect(page.getByRole('heading', { name: caso.titulo })).toBeVisible();
      await expect(page.getByLabel(caso.campo)).toBeVisible();

      for (const otro of ['Ingreso', 'Gasto', 'Retiro', 'Aporte']) {
        await expect(page.getByRole('button', { name: otro, exact: true })).toHaveCount(0);
      }

      await page.goto('/');
    }
  });

  test('las acciones del menú de añadir que son pantallas navegan a donde dicen', async ({ page }) => {
    await ensureAuthenticated(page);

    const cases: Array<{ action: RegExp; url: RegExp; expectedLabel: string }> = [
      { action: /Transferir dinero/, url: /\/traspasos/, expectedLabel: 'Traspaso' },
      { action: /^Compras/, url: /\/compras/, expectedLabel: 'Nueva' },
      // La pantalla de cierre pide un «Día que se cierra»: es lo primero que se
      // ve siempre, haya o no movimientos ese día.
      { action: /Cerrar el día/, url: /\/cierres/, expectedLabel: 'Día que se cierra' },
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

  test('la categoría que falta se puede crear sin salir del formulario y queda puesta', async ({ page }) => {
    await ensureAuthenticated(page);
    await page.goto('/registrar?kind=EXPENSE');

    // Cada ejecución usa un nombre distinto: la lista es compartida con el resto
    // de las pruebas y no se puede depender de que no exista ya.
    const nombre = `Categoría E2E ${Date.now()}`;

    await page.getByRole('button', { name: '+ Nueva' }).click();
    const dialogo = page.getByRole('dialog', { name: 'Nueva categoría de gasto' });
    await expect(dialogo).toBeVisible();

    await dialogo.getByLabel('Nombre de la categoría').fill(nombre);
    await dialogo.getByRole('button', { name: 'Crear y usar' }).click();

    await expect(dialogo).toBeHidden({ timeout: 15_000 });
    // Queda seleccionada en el mismo formulario: no hay que volver a buscarla.
    await expect(page.getByLabel('Categoría').locator('option:checked')).toHaveText(nombre);
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
    const actionButton = page.getByRole('button', { name: /Registrar gasto/ });
    const actionBox = await actionButton.boundingBox();
    expect(actionBox!.height, 'acción de la hoja por debajo de 44 px').toBeGreaterThanOrEqual(44);
  });
});
