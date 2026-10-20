import { expect, test } from '@playwright/test';
import { ensureAuthenticated, menu, menuButton, openMenu, sessionIndicator } from './helpers';

/**
 * MENÚ LATERAL (DRAWER)
 * =====================
 * Lo que se comprueba es lo que molesta cuando falta: que se pueda abrir y
 * cerrar de las tres formas naturales (tocando fuera, con Escape y eligiendo una
 * opción), que el fondo no se pueda tocar mientras está abierto, y que el foco
 * VUELVA al botón que lo abrió —quien navega con el teclado o con un lector de
 * pantalla se pierde si no vuelve—.
 */
test.describe('menú lateral', () => {
  test('se abre con el botón de tres líneas y agrupa las funciones por para qué sirven', async ({ page }) => {
    await ensureAuthenticated(page);

    await openMenu(page);
    const drawer = menu(page);

    // Los tres bloques, con una frase que dice qué hay dentro y cuántas opciones.
    for (const grupo of ['Gestión financiera', 'Análisis y documentos', 'Configuración']) {
      await expect(drawer.getByRole('button', { name: new RegExp(grupo) })).toBeVisible();
    }

    // «Gestión financiera» viene abierta (es lo de todos los días).
    await expect(drawer.getByRole('link', { name: /Cuentas y bancos/ })).toBeVisible();
    await expect(drawer.getByRole('link', { name: /Deudas y préstamos/ })).toBeVisible();

    // Compras NO se repite aquí: ya está en la barra inferior y el dueño pidió
    // quitarla del menú. Si alguien la devolviera, esta prueba lo avisa.
    await expect(drawer.getByRole('link', { name: /Listas de compras/ })).toHaveCount(0);

    // Las otras dos vienen plegadas: sus opciones no se ven hasta abrirlas, y por
    // eso el menú cabe en una pantalla de teléfono sin ser una lista infinita.
    await expect(drawer.getByRole('link', { name: /Auditoría/ })).toBeHidden();
    await expect(drawer.getByRole('link', { name: /^Ajustes/ })).toBeHidden();

    await drawer.getByRole('button', { name: /Análisis y documentos/ }).click();
    await expect(drawer.getByRole('link', { name: /Auditoría/ })).toBeVisible();

    // Perfil, apariencia, moneda y seguridad son pestañas de la MISMA pantalla:
    // una sola entrada en el menú, no cinco.
    await drawer.getByRole('button', { name: /Configuración/ }).click();
    await expect(drawer.getByRole('link', { name: /^Ajustes/ })).toBeVisible();
    await expect(drawer.getByRole('link', { name: /Apariencia/ })).toHaveCount(0);

    // El pie recuerda que no se pierde trabajo al cerrar sesión: es la duda que
    // tiene cualquiera antes de pulsar ese botón.
    await expect(drawer.getByText(/los movimientos que estén sin confirmar se conservan/i)).toBeVisible();
  });

  test('sólo hay un bloque abierto a la vez (y se puede cerrar el que está abierto)', async ({ page }) => {
    await ensureAuthenticated(page);

    await openMenu(page);
    const drawer = menu(page);
    const abiertos = async () => {
      const estados = await drawer
        .locator('button[aria-expanded]')
        .evaluateAll((botones) => botones.map((b) => b.getAttribute('aria-expanded')));
      return estados.filter((estado) => estado === 'true').length;
    };

    // De entrada hay exactamente uno abierto.
    expect(await abiertos()).toBe(1);

    await drawer.getByRole('button', { name: /Análisis y documentos/ }).click();
    expect(await abiertos(), 'abrir uno debe cerrar el anterior').toBe(1);
    await expect(drawer.getByRole('button', { name: /Análisis y documentos/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(drawer.getByRole('button', { name: /Gestión financiera/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    await drawer.getByRole('button', { name: /Configuración/ }).click();
    expect(await abiertos()).toBe(1);

    // Volver a pulsar el que está abierto lo cierra: deja el menú recogido del todo.
    await drawer.getByRole('button', { name: /Configuración/ }).click();
    expect(await abiertos()).toBe(0);
  });

  test('se cierra con Escape y el foco vuelve al botón que lo abrió', async ({ page }) => {
    await ensureAuthenticated(page);

    await openMenu(page);
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();

    // El foco vuelve al botón de abrir: sin esto, el siguiente tabulador
    // empezaría otra vez desde el principio de la página.
    await expect(menuButton(page)).toBeFocused();
  });

  test('se cierra al tocar fuera, en la franja que queda a la derecha', async ({ page }) => {
    await ensureAuthenticated(page);

    await openMenu(page);

    // Se toca FUERA del panel, en la franja de fondo que el menú deja a la
    // vista (por eso el panel no ocupa todo el ancho en el móvil).
    // Se mide el PANEL (la lista de dentro), no la capa que cubre la pantalla:
    // el diálogo abarca toda la ventana a propósito, para bloquear el fondo.
    const panel = await menu(page).getByRole('navigation').boundingBox();
    expect(panel, 'el panel del menú debe tener medidas').not.toBeNull();
    const viewport = page.viewportSize();
    expect(viewport, 'la prueba necesita un tamaño de ventana').not.toBeNull();

    // Debe quedar franja de fondo a la derecha: es lo que hace entender que el
    // menú se puede cerrar tocando fuera.
    const outsideX = panel!.x + panel!.width + 12;
    expect(outsideX, 'debe quedar franja de fondo a la derecha del panel').toBeLessThan(viewport!.width);
    await page.mouse.click(outsideX, panel!.y + panel!.height / 2);

    await expect(menu(page)).toBeHidden();
  });

  test('elegir una entrada navega y cierra el menú', async ({ page }) => {
    await ensureAuthenticated(page);

    await openMenu(page);
    await menu(page).getByRole('link', { name: /Cuentas y bancos/ }).click();

    await expect(page).toHaveURL(/\/cuentas/);
    await expect(menu(page)).toBeHidden();
  });

  test('cerrar sesión pide confirmación y avisa de que no se pierde nada', async ({ page }) => {
    await ensureAuthenticated(page);

    await openMenu(page);
    await menu(page).getByRole('button', { name: /Cerrar sesión/ }).click();

    // El diálogo de confirmación es un aviso con acciones: se identifica por su
    // título, que es lo que lee el usuario (y el lector de pantalla).
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('¿Cerrar sesión?')).toBeVisible();
    await expect(dialog.getByText(/sin confirmar se conservan/i)).toBeVisible();

    // Cancelar deja la sesión intacta: es la prueba de que el aviso no cierra
    // nada por su cuenta. Se pide el nombre EXACTO: el fondo del diálogo se
    // llama «Descartar aviso y cancelar» y no es el botón que se quiere pulsar.
    await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(sessionIndicator(page)).toBeVisible();
    await expect(page.getByLabel('Correo electrónico', { exact: true })).toBeHidden();
  });

  test('con el menú abierto, el fondo no se puede tocar', async ({ page }) => {
    await ensureAuthenticated(page);

    await openMenu(page);

    // El enlace «Inicio» de la barra inferior queda debajo de la capa oscura.
    // `trial: true` hace todas las comprobaciones de un clic real sin pulsarlo:
    // debe FALLAR, porque hay otra cosa encima. Si algún día dejara de fallar,
    // sería que el menú no está bloqueando el fondo.
    const navLink = page
      .getByRole('navigation', { name: 'Navegación principal' })
      .getByRole('link', { name: 'Inicio', exact: true });

    await expect(navLink.click({ trial: true, timeout: 2_000 })).rejects.toThrow();
    await expect(menu(page)).toBeVisible();
  });
});
