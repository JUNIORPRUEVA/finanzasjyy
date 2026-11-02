import { expect, test, type Page } from '@playwright/test';
import { collectConsoleErrors, ensureAuthenticated, expectNoHorizontalOverflow } from './helpers';

/**
 * «DINERO PARA MÍ» — QUE EL DINERO LLEGUE DE VERDAD
 * =================================================
 * El problema que se estaba viendo: se sacaba dinero de la empresa y no
 * aparecía en ninguna cuenta propia; el dinero se quedaba «en el aire».
 *
 * Esta prueba recorre el flujo por la interfaz y comprueba lo único que
 * importa de verdad: **el saldo del negocio baja y el saldo personal sube**, y
 * no aparece ningún ingreso inventado por el camino.
 */

const runId = Date.now().toString(36).slice(-6);

async function elegirOpcion(page: Page, etiqueta: string | RegExp, texto: string): Promise<void> {
  const select = page.getByLabel(etiqueta);
  const valor = await select.locator('option', { hasText: texto }).first().getAttribute('value');
  expect(valor, `No hay ninguna opción que contenga «${texto}» en «${String(etiqueta)}»`).toBeTruthy();
  await select.selectOption(valor!);
}

async function crearCuenta(page: Page, unidad: string, nombre: string, saldo: string): Promise<void> {
  await page.goto('/cuentas');
  await page.getByRole('button', { name: /Nueva cuenta/ }).click();
  await elegirOpcion(page, 'Unidad financiera', unidad);
  await page.getByLabel('Nombre de la cuenta').fill(nombre);
  await page.getByLabel('Saldo inicial documentado').fill(saldo);
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByText(nombre).first()).toBeVisible({ timeout: 20_000 });
}

test.describe('dinero para mí', () => {
  test('sacar dinero del negocio lo deja en la cuenta personal', async ({ page }) => {
    const errores = collectConsoleErrors(page);
    await ensureAuthenticated(page);

    const cajaNegocio = `Caja retiro ${runId}`;
    const bancoPersonal = `Banco retiro ${runId}`;

    // FULLTECH es una sociedad y FINANZAS PERSONALES es el propietario: las dos
    // tienen persona jurídica confirmada, así que la operación es posible.
    await crearCuenta(page, 'FULLTECH', cajaNegocio, '1000');
    await crearCuenta(page, 'FINANZAS PERSONALES', bancoPersonal, '0');

    await page.goto('/dinero-para-mi');
    await expect(page.getByRole('heading', { name: 'Dinero para mí' })).toBeVisible({ timeout: 20_000 });
    await expectNoHorizontalOverflow(page, 'Dinero para mí');

    await elegirOpcion(page, '¿De qué negocio sale el dinero?', 'FULLTECH');
    await elegirOpcion(page, '¿De qué cuenta del negocio?', cajaNegocio);
    await elegirOpcion(page, '¿A qué cuenta suya llega?', bancoPersonal);
    await page.getByLabel('¿Cuánto?').fill('250');

    // Un préstamo no se registra sin documento: el botón se apaga, no se «avisa
    // después». Es la diferencia entre impedir el error y contarlo.
    await page.getByRole('radio', { name: /La empresa me lo presta/i }).check();
    const guardar = page.getByRole('button', { name: /Pasar el dinero a mi cuenta/i });
    await expect(guardar).toBeDisabled();
    await page.getByLabel('Referencia del contrato o acuerdo').fill('CONTRATO-TEST-1');
    await expect(guardar).toBeEnabled();

    // Se elige «es mi dinero»: no es ingreso ni gasto en ningún sitio.
    await page.getByRole('radio', { name: /Es mi dinero/i }).check();
    await guardar.click();

    await expect(page.getByText(/ya está en su cuenta personal/i)).toBeVisible({ timeout: 20_000 });

    // Los saldos de las dos cuentas, en la propia pantalla: 1000 − 250 y 0 + 250.
    await expect(page.getByLabel('¿De qué cuenta del negocio?').locator('option', { hasText: cajaNegocio })).toContainText(
      '750.00',
      { timeout: 20_000 },
    );
    await expect(page.getByLabel('¿A qué cuenta suya llega?').locator('option', { hasText: bancoPersonal })).toContainText(
      '250.00',
      { timeout: 20_000 },
    );

    // Y queda en el historial de la pantalla, con su recorrido completo.
    await expect(page.getByRole('heading', { name: 'Últimos movimientos a mi cuenta' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(`De ${cajaNegocio} a ${bancoPersonal}`).first()).toBeVisible();

    expect(errores).toEqual([]);
  });
});
