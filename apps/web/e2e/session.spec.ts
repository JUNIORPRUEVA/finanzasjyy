import { expect, test } from '@playwright/test';
import {
  collectConsoleErrors,
  ensureAuthenticated,
  ensureTestAccount,
  isLoginVisible,
  loginEmailField,
  navAddButton,
  quickMenu,
  sessionIndicator,
} from './helpers';

/**
 * SESIÓN PERSISTENTE, EN UN NAVEGADOR DE VERDAD
 * =============================================
 * El requisito del usuario es explícito: «no quiero tener que iniciar sesión
 * cada vez que cierro y vuelvo a abrir FINANZA». Y el fallo que había antes era
 * exactamente el contrario: si el servidor no contestaba al renovar, la sesión
 * se destruía y había que volver a escribir la contraseña.
 *
 * Estas pruebas simulan la red real (recarga de página, servidor caído, sesión
 * caducada) y comprueban la decisión de la aplicación en cada caso.
 *
 * Se ejecutan en un solo tamaño de pantalla a propósito: el comportamiento de la
 * sesión no depende del ancho de la pantalla, y repetirlo cinco veces sólo
 * alargaría la verificación sin aportar nada.
 */
test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'android-390x844',
    'La sesión se comprueba una vez: no depende del tamaño de pantalla',
  );
});

test.describe('entrar y permanecer dentro', () => {
  test('recargar la aplicación NO vuelve a pedir la contraseña', async ({ page }) => {
    await ensureAuthenticated(page);
    expect(await isLoginVisible(page)).toBe(false);

    // Recargar es lo que ocurre al cerrar y volver a abrir la PWA: el token de
    // memoria desaparece y sólo queda la cookie HttpOnly.
    await page.reload();

    await expect(navAddButton(page)).toBeVisible({ timeout: 30_000 });
    expect(await isLoginVisible(page)).toBe(false);
  });

  test('abrir FINANZA en otra pestaña del mismo teléfono entra directamente', async ({ page, context }) => {
    await ensureAuthenticated(page);

    const secondTab = await context.newPage();
    await secondTab.goto('/');

    await expect(navAddButton(secondTab)).toBeVisible({ timeout: 30_000 });
    expect(await isLoginVisible(secondTab)).toBe(false);
    await secondTab.close();
  });
});

test.describe('cuando el servidor no puede comprobar la sesión', () => {
  test('un 503 al renovar NO expulsa al usuario: sigue dentro y se avisa de que no hay conexión', async ({
    page,
    context,
  }) => {
    await ensureAuthenticated(page);

    // El servidor está de mantenimiento: ni la comprobación de sesión ni la
    // renovación responden.
    await context.route('**/api/v1/auth/me', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Mantenimiento' }) }),
    );
    await context.route('**/api/v1/auth/refresh', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Mantenimiento' }) }),
    );

    await page.reload();

    // Lo esencial: se entra igual, con lo último conocido del dispositivo.
    await expect(navAddButton(page)).toBeVisible({ timeout: 30_000 });
    expect(await isLoginVisible(page), 'un 503 no puede llevar a la pantalla de acceso').toBe(false);
    await expect(page.getByText(/Sin conexión/i).first()).toBeVisible();

    // Y cuando el servidor vuelve, la sesión se recupera sin escribir nada.
    // El indicador de la cabecera es el que dice si hay conexión y si hay algo
    // pendiente: ya no existe un cartel de «Sesión activa» (si estás dentro, la
    // sesión está bien) y el aviso de «Sin conexión» desaparece.
    await context.unroute('**/api/v1/auth/me');
    await context.unroute('**/api/v1/auth/refresh');
    await sessionIndicator(page).click();
    await expect(page.getByText(/Sin conexión/i)).toHaveCount(0, { timeout: 30_000 });
    expect(await isLoginVisible(page), 'recuperado el servidor, el usuario sigue dentro').toBe(false);
  });

  test('un corte de red al renovar tampoco cierra la sesión', async ({ page, context }) => {
    await ensureAuthenticated(page);

    await context.route('**/api/v1/auth/me', (route) => route.abort('internetdisconnected'));
    await context.route('**/api/v1/auth/refresh', (route) => route.abort('internetdisconnected'));

    await page.reload();

    await expect(navAddButton(page)).toBeVisible({ timeout: 30_000 });
    expect(await isLoginVisible(page)).toBe(false);
  });

  test('cuando la sesión caduca de verdad, sí se pide identificarse y se explica por qué', async ({ page, context }) => {
    await ensureAuthenticated(page);

    const expiredBody = JSON.stringify({
      code: 'SESSION_EXPIRED',
      message: 'Su sesión ha caducado por seguridad. Vuelva a identificarse.',
    });
    await context.route('**/api/v1/auth/me', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: expiredBody }),
    );
    await context.route('**/api/v1/auth/refresh', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: expiredBody }),
    );

    await page.reload();

    await expect(loginEmailField(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Su sesión ha caducado por seguridad/i)).toBeVisible();
    await expect(navAddButton(page)).toBeHidden();
  });
});

