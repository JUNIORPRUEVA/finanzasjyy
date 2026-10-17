/**
 * TEMA (APARIENCIA)
 * =================
 * Tres opciones: claro, oscuro o «como el sistema». La elección se guarda en dos
 * sitios y por un motivo:
 *
 *  · En el SERVIDOR (preferencias del usuario) para que viaje con la cuenta.
 *  · En el DISPOSITIVO (localStorage) para poder aplicarla **antes de pintar
 *    nada**. Si se esperase a la respuesta del servidor, se vería un parpadeo
 *    blanco al abrir la aplicación en modo oscuro: feo y, en un móvil de noche,
 *    molesto de verdad.
 *
 * El color real lo decide `src/index.css` (variables del tema). Aquí sólo se
 * marca `data-theme="light" | "dark"` en `<html>`.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'finanza.theme';

/** Color de la barra del navegador y del sistema en cada tema. */
const THEME_COLORS: Record<ResolvedTheme, string> = {
  dark: '#0a0f1c',
  light: '#f4f6fb',
};

export function readStoredTheme(): ThemePreference | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
  } catch {
    // Almacenamiento no disponible (modo privado): se usa el sistema.
  }
  return null;
}

/**
 * Lo que este dispositivo tiene elegido.
 *
 * Se distingue «nunca se eligió nada» (null) de «se eligió seguir al sistema»,
 * porque no es lo mismo: si el usuario NUNCA ha elegido en este teléfono, al
 * identificarse se adopta el tema de su cuenta; si ya eligió, su elección manda
 * aquí y no se le cambia por lo que diga el servidor (si no, una elección hecha
 * sin conexión se perdería al reabrir la aplicación, que es exactamente lo que
 * no debe pasar).
 */
export function deviceThemePreference(): ThemePreference {
  return readStoredTheme() ?? 'system';
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== 'system') {
    return preference;
  }
  if (typeof window === 'undefined' || !window.matchMedia) {
    return 'dark';
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Aplica el tema AHORA (sin esperar a React). */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  // `color-scheme` ajusta los controles nativos (selects, barras de scroll).
  root.style.colorScheme = resolved;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', THEME_COLORS[resolved]);
  }
  return resolved;
}

/** Guarda la preferencia y la aplica. Devuelve el tema resuelto. */
export function setThemePreference(preference: ThemePreference): ResolvedTheme {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Sin almacenamiento: el tema se aplica igual, sólo no se recuerda.
  }
  return applyTheme(preference);
}

/**
 * Mantiene el tema al día cuando la elección es «como el sistema».
 * Devuelve la función para dejar de escuchar.
 */
export function watchSystemTheme(onChange?: (resolved: ResolvedTheme) => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return () => undefined;
  }
  const query = window.matchMedia('(prefers-color-scheme: light)');
  const handler = () => {
    if (deviceThemePreference() !== 'system') {
      return;
    }
    const resolved = applyTheme('system');
    onChange?.(resolved);
  };
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}
