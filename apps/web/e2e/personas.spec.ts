import { expect, test } from '@playwright/test';
import { ensureAuthenticated } from './helpers';

/**
 * PERSONAS CON ACCESO Y FIRMA DE LAS ACCIONES
 * ===========================================
 * Lo que se exige aquí es una regla de la casa, no una preferencia:
 *
 *  1. Cualquier persona de la familia puede tener su propio acceso, sin
 *     configurar permisos ni restricciones.
 *  2. Cada cosa que se hace queda firmada con el nombre de quien la hizo. Si se
 *     añade alguien y luego desaparece del historial, la firma no existe.
 *
 * Estas pruebas lo comprueban sobre la aplicación real: se crea una persona y se
 * mira que la aplicación la acepte y la liste; y se comprueba que el historial
 * de movimientos muestra el autor de cada línea.
 */

test.describe('personas con acceso', () => {
  test('se puede crear una persona y aparece en la lista, sin configurar permisos', async ({ page }) => {
    await ensureAuthenticated(page);
    await page.goto('/personas');

    // El correo lleva la hora para que la prueba se pueda repetir sin chocar con
    // el usuario que creó la vuelta anterior.
    const correo = `familiar-${Date.now()}@finanza.test`;

    await page.getByRole('button', { name: 'Añadir persona' }).click();
    await expect(page.getByRole('dialog', { name: 'Añadir una persona' })).toBeVisible();

    await page.getByLabel('Nombre', { exact: true }).fill('Familiar de prueba');
    await page.getByLabel('Correo electrónico').fill(correo);
    await page.getByLabel('Contraseña').fill('Familia2026');
    await page.getByRole('button', { name: 'Crear acceso' }).click();

    // Se dice con todas las letras que ya puede entrar y que todo llevará su nombre.
    await expect(page.getByText(/ya puede entrar con su correo y su contraseña/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(correo)).toBeVisible();
    await expect(page.getByText('Familiar de prueba').first()).toBeVisible();
  });

  test('un correo repetido se rechaza con un mensaje claro, no con un error raro', async ({ page }) => {
    await ensureAuthenticated(page);
    await page.goto('/personas');

    await page.getByRole('button', { name: 'Añadir persona' }).click();
    await page.getByLabel('Nombre', { exact: true }).fill('Repetido');
    // El usuario con el que se entra en las pruebas ya existe.
    await page.getByLabel('Correo electrónico').fill('e2e@finanza.test');
    await page.getByLabel('Contraseña').fill('Familia2026');
    await page.getByRole('button', { name: 'Crear acceso' }).click();

    await expect(page.getByText(/ya existe un usuario con ese correo/i)).toBeVisible({ timeout: 20_000 });
  });

  test('el historial de movimientos dice quién registró cada uno', async ({ page }) => {
    await ensureAuthenticated(page);

    // Se registra un gasto para tener una línea propia que mirar.
    const descripcion = `Firma de prueba ${Date.now()}`;
    await page.goto('/registrar?kind=EXPENSE');
    await page.getByLabel('¿Cuánto salió?').fill('10.00');
    await page.getByLabel('Descripción').fill(descripcion);

    // Antes de guardar, la propia pantalla avisa de a quién va a firmar.
    await expect(page.getByText(/Se guardará como/i)).toBeVisible();
    await page.getByRole('button', { name: 'Registrar movimiento' }).click();
    await expect(page.getByText(/registrado|SIN CONFIRMAR|guardado/i).first()).toBeVisible({ timeout: 30_000 });

    await page.goto('/movimientos');
    // La fila del movimiento muestra su autor («por Nombre»).
    const fila = page.locator('div', { hasText: descripcion }).last();
    await expect(fila.getByText(/^por\s+\S+/)).toBeVisible({ timeout: 20_000 });
  });
});
