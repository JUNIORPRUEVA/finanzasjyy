import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { collectConsoleErrors, ensureAuthenticated, expectNoHorizontalOverflow, menu, openMenu } from './helpers';

/**
 * FONDOS EN CUSTODIA, EN EL NAVEGADOR DE VERDAD
 * ============================================
 * Que la API funcione no significa que el usuario pueda hacerlo. Esta prueba
 * recorre con el dedo lo mismo que hará el propietario:
 *
 *   1. Crear sus cuentas reales (BHD personal, Banreservas personal y el banco de
 *      FULLTECH) por la interfaz.
 *   2. Llegar a «Fondos en custodia» desde el menú lateral y desde Movimientos.
 *   3. Declarar el dinero de FULLTECH que YA estaba en el BHD (apertura).
 *   4. Registrar un cobro NUEVO de FULLTECH que cayó en el Banreservas personal.
 *   5. Comprobar que el panel dice de quién es cada peso.
 *   6. Liquidar el cobro del Banreservas hacia la cuenta de la empresa.
 *
 * Los importes NO se comparan con cifras fijas: la base de pruebas conserva lo
 * que registren las ejecuciones anteriores (los movimientos financieros son
 * inmutables por diseño). Las cifras exactas se comprueban en
 * `apps/api/test/custodia.e2e-spec.ts`, que corre sobre una base recién creada.
 * Aquí se comprueba lo que sólo se puede ver aquí: que la pantalla existe, se
 * llega a ella, se puede completar el registro y no hay errores ni desbordes.
 */

const CAPTURAS = path.join(process.cwd(), '..', '..', 'docs', 'capturas');
const PERFILES_CON_CAPTURA = ['android-390x844', 'iphone-375x667'];

