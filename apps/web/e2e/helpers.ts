import { expect, type Page } from '@playwright/test';

/**
 * AYUDAS PARA LAS PRUEBAS DE NAVEGADOR
 * ------------------------------------
 * · Entrar una sola vez (creando el usuario propietario si la base de datos de
 *   pruebas está recién creada).
 * · Comprobar que la página no se desplaza en horizontal (el fallo más común en
 *   pantallas de 320-375 px).
 * · Recoger errores de consola para exigir que el recorrido salga limpio.
 */

export const E2E_USER = {
  name: 'Pruebas Automáticas',
  email: 'e2e@finanza.test',
  password: 'FinanzaE2E2026!segura',
};

/**
 * Se asegura de que exista al menos una cuenta donde registrar dinero,
 * creándola por la interfaz si hace falta.
 *
 * No es un atajo para «hacer pasar» la prueba: sin ninguna cuenta, FINANZA (con
 * razón) no deja registrar un movimiento, porque no se sabría de dónde sale ni
 * dónde entra el dinero. La base de datos de pruebas se crea con la estructura
 * mínima y sin saldos —las cifras las pone el usuario, nunca el sistema—, así que
 * la prueba crea su propia caja con saldo inicial 0 y nombre evidente.
 *
 * Se hace por la interfaz y no llamando a la API directamente porque la sesión
 * viaja en una cookie HttpOnly pensada sólo para renovar: el acceso a los datos
 * exige el token de memoria del navegador, así que la vía natural es la pantalla.
 */
export async function ensureTestAccount(page: Page): Promise<void> {
  await page.goto('/cuentas');

  // Con datos de una ejecución anterior no hace falta crear nada.
  const accountCard = page.getByText('Caja de pruebas (saldo 0)');
  const newAccountButton = page.getByRole('button', { name: 'Nueva cuenta' });
  await expect(accountCard.or(newAccountButton).first()).toBeVisible({ timeout: 30_000 });

  if (await accountCard.isVisible()) {
    return;
  }

  await newAccountButton.click();
  await page.getByLabel('Nombre de la cuenta').fill('Caja de pruebas (saldo 0)');
  await page.getByLabel('Saldo inicial documentado').fill('0');
  await page.getByRole('button', { name: 'Crear cuenta' }).click();

  await expect(accountCard).toBeVisible({ timeout: 30_000 });
}

/** Botón central «Añadir»: sólo existe cuando ya hay sesión. */
export function navAddButton(page: Page) {
  return page.getByRole('button', { name: 'Añadir movimiento' });
}

export function loginEmailField(page: Page) {
  return page.getByLabel('Correo electrónico', { exact: true });
}

export function loginPasswordField(page: Page) {
  return page.getByLabel('Contraseña', { exact: true });
}

/**
 * Entra en la aplicación. Si la base de datos está recién creada, la pantalla
 * mostrará «Primer uso» y se crea el usuario propietario; si ya existe, se
 * inicia sesión con las credenciales de pruebas.
 *
 * NOTA IMPORTANTE SOBRE LA SESIÓN EN LAS PRUEBAS: cada prueba abre un navegador
 * limpio y entra de verdad. NO se comparte una cookie guardada entre pruebas
 * porque el servidor ROTA el refresh token en cada uso y trata la reutilización
 * de un token antiguo como un robo: invalidaría todas las sesiones del usuario.
 * Es decir, el comportamiento correcto del servidor obliga a que cada prueba
 * tenga su propia sesión.
 */
