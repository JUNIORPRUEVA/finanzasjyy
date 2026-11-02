import { expect, test, type Page } from '@playwright/test';
import { collectConsoleErrors, ensureAuthenticated, expectNoHorizontalOverflow } from './helpers';

/**
 * CIERRE DEL NÚCLEO — CONCILIACIÓN Y ESTRUCTURA JURÍDICA
 * ======================================================
 * Estas pruebas recorren por la INTERFAZ los dos flujos que pueden estropear la
 * contabilidad si se hacen mal:
 *
 *  · **Conciliación**: comparar no cambia nada; una diferencia sólo genera
 *    asiento si se declara la causa «diferencia real autorizada», se escribe el
 *    motivo y se marca la autorización. Cualquier otra causa se guarda sin tocar
 *    el saldo.
 *  · **Estructura jurídica**: una unidad sin confirmar NO se asigna sola, y un
 *    vínculo imposible (finanzas personales dentro de una sociedad) se rechaza.
 *
 * Todas las cuentas que se crean aquí llevan un sufijo único para no depender del
 * estado que hayan dejado otras pruebas.
 */

const runId = Date.now().toString(36).slice(-6);

/** Elige en un desplegable la opción cuyo texto contiene `texto`. */
async function elegirOpcion(page: Page, etiqueta: string | RegExp, texto: string): Promise<void> {
  const select = page.getByLabel(etiqueta);
  const valor = await select.locator('option', { hasText: texto }).first().getAttribute('value');
  expect(valor, `No hay ninguna opción que contenga «${texto}» en «${String(etiqueta)}»`).toBeTruthy();
  await select.selectOption(valor!);
}

async function crearCuenta(page: Page, unidad: string | null, nombre: string, saldo: string): Promise<void> {
  await page.goto('/cuentas');
  await page.getByRole('button', { name: /Nueva cuenta/ }).click();
  if (unidad) {
    await elegirOpcion(page, 'Unidad financiera', unidad);
  }
  await page.getByLabel('Nombre de la cuenta').fill(nombre);
  await page.getByLabel('Saldo inicial documentado').fill(saldo);
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByText(nombre).first()).toBeVisible({ timeout: 20_000 });
}

test.describe('conciliación con el banco', () => {
  test('cuadra, diferencia anotada y ajuste autorizado', async ({ page }) => {
    const errores = collectConsoleErrors(page);
    await ensureAuthenticated(page);

    const cuenta = `Caja conciliable ${runId}`;
    await crearCuenta(page, null, cuenta, '100');

    await page.goto('/conciliacion');
    await expect(page.getByRole('heading', { name: 'Conciliar con el banco' }).or(page.getByText(/Conciliar con el banco/i).first())).toBeVisible({ timeout: 20_000 });
    await expectNoHorizontalOverflow(page, 'Conciliación');

    // ---- 1. La cuenta cuadra -------------------------------------------------
    await elegirOpcion(page, '¿Qué cuenta va a conciliar?', cuenta);
    await page.getByLabel('¿Cuánto dice el banco?').fill('100');
    await page.getByRole('button', { name: 'Comparar' }).click();

    await expect(page.getByText(/El banco y FINANZA coinciden/i)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Dejar constancia/i }).click();
    await expect(page.getByText(/La cuenta cuadra/i)).toBeVisible({ timeout: 20_000 });

    // ---- 2. Hay diferencia y se guarda SIN tocar el saldo --------------------
    await page.getByLabel('¿Cuánto dice el banco?').fill('90');
    await page.getByRole('button', { name: 'Comparar' }).click();
    await expect(page.getByText(/MENOS de lo que dice FINANZA/i)).toBeVisible({ timeout: 20_000 });

    // Con una causa que no se arregla con asiento, no se ofrece ajustar.
    await page.getByRole('radio', { name: /Falta apuntar un movimiento/i }).check();
    await expect(page.getByRole('button', { name: /Ajustar y cuadrar/i })).toHaveCount(0);

    await page.getByRole('radio', { name: /Todavía no lo sé/i }).check();
    await page.getByLabel('¿Qué ha comprobado?').fill('Falta un cargo que sale mañana');
    await page.getByRole('button', { name: /Guardar sin ajustar/i }).click();
    await expect(page.getByText(/sin tocar ningún saldo/i)).toBeVisible({ timeout: 20_000 });

    // El historial de esa cuenta lo deja claro: no se movió el saldo.
    await expect(page.getByText(/sin tocar el saldo/i).first()).toBeVisible({ timeout: 20_000 });

    // ---- 3. Ajuste autorizado ------------------------------------------------
    // Se vuelve a comparar: el saldo sigue siendo 100, así que la diferencia sigue
    // ahí. Eso demuestra que guardar la revisión no tocó nada.
    await page.getByLabel('¿Cuánto dice el banco?').fill('90');
    await page.getByRole('button', { name: 'Comparar' }).click();
    await expect(page.getByText(/MENOS de lo que dice FINANZA/i)).toBeVisible({ timeout: 20_000 });

    await page.getByRole('radio', { name: /Diferencia real revisada/i }).check();

    // Sin motivo y sin autorización, el botón está apagado: no se puede ajustar «por si acaso».
    const ajustar = page.getByRole('button', { name: /Ajustar y cuadrar/i });
    await expect(ajustar).toBeDisabled();

    await page.getByLabel('Motivo del ajuste (obligatorio)').fill('Comisión del banco verificada en el extracto');
    await expect(ajustar).toBeDisabled();

    await page.getByRole('checkbox', { name: /Autorizo este ajuste/i }).check();
    await expect(ajustar).toBeEnabled();
    await ajustar.click();

    await expect(page.getByText(/faltante|coincidir con el banco/i).first()).toBeVisible({ timeout: 20_000 });

    // Queda en el historial como confirmada y «con asiento de ajuste».
    await expect(page.getByText(/con asiento de ajuste/i).first()).toBeVisible({ timeout: 20_000 });

    expect(errores).toEqual([]);
  });
});

