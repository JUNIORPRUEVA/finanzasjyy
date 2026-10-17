import { describe, expect, it } from 'vitest';
import { ALL_NAV_ENTRIES, BOTTOM_NAV, DRAWER_ENTRIES, visibleDrawerEntries } from './registry';

/**
 * PRUEBAS DEL REGISTRO DE NAVEGACIÓN
 * ----------------------------------
 * La navegación es una promesa: «lo que ves es lo que hay». Estas pruebas fijan
 * lo acordado con el usuario para que no se pueda cambiar sin querer:
 *  · Cinco destinos abajo, ni uno más, y «Más» no vuelve a aparecer.
 *  · Ninguna opción decorativa: toda entrada lleva a una ruta o ejecuta algo.
 *  · Lo que exige permisos (Auditoría) se oculta de verdad a quien no los tiene.
 */

describe('registro de navegación', () => {
  it('la barra inferior tiene exactamente los cinco destinos acordados, en orden', () => {
    expect(BOTTOM_NAV.map((entry) => entry.label)).toEqual(['Inicio', 'Movimientos', 'Añadir', 'Control', 'Compras']);
    expect(BOTTOM_NAV).toHaveLength(5);
  });

  it('«Más» no existe como destino (sus funciones viven en el menú lateral)', () => {
    const labels = ALL_NAV_ENTRIES.map((entry) => entry.label.toLowerCase());
    expect(labels).not.toContain('más');
    expect(ALL_NAV_ENTRIES.some((entry) => entry.to === '/mas')).toBe(false);
  });

  it('el botón central no navega: sólo abre las acciones rápidas', () => {
    const central = BOTTOM_NAV.filter((entry) => entry.action === 'quick-add');
    expect(central).toHaveLength(1);
    expect(central[0].to).toBeUndefined();
    expect(central[0].label).toBe('Añadir');
  });

  it('ninguna entrada es decorativa: o lleva a una ruta, o ejecuta una acción', () => {
    for (const entry of ALL_NAV_ENTRIES) {
      const hasRoute = typeof entry.to === 'string' && entry.to.startsWith('/');
      const hasAction = Boolean(entry.action);
      expect(hasRoute || hasAction, `la entrada «${entry.label}» no lleva a ningún sitio`).toBe(true);
    }
  });

  it('todo lo que se muestra está implementado: no se anuncia lo que no existe', () => {
    for (const entry of ALL_NAV_ENTRIES) {
      expect(entry.availability, `«${entry.label}» debería estar lista para usarse`).toBe('ready');
    }
  });

  it('la auditoría sólo la ve quien tiene permiso', () => {
    const ownerGroups = visibleDrawerEntries('OWNER').flatMap((section) => section.entries.map((entry) => entry.id));
    const operatorGroups = visibleDrawerEntries('OPERATOR').flatMap((section) => section.entries.map((entry) => entry.id));
    const viewerGroups = visibleDrawerEntries('VIEWER').flatMap((section) => section.entries.map((entry) => entry.id));

    expect(ownerGroups).toContain('auditoria');
    expect(operatorGroups).not.toContain('auditoria');
    expect(viewerGroups).not.toContain('auditoria');
  });

  it('sin rol no se muestra nada que exija rol (ni se rompe)', () => {
    const anonymous = visibleDrawerEntries(null).flatMap((section) => section.entries.map((entry) => entry.id));
    expect(anonymous).not.toContain('auditoria');
    // Las opciones abiertas a cualquiera siguen ahí.
    expect(anonymous).toContain('cuentas');
  });

  it('el menú se agrupa por para qué sirve y dentro de cada grupo respeta el orden', () => {
    const sections = visibleDrawerEntries('OWNER');
    expect(sections.length).toBeGreaterThan(0);

    for (const section of sections) {
      expect(section.entries.length).toBeGreaterThan(0);
      const orders = section.entries.map((entry) => entry.order);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
      for (const entry of section.entries) {
        expect(entry.group).toBe(section.group.id);
      }
    }
  });

  it('cerrar sesión es una acción de sesión, no una ruta', () => {
    const logout = DRAWER_ENTRIES.find((entry) => entry.action === 'logout');
    expect(logout, 'debe existir la entrada de cerrar sesión').toBeTruthy();
    expect(logout!.to).toBeUndefined();
    expect(logout!.group).toBe('sesion');
  });
});