export async function ensureAuthenticated(page: Page): Promise<void> {
  await page.goto('/');

  const emailField = loginEmailField(page);
  const addButton = navAddButton(page);

  // O aparece el acceso, o ya estamos dentro.
  await expect(emailField.or(addButton).first()).toBeVisible({ timeout: 30_000 });

  if (await emailField.isVisible()) {
    const createOwner = page.getByRole('button', { name: 'Crear usuario propietario' });

    if (await createOwner.isVisible()) {
      await page.getByLabel('Nombre', { exact: true }).fill(E2E_USER.name);
      await emailField.fill(E2E_USER.email);
      await loginPasswordField(page).fill(E2E_USER.password);
      await createOwner.click();
    } else {
      await emailField.fill(E2E_USER.email);
      await loginPasswordField(page).fill(E2E_USER.password);
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    }

    await expect(addButton).toBeVisible({ timeout: 30_000 });
  }

  // Se espera a que la sesión esté COMPLETAMENTE establecida. No es un detalle:
  // es en ese momento cuando la aplicación guarda en el dispositivo el perfil y
  // la autorización para trabajar sin conexión. Si una prueba se pusiera a
  // simular un corte de red antes de que ocurriera, estaría midiendo una
  // situación que no se da en la vida real (una sesión recién creada y sin
  // copia local).
  await expect(page.getByText(/Sesión activa|Sin conexión/i).first()).toBeVisible({ timeout: 30_000 });
}

/** ¿Se está mostrando la pantalla de acceso? */
export async function isLoginVisible(page: Page): Promise<boolean> {
  return loginEmailField(page).isVisible();
}

/**
 * El desbordamiento horizontal es el defecto que más molesta en un móvil:
 * el contenido se sale y hay que arrastrar la pantalla de lado.
 */
export async function expectNoHorizontalOverflow(page: Page, context: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return {
      document: root.scrollWidth - root.clientWidth,
      body: document.body.scrollWidth - root.clientWidth,
    };
  });

  expect(
    Math.max(overflow.document, overflow.body),
    `${context}: la página se desplaza en horizontal (${JSON.stringify(overflow)})`,
  ).toBeLessThanOrEqual(1);
}

/** Comprueba que ningún elemento visible sobresale del ancho de la ventana. */
export async function expectNoWideElement(page: Page, context: string): Promise<void> {
  const offenders = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const found: string[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        continue;
      }
      // Se ignoran los contenedores con desplazamiento propio (tablas largas).
      const scrollable = element.closest('.overflow-x-auto');
      if (scrollable) {
        continue;
      }
      if (rect.right > limit + 2 || rect.left < -2) {
        const label = `${element.tagName.toLowerCase()}.${(element.className || '').toString().slice(0, 60)}`;
        found.push(`${label} (${Math.round(rect.left)}→${Math.round(rect.right)} de ${limit})`);
      }
    }
    return found.slice(0, 6);
  });

  expect(offenders, `${context}: elementos que se salen de la pantalla`).toEqual([]);
}

/**
 * Recoge los errores de consola y las excepciones no capturadas.
 * Se descartan avisos del entorno de desarrollo que no son fallos del producto.
 */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];

  const isNoise = (text: string): boolean =>
    /React DevTools|\[vite\]|favicon|sourcemap|Download the React DevTools|net::ERR_|ERR_FAILED|ERR_ABORTED|Failed to load resource/i.test(
      text,
    );

  page.on('console', (message) => {
    if (message.type() === 'error' && !isNoise(message.text())) {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    if (!isNoise(error.message)) {
      errors.push(error.message);
    }
  });

  return errors;
}

/** Rutas de toda la aplicación (las que exigen sesión). */
export const APP_ROUTES: Array<{ path: string; name: string }> = [
  { path: '/', name: 'Panel' },
  { path: '/movimientos', name: 'Movimientos' },
  { path: '/registrar', name: 'Registrar' },
  { path: '/cuentas', name: 'Cuentas' },
  { path: '/control', name: 'Mi control diario' },
  { path: '/cierres', name: 'Cierre del día' },
  { path: '/traspasos', name: 'Traspasos' },
  { path: '/deudas', name: 'Préstamos y deudas' },
  { path: '/obligaciones', name: 'Obligaciones' },
  { path: '/presupuestos', name: 'Presupuestos' },
  { path: '/adjuntos', name: 'Documentos' },
  { path: '/unidades', name: 'Unidades financieras' },
  { path: '/informes', name: 'Informes' },
  { path: '/organizar', name: 'Organizar mi dinero' },
  { path: '/ajustes', name: 'Ajustes' },
  { path: '/mas', name: 'Más' },
];
