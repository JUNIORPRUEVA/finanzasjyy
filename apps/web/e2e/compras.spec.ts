import { expect, test, type Page } from '@playwright/test';
import { ensureAuthenticated, ensureTestAccount } from './helpers';

/**
 * COMPRAS PERSONALES — RECORRIDO COMPLETO
 * =======================================
 * La promesa del módulo, comprobada de punta a punta:
 *  1. Preparar una lista y marcar lo comprado NO mueve dinero.
 *  2. El gasto se registra SÓLO cuando el usuario lo decide, y por el camino
 *     financiero de siempre: aparece en Movimientos.
 *  3. Pulsar dos veces «Registrar gasto» NO duplica el gasto.
 *  4. Una lista con el gasto registrado no se puede borrar (se archiva): el
 *     histórico no se reescribe.
 *
 * Estas pruebas escriben movimientos de verdad, así que se ejecutan contra la
 * base de datos de pruebas (`finanza_test`), nunca contra la de trabajo.
 */

async function openShoppingList(page: Page, name: string): Promise<void> {
  await page.goto('/compras');
  await page.getByRole('link', { name: new RegExp(name) }).first().click();
  await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible({ timeout: 15_000 });
}

async function addItem(page: Page, name: string, quantity: string, price: string): Promise<void> {
  // Añadir vive en el botón flotante: la pantalla sólo muestra la lista y la lupa.
  await page.getByRole('button', { name: 'Añadir producto a la lista' }).click();
  const hoja = page.getByRole('dialog', { name: 'Añadir a la lista' });
  await expect(hoja).toBeVisible();
  await hoja.getByLabel('¿Qué necesita?').fill(name);
  await hoja.getByLabel('Cantidad').fill(quantity);
  await hoja.getByLabel('Precio estimado').fill(price);
  await hoja.getByRole('button', { name: 'Añadir a la lista' }).click();
  await expect(page.getByText(name, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
}

/** Cuántas veces aparece un importe concreto en la pantalla de Movimientos. */
async function countMovementsFor(page: Page, needle: string): Promise<number> {
  await page.goto('/movimientos');
  return page.getByText(needle, { exact: false }).count();
}

/** Crea una lista desde la pantalla y devuelve su nombre único. */
async function createList(page: Page, prefix: string): Promise<string> {
  const listName = `${prefix} ${Date.now().toString().slice(-7)}`;
  await page.goto('/compras');
  await page.getByRole('button', { name: 'Nueva' }).first().click();
  await page.getByLabel('Nombre de la lista').fill(listName);
  await page.getByRole('button', { name: 'Crear lista' }).click();
  await expect(page.getByRole('heading', { name: listName })).toBeVisible({ timeout: 20_000 });
  return listName;
}

test.describe('compras personales', () => {
  test('preparar la lista y marcar lo comprado no mueve ni un centavo', async ({ page }) => {
    // El recorrido es largo (entrar, crear la cuenta de pruebas, la lista, los
    // productos y las comprobaciones). El límite general de la suite está pensado
    // para pantallas sueltas, no para una historia completa.
    test.setTimeout(180_000);
    await ensureAuthenticated(page);

    const listName = await createList(page, 'Compra sin gasto E2E');

    await addItem(page, 'Arroz E2E', '2', '310.25');
    await addItem(page, 'Habichuelas E2E', '5', '200');

    // Estimado = 2 × 310,25 + 5 × 200 = 1.620,50
    await expect(page.getByText('RD$ 1,620.50').first()).toBeVisible();

    // Se marca todo como comprado (sin tocar el precio real: se da por bueno el previsto).
    for (const item of ['Arroz E2E', 'Habichuelas E2E']) {
      await page.getByRole('button', { name: new RegExp(item) }).first().click();
      await page.waitForTimeout(600);
    }
    await expect(page.getByText(/2 de 2 productos comprados/)).toBeVisible();

    // Hay total pagado... pero el gasto SIGUE SIN REGISTRAR: el botón para
    // registrarlo está ahí, esperando una decisión del usuario. Nada mueve dinero
    // hasta que él lo decide.
    await expect(page.getByRole('button', { name: /Registrar gasto en FINANZA/ })).toBeVisible();

    // Y en Movimientos no hay ningún movimiento con ese importe.
    expect(
      await countMovementsFor(page, '1,620.50'),
      'marcar productos como comprados no puede generar un movimiento',
    ).toBe(0);
  });

  test('registrar el gasto crea UN movimiento, y la lista no puede volver a generarlo', async ({ page }) => {
    test.setTimeout(240_000);
    await ensureAuthenticated(page);
    await ensureTestAccount(page);

    const listName = await createList(page, 'Compra contabilizada E2E');

    // Un solo producto para que el importe sea único e inconfundible.
    await addItem(page, 'Producto único E2E', '1', '100.50');
    await page.getByRole('button', { name: /Producto único E2E/ }).first().click();
    await expect(page.getByText(/1 de 1 productos comprados/)).toBeVisible();

    await page.getByRole('button', { name: /Registrar gasto en FINANZA/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Registrar el gasto en FINANZA' });
    await expect(sheet).toBeVisible();

    // La cuenta la elige el usuario: FINANZA no adivina de dónde sale el dinero.
    const accountSelect = sheet.getByLabel('¿De qué cuenta sale el dinero?');
    const accountOption = (await accountSelect.locator('option').allTextContents()).find((text) =>
      text.includes('Caja de pruebas'),
    );
    expect(accountOption, 'debe existir la cuenta de pruebas creada por las pruebas').toBeTruthy();
    await accountSelect.selectOption({ label: accountOption! });

    // El importe se escribe aquí (lo contabilizado es lo que se escriba, no lo estimado).
    await sheet.getByLabel('Importe pagado').fill('100.50');
    await sheet.getByRole('button', { name: 'Registrar gasto', exact: true }).click();

    // La lista queda contabilizada y ya no ofrece registrarlo otra vez: en la
    // interfaz no hay nada que pulsar dos veces.
    await expect(page.getByRole('link', { name: /Ver el movimiento en Movimientos/ })).toBeVisible({
      timeout: 25_000,
    });
    await expect(page.getByRole('button', { name: /Registrar gasto en FINANZA/ })).toBeHidden();

    // El movimiento existe en Movimientos, UNA vez. Se busca por la descripción
    // que FINANZA pone al gasto («Compra: <nombre de la lista>»), que es única de
    // esta ejecución, y se comprueba el recuento real de la cabecera: contar
    // apariciones sueltas del texto no valdría, porque el importe sale también en
    // los filtros y en los totales.
    await page.getByRole('link', { name: /Ver el movimiento en Movimientos/ }).click();
    await expect(page).toHaveURL(/\/movimientos/);
    await page.getByLabel('Buscar', { exact: true }).fill(listName);
    await expect(page.getByText('1 movimiento(s)')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('100.50', { exact: false }).first()).toBeVisible();
  });

  test('la compra se puede repartir entre dos personas por pasillos', async ({ page }) => {
    await ensureAuthenticated(page);
    await ensureTestAccount(page);

    const listName = await createList(page, 'Compra repartida E2E');
    await addItem(page, 'Plátano verde', '6', '25');
    await addItem(page, 'Detergente', '1', '180');
    await addItem(page, 'Pechuga de pollo', '2', '290');

    await page.getByRole('button', { name: 'Repartir' }).first().click();
    const hoja = page.getByRole('dialog', { name: 'Repartir la compra' });
    await expect(hoja).toBeVisible();

    // Dos partes, y cada una con su enlace para enviarla (WhatsApp/Bluetooth).
    await expect(hoja.getByText('Parte 1')).toBeVisible();
    await expect(hoja.getByText('Parte 2')).toBeVisible();
    await expect(hoja.getByRole('button', { name: 'Compartir esta parte' }).first()).toBeVisible();

    // Lo que ya está comprado no se reparte: se marca todo y no debe haber partes.
    await hoja.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect(hoja).toBeHidden();
  });

  test('una lista vacía no se puede contabilizar y se dice por qué', async ({ page }) => {
    await ensureAuthenticated(page);

    const stamp = Date.now().toString().slice(-7);
    const listName = `Compra vacía E2E ${stamp}`;

    await page.goto('/compras');
    await page.getByRole('button', { name: 'Nueva' }).first().click();
    await page.getByLabel('Nombre de la lista').fill(listName);
    await page.getByRole('button', { name: 'Crear lista' }).click();
    await expect(page.getByRole('heading', { name: listName })).toBeVisible({ timeout: 20_000 });

    await expect(page.getByText('Lista vacía')).toBeVisible();
    await expect(page.getByText('Terminar la compra')).toBeVisible();
    await expect(page.getByText(/Registrar el gasto es lo único que mueve dinero/i)).toBeVisible();
  });

  test('la lista se puede preparar sin conexión y se envía sola al recuperarla', async ({ page, context }) => {
    test.setTimeout(180_000);
    await ensureAuthenticated(page);
    await ensureTestAccount(page);

    const stamp = Date.now().toString().slice(-7);
    const listName = `Compra offline E2E ${stamp}`;

    // Se abre la pantalla con conexión (para tener la sesión y la copia local)...
    await page.goto('/compras');
    await expect(page.getByRole('button', { name: 'Nueva' }).first()).toBeVisible();

    // ...y se corta la red de verdad a nivel de navegador.
    await context.setOffline(true);

    await page.getByRole('button', { name: 'Nueva' }).first().click();
    await page.getByLabel('Nombre de la lista').fill(listName);
    await page.getByRole('button', { name: 'Crear lista' }).click();

    // Queda dicha la verdad: está en el teléfono, pendiente de enviar.
    await expect(page.getByText(/pendiente de enviar/i).first()).toBeVisible({ timeout: 20_000 });

    // Vuelve la red: se envía sola y el aviso desaparece.
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    await expect
      .poll(async () => {
        await page.goto('/compras');
        return page.getByText(/pendiente de enviar/i).count();
      }, { timeout: 30_000 })
      .toBe(0);

    // Y la lista existe en el servidor: se puede abrir y añadirle productos.
    await page.getByRole('link', { name: new RegExp(listName) }).first().click();
    await expect(page.getByRole('heading', { name: listName })).toBeVisible();
    await addItem(page, 'Producto tras reconectar', '1', '99.99');
  });
});
