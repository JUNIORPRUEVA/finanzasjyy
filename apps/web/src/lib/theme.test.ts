import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  deviceThemePreference,
  readStoredTheme,
  resolveTheme,
  setThemePreference,
  watchSystemTheme,
} from './theme';

/**
 * PRUEBAS DEL TEMA (APARIENCIA)
 * -----------------------------
 * Dos cosas que el usuario nota de inmediato y que, si fallan, molestan mucho:
 *  · Que el tema se RECUERDE (nadie quiere elegir claro cada vez que abre).
 *  · Que se distinga «nunca he elegido» de «elegí seguir al sistema». De esa
 *    diferencia depende que el tema de la cuenta se adopte en un teléfono nuevo
 *    pero NO pise lo que el usuario eligió en el suyo.
 */

const STORAGE_KEY = 'finanza.theme';

describe('tema y apariencia', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    vi.restoreAllMocks();
  });

  it('sin nada guardado, la preferencia del dispositivo es «como el sistema»', () => {
    expect(readStoredTheme()).toBeNull();
    expect(deviceThemePreference()).toBe('system');
  });

  it('guarda la elección y la aplica al documento', () => {
    const resolved = setThemePreference('light');

    expect(resolved).toBe('light');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('distingue «nunca elegí» de «elegí seguir al sistema»', () => {
    expect(readStoredTheme()).toBeNull();

    setThemePreference('system');
    // Ya hay una elección explícita, aunque su valor sea «system»: importa,
    // porque indica que el usuario pasó por los ajustes en ESTE teléfono.
    expect(readStoredTheme()).toBe('system');
  });

  it('ignora un valor corrupto en el almacenamiento en lugar de romperse', () => {
    localStorage.setItem(STORAGE_KEY, 'turquesa');
    expect(readStoredTheme()).toBeNull();
    expect(deviceThemePreference()).toBe('system');
  });

  it('«como el sistema» resuelve al modo del teléfono', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('prefers-color-scheme: light') ? true : false,
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );

    expect(resolveTheme('system')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('cambia solo cuando el sistema cambia y sólo si se eligió «como el sistema»', () => {
    // El manejador que registra el módulo se guarda en un objeto: así el tipo no
    // se estrecha a `never` cuando TypeScript analiza el cierre.
    const captured: { change: (() => void) | null } = { change: null };
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener: (_event: string, listener: () => void) => {
          captured.change = listener;
        },
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    });

    const onChange = vi.fn();
    const stop = watchSystemTheme(onChange);

    // Con una elección explícita distinta, el cambio del sistema NO se aplica.
    setThemePreference('dark');
    captured.change?.();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    // Con «como el sistema», sí.
    setThemePreference('system');
    captured.change?.();
    expect(onChange).toHaveBeenCalled();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    stop();
  });

  it('aplicar un tema a mano no lo guarda (guardar y aplicar son cosas distintas)', () => {
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