test.describe('estructura jurídica', () => {
  test('una unidad sin confirmar no se asigna sola, y el vínculo imposible se rechaza', async ({ page }) => {
    const errores = collectConsoleErrors(page);
    await ensureAuthenticated(page);

    const nuevoNegocio = `Negocio cierre ${runId}`;
    const nuevaPersonal = `Personal cierre ${runId}`;

    await page.goto('/unidades');
    // Se crean las dos unidades con el formulario de la propia pantalla.
    for (const [nombre, tipo] of [
      [nuevoNegocio, 'Negocio'],
      [nuevaPersonal, 'Finanzas personales'],
    ] as const) {
      await page.getByLabel('Nombre', { exact: true }).fill(nombre);
      await page.getByLabel('Tipo', { exact: true }).selectOption({ label: tipo });
      await page.getByRole('button', { name: /Crear unidad financiera/i }).click();
      await expect(page.getByText(nombre).first()).toBeVisible({ timeout: 20_000 });
    }

    await expectNoHorizontalOverflow(page, 'Unidades');

    // La unidad nueva aparece «sin confirmar»: no se ha asignado sola.
    const filaNegocioSinConfirmar = page.getByRole('region', { name: nuevoNegocio });
    await expect(filaNegocioSinConfirmar.getByText('sin confirmar', { exact: true }).first()).toBeVisible({ timeout: 20_000 });

    // Se le asigna la sociedad existente.
    await filaNegocioSinConfirmar.getByLabel('Persona jurídica').selectOption({ label: 'FULLTECH S.R.L.' });
    await filaNegocioSinConfirmar.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText(/Relación jurídica guardada/i)).toBeVisible({ timeout: 20_000 });
    await expect(filaNegocioSinConfirmar.getByText('confirmada', { exact: true }).first()).toBeVisible({ timeout: 20_000 });

    // Y ahora un vínculo imposible: finanzas personales dentro de una SOCIEDAD.
    const filaPersonal = page.getByRole('region', { name: nuevaPersonal });
    await filaPersonal.getByLabel('Persona jurídica').selectOption({ label: 'FULLTECH S.R.L.' });
    await filaPersonal.getByRole('button', { name: 'Guardar' }).click();

    await expect(page.getByText(/persona física/i).first()).toBeVisible({ timeout: 20_000 });

    expect(errores).toEqual([]);
  });
});