/** Crea una cuenta por la interfaz sólo si todavía no existe. */
async function asegurarCuenta(page: Page, unidad: string, nombre: string, saldoInicial: string): Promise<void> {
  await page.goto('/cuentas');
  await page.waitForLoadState('networkidle').catch(() => undefined);

  if ((await page.getByText(nombre, { exact: false }).count()) > 0) {
    return;
  }

  await page.getByRole('button', { name: 'Nueva cuenta' }).click();
  await page.getByLabel('Unidad financiera').selectOption({ label: unidad });
  await page.getByLabel('Nombre de la cuenta').fill(nombre);
  await page.getByLabel('Tipo').selectOption({ label: 'Banco' });
  await page.getByLabel('Saldo inicial documentado').fill(saldoInicial);
  await page.getByRole('button', { name: 'Crear cuenta' }).click();

  await expect(page.getByText(nombre, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
}

/**
 * Elige una opción de un desplegable por el NOMBRE de la cuenta.
 *
 * `selectOption({ label })` exige el texto exacto y aquí la etiqueta lleva detrás
 * el saldo («BHD personal (custodia) (RD$ 50,000.00)»), así que se busca la opción
 * por el nombre y se selecciona por su valor.
 */
async function elegirCuenta(page: Page, etiqueta: string | RegExp, nombreCuenta: string): Promise<void> {
  const select = page.getByLabel(etiqueta);
  const valor = await select.locator('option', { hasText: nombreCuenta }).first().getAttribute('value');
  expect(valor, `No hay ninguna opción «${nombreCuenta}» en «${String(etiqueta)}»`).toBeTruthy();
  await select.selectOption(valor!);
}

test('el propietario registra y liquida dinero de una empresa en sus cuentas personales', async ({ page }, testInfo) => {
  const errores = collectConsoleErrors(page);
  await ensureAuthenticated(page);

  // ---- 0. Cuentas reales de partida ---------------------------------------
  await asegurarCuenta(page, 'FINANZAS PERSONALES', 'BHD personal (custodia)', '50000');
  await asegurarCuenta(page, 'FINANZAS PERSONALES', 'Banreservas personal (custodia)', '20000');
  await asegurarCuenta(page, 'FULLTECH', 'Banco FULLTECH (custodia)', '0');

  // ---- 1. Se llega desde el menú lateral -----------------------------------
  await page.goto('/');
  await openMenu(page);
  await menu(page).getByRole('link', { name: /Fondos en custodia/i }).click();
  await expect(page.getByRole('heading', { name: 'Fondos en custodia' })).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalOverflow(page, 'Fondos en custodia (resumen)');

  // ---- 2. Se llega también desde Movimientos -------------------------------
  await page.goto('/movimientos');
  await expect(page.getByRole('link', { name: /Fondos en custodia/i })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('link', { name: /Fondos en custodia/i }).click();
  await expect(page.getByRole('heading', { name: 'Fondos en custodia' })).toBeVisible({ timeout: 20_000 });

  // ---- 3. Declarar el dinero que YA estaba depositado en el BHD ------------
  await page.getByRole('button', { name: 'Registrar', exact: true }).click();
  await page.getByLabel('¿De qué empresa es el dinero?').selectOption({ label: 'FULLTECH' });
  await elegirCuenta(page, '¿En qué cuenta suya está?', 'BHD personal (custodia)');
  // Importes pequeños a propósito: la base de pruebas conserva lo que registraron
  // las ejecuciones anteriores y el servidor (con razón) no deja declarar más
  // custodia que dinero libre hay en la cuenta. Las cifras grandes se prueban en
  // `apps/api/test/custodia.e2e-spec.ts`, sobre una base recién creada.
  await page.getByLabel('Importe', { exact: true }).fill('1000');
  await page.getByLabel('Concepto').fill('Cobros de FULLTECH ya depositados antes de FINANZA');
  await page.getByRole('button', { name: 'Guardar registro' }).click();
  await expect(page.getByText(/Fondos registrados/i)).toBeVisible({ timeout: 30_000 });

  // ---- 4. Registrar un cobro NUEVO que cayó en el Banreservas --------------
  await page.getByRole('button', { name: 'Cobro nuevo' }).click();
  await page.getByLabel('¿De qué empresa es el dinero?').selectOption({ label: 'FULLTECH' });
  await elegirCuenta(page, '¿En qué cuenta suya está?', 'Banreservas personal (custodia)');
  await page.getByLabel('Importe', { exact: true }).fill('500');
  await page.getByLabel('Concepto').fill('Venta de equipos cobrada en Banreservas personal');
  await page.getByRole('button', { name: 'Guardar registro' }).click();
  await expect(page.getByText(/Cobro registrado/i)).toBeVisible({ timeout: 30_000 });

  // ---- 5. El panel dice de quién es el dinero ------------------------------
  await page.getByRole('button', { name: 'De quién es' }).click();
  await expect(page.getByText(/Es de/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/De empresas/i).first()).toBeVisible();
  await expect(page.getByText(/Suyo de verdad/i).first()).toBeVisible();

  if (PERFILES_CON_CAPTURA.includes(testInfo.project.name)) {
    await page.screenshot({
      path: path.join(CAPTURAS, testInfo.project.name, 'custodia-resumen.png'),
      fullPage: true,
    });
  }

  // ---- 6. Liquidar el cobro del Banreservas hacia el banco de FULLTECH -----
  await page.getByRole('button', { name: 'Liquidar', exact: true }).click();
  await page.getByRole('button', { name: /Banreservas personal \(custodia\)/ }).first().click();
  await elegirCuenta(page, /¿A qué cuenta de FULLTECH entra\?/, 'Banco FULLTECH (custodia)');
  await page.getByLabel('Importe a liquidar').fill('500');
  await page.getByRole('button', { name: 'Confirmar liquidación' }).click();

  await expect(page.getByText(/Liquidación registrada/i)).toBeVisible({ timeout: 30_000 });
  await expectNoHorizontalOverflow(page, 'Fondos en custodia (liquidación)');

  if (PERFILES_CON_CAPTURA.includes(testInfo.project.name)) {
    await page.screenshot({
      path: path.join(CAPTURAS, testInfo.project.name, 'custodia-liquidar.png'),
      fullPage: true,
    });
  }

  // ---- 7. El historial deja rastro de todo --------------------------------
  await page.getByRole('button', { name: 'Historial' }).click();
  await expect(page.getByText(/Liquidación/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Ya estaba depositado/).first()).toBeVisible();

  expect(errores, `Errores en consola: ${errores.join(' | ')}`).toEqual([]);
});