test.describe('nada se pierde', () => {
  test('un movimiento registrado sin conexión queda pendiente y sobrevive a recargar la aplicación', async ({
    page,
    context,
  }) => {
    const consoleErrors = collectConsoleErrors(page);
    await ensureAuthenticated(page);
    // Una cuenta donde poder registrar: sin cuentas, la aplicación (con razón)
    // no permite anotar nada, porque no se sabría de dónde sale el dinero.
    await ensureTestAccount(page);

    // Se visita «Registrar» una vez con conexión antes de cortarla. Las pantallas
    // se cargan bajo demanda (código dividido) y, en modo desarrollo, el servidor
    // de Vite no cachea nada: la primera visita descarga el trozo de esa pantalla.
    // En la PWA compilada esto no hace falta porque el Service Worker precachea
    // TODOS los ficheros, y por eso se visita también allí.
    await page.goto('/registrar');
    await expect(page.getByLabel('¿Cuánto salió?')).toBeVisible({ timeout: 15_000 });
    // Se vuelve al panel SIN recargar el documento (navegación interna): así la
    // pantalla de registro ya está descargada en este mismo documento.
    await page.getByRole('link', { name: 'Inicio', exact: true }).click();
    await expect(page.getByText(/¿Dónde está mi dinero\?/i)).toBeVisible();

    // 1) Se queda sin datos móviles.
    await context.setOffline(true);
    await expect(page.getByText(/Sin conexión/i).first()).toBeVisible({ timeout: 15_000 });

    // 2) Registra un gasto con el botón central.
    await navAddButton(page).click();
    // El nombre accesible de la acción incluye su explicación («Registrar gasto Sale dinero»).
    await quickMenu(page).getByRole('button', { name: /Registrar gasto/ }).click();
    await page.getByLabel('¿Cuánto salió?').fill('1250.50');
    await page.getByLabel('Descripción').fill('Compra de combustible');
    await page.getByRole('button', { name: 'Registrar movimiento' }).click();

    // La aplicación NUNCA dice «guardado» si el servidor no lo ha confirmado.
    // Se espera al mensaje exacto del resultado, no a cualquier texto que
    // mencione «sin confirmar» (el aviso de cabecera también lo dice).
    await expect(page.getByText(/Guardado en este dispositivo SIN CONFIRMAR/i)).toBeVisible({ timeout: 45_000 });
    // El indicador de la cabecera dice cuántas operaciones quedan sin confirmar.
    await expect(page.getByRole('button', { name: /1 operación\(es\) sin confirmar/i })).toBeVisible({
      timeout: 20_000,
    });

    // 3) Vuelve la conexión, pero el servidor sigue sin poder aceptar envíos.
    await context.route('**/api/v1/sync/push', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Mantenimiento' }) }),
    );
    await context.setOffline(false);

    // 4) Cerrar y volver a abrir la aplicación: la operación sigue ahí.
    await page.reload();
    await expect(navAddButton(page)).toBeVisible({ timeout: 30_000 });
    // Sigue pendiente después de cerrar y volver a abrir: no se ha perdido nada.
    await expect(page.getByRole('button', { name: /1 operación\(es\) sin confirmar/i })).toBeVisible({
      timeout: 30_000,
    });

    // Sin errores inesperados en consola durante todo el recorrido.
    expect(consoleErrors, `errores de consola: ${consoleErrors.join(' | ')}`).toEqual([]);
  });
});
