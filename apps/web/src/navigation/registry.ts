import type { ComponentType } from 'react';
import {
  IconBag,
  IconBell,
  IconBuilding,
  IconCalendar,
  IconChart,
  IconDebt,
  IconFile,
  IconHome,
  IconList,
  IconLock,
  IconPlus,
  IconSettings,
  IconTarget,
  IconTransfer,
  IconWallet,
} from '../components/icons';

/**
 * REGISTRO CENTRAL DE NAVEGACIÓN
 * ==============================
 * Un solo sitio donde se declara TODO lo que se puede abrir en FINANZA: la barra
 * inferior y el menú lateral se construyen a partir de aquí.
 *
 * Por qué existe:
 *  · Añadir una pantalla nueva es añadir una entrada, no tocar dos menús.
 *  · No puede haber una opción «decorativa»: si no tiene ruta ni acción, no se
 *    pinta (y el tipo lo impide).
 *  · Las mismas reglas valen para móvil y escritorio: no hay dos menús distintos
 *    que puedan desincronizarse.
 *  · Los permisos y la disponibilidad se declaran una vez.
 *
 * `availability` es honesto por diseño: 'planned' significa que la función aún no
 * existe y NO se muestra como si existiera.
 */

export type NavGroupId = 'gestion' | 'analisis' | 'config' | 'sesion';

export type NavRole = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

export type NavAvailability = 'ready' | 'planned';

export interface NavEntry {
  /** Identificador estable (no cambia aunque cambie la ruta). */
  id: string;
  label: string;
  /** Frase corta que explica para qué sirve. */
  hint?: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  /** Ruta interna a la que lleva. */
  to?: string;
  /** Acción que no es navegación (por ejemplo, cerrar sesión). */
  action?: 'logout' | 'flush-shopping' | 'quick-add';
  group: NavGroupId;
  /** Roles que pueden verlo. Si no se indica, lo ve cualquier usuario con sesión. */
  roles?: NavRole[];
  /** ¿Necesita conexión para tener sentido? */
  requiresOnline?: boolean;
  /** ¿Está implementada de verdad? */
  availability: NavAvailability;
  /** Orden dentro del grupo. */
  order: number;
}

export const NAV_GROUPS: Array<{ id: NavGroupId; label: string; hint: string; collapsible: boolean }> = [
  {
    id: 'gestion',
    label: 'Gestión financiera',
    hint: 'Cuentas, deudas y presupuestos',
    collapsible: true,
  },
  {
    id: 'analisis',
    label: 'Análisis y documentos',
    hint: 'Informes, cierres y auditoría',
    collapsible: true,
  },
  {
    id: 'config',
    label: 'Configuración',
    hint: 'Apariencia, preferencias y seguridad',
    collapsible: true,
  },
  { id: 'sesion', label: 'Sesión', hint: '', collapsible: false },
];

/**
 * Barra inferior: EXACTAMENTE cinco destinos.
 * «Más» se retiró a propósito: sus funciones viven ahora en el menú lateral, con
 * nombre propio, en vez de escondidas en una lista heterogénea.
 */
export const BOTTOM_NAV: NavEntry[] = [
  { id: 'inicio', label: 'Inicio', icon: IconHome, to: '/', group: 'gestion', availability: 'ready', order: 0 },
  {
    id: 'movimientos',
    label: 'Movimientos',
    icon: IconList,
    to: '/movimientos',
    group: 'gestion',
    availability: 'ready',
    order: 1,
  },
  {
    id: 'anadir',
    label: 'Añadir',
    hint: 'Registrar un movimiento',
    icon: IconPlus,
    action: 'quick-add',
    group: 'gestion',
    availability: 'ready',
    order: 2,
  },
  {
    id: 'control',
    label: 'Control',
    icon: IconTarget,
    to: '/control',
    group: 'gestion',
    availability: 'ready',
    order: 3,
  },
  { id: 'compras', label: 'Compras', icon: IconBag, to: '/compras', group: 'gestion', availability: 'ready', order: 4 },
];

/** Entradas del menú lateral (las secundarias, agrupadas). */
export const DRAWER_ENTRIES: NavEntry[] = [
  // --- Gestión financiera ---------------------------------------------------
  {
    id: 'cuentas',
    label: 'Cuentas y bancos',
    hint: 'Dónde está el dinero',
    icon: IconWallet,
    to: '/cuentas',
    group: 'gestion',
    availability: 'ready',
    order: 10,
  },
  {
    id: 'compras-listas',
    label: 'Listas de compras',
    hint: 'Qué falta y cuánto costará',
    icon: IconBag,
    to: '/compras',
    group: 'gestion',
    availability: 'ready',
    order: 11,
  },
  {
    id: 'traspasos',
    label: 'Traspasos',
    hint: 'Mover dinero entre cuentas o negocios',
    icon: IconTransfer,
    to: '/traspasos',
    group: 'gestion',
    availability: 'ready',
    order: 12,
  },
  {
    id: 'deudas',
    label: 'Deudas y préstamos',
    hint: 'Cuotas, tarjetas e intereses',
    icon: IconDebt,
    to: '/deudas',
    group: 'gestion',
    availability: 'ready',
    order: 13,
  },
  {
    id: 'cobrar',
    label: 'Cuentas por cobrar',
    hint: 'Lo que le deben',
    icon: IconChart,
    to: '/obligaciones?tab=receivables',
    group: 'gestion',
    availability: 'ready',
    order: 14,
  },
  {
    id: 'pagar',
    label: 'Cuentas por pagar',
    hint: 'Lo que usted debe',
    icon: IconChart,
    to: '/obligaciones?tab=payables',
    group: 'gestion',
    availability: 'ready',
    order: 15,
  },
  {
    id: 'recurrentes',
    label: 'Obligaciones recurrentes',
    hint: 'Lo que se repite cada mes',
    icon: IconCalendar,
    to: '/obligaciones?tab=recurring',
    group: 'gestion',
    availability: 'ready',
    order: 16,
  },
  {
    id: 'presupuestos',
    label: 'Presupuestos',
    hint: 'Límites por categoría',
    icon: IconChart,
    to: '/presupuestos',
    group: 'gestion',
    availability: 'ready',
    order: 17,
  },
  {
    id: 'unidades',
    label: 'Unidades financieras',
    hint: 'Negocios y finanzas personales',
    icon: IconBuilding,
    to: '/unidades',
    group: 'gestion',
    availability: 'ready',
    order: 18,
  },

  // --- Análisis y documentos ------------------------------------------------
  {
    id: 'informes',
    label: 'Informes y exportaciones',
    hint: 'Resultados y descarga en CSV',
    icon: IconChart,
    to: '/informes',
    group: 'analisis',
    availability: 'ready',
    order: 20,
  },
  {
    id: 'cierres',
    label: 'Historial de cierres',
    hint: 'Cada día cerrado, con su diferencia',
    icon: IconCalendar,
    to: '/cierres',
    group: 'analisis',
    availability: 'ready',
    order: 21,
  },
  {
    id: 'documentos',
    label: 'Documentos y adjuntos',
    hint: 'Facturas y comprobantes',
    icon: IconFile,
    to: '/adjuntos',
    group: 'analisis',
    availability: 'ready',
    order: 22,
  },
  {
    id: 'auditoria',
    label: 'Auditoría',
    hint: 'Quién hizo qué, y cuándo',
    icon: IconLock,
    to: '/auditoria',
    group: 'analisis',
    roles: ['OWNER', 'ADMIN'],
    availability: 'ready',
    order: 23,
  },
  {
    id: 'organizar',
    label: 'Organizar mi dinero',
    hint: 'Asistente: cuánto hay y de quién es',
    icon: IconTarget,
    to: '/organizar',
    group: 'analisis',
    availability: 'ready',
    order: 24,
  },

  // --- Configuración --------------------------------------------------------
  {
    id: 'perfil',
    label: 'Perfil',
    hint: 'Su nombre, correo y contraseña',
    icon: IconSettings,
    to: '/ajustes',
    group: 'config',
    availability: 'ready',
    order: 30,
  },
  {
    id: 'apariencia',
    label: 'Apariencia',
    hint: 'Claro, oscuro o como el sistema',
    icon: IconSettings,
    to: '/ajustes?tab=apariencia',
    group: 'config',
    availability: 'ready',
    order: 31,
  },
  {
    id: 'preferencias',
    label: 'Configuración general',
    hint: 'Moneda, zona horaria y avisos',
    icon: IconSettings,
    to: '/ajustes?tab=preferencias',
    group: 'config',
    availability: 'ready',
    order: 32,
  },
  {
    id: 'notificaciones',
    label: 'Notificaciones',
    hint: 'Avisos en este dispositivo',
    icon: IconBell,
    to: '/ajustes?tab=notificaciones',
    group: 'config',
    availability: 'ready',
    order: 33,
  },
  {
    id: 'seguridad',
    label: 'Seguridad y dispositivos',
    hint: 'Contraseña y sesiones abiertas',
    icon: IconLock,
    to: '/ajustes?tab=seguridad',
    group: 'config',
    availability: 'ready',
    order: 34,
  },
  {
    id: 'sincronizacion',
    label: 'Sincronización',
    hint: 'Qué falta por confirmar en el servidor',
    icon: IconList,
    to: '/mas?tab=sincronizacion',
    group: 'config',
    availability: 'ready',
    order: 35,
  },

  // --- Sesión ---------------------------------------------------------------
  {
    id: 'cerrar-sesion',
    label: 'Cerrar sesión',
    hint: 'Los movimientos pendientes no se borran',
    icon: IconLock,
    action: 'logout',
    group: 'sesion',
    availability: 'ready',
    order: 40,
  },
];

/** Todas las entradas (barra + menú), sin la acción de añadir. */
export const ALL_NAV_ENTRIES: NavEntry[] = [...BOTTOM_NAV, ...DRAWER_ENTRIES];

/** Entradas del menú lateral que el usuario puede ver, agrupadas y ordenadas. */
export function visibleDrawerEntries(role: string | null | undefined): Array<{
  group: { id: NavGroupId; label: string; hint: string; collapsible: boolean };
  entries: NavEntry[];
}> {
  const canSee = (entry: NavEntry) =>
    entry.availability === 'ready' && (!entry.roles || (role ? entry.roles.includes(role as NavRole) : false));

  return NAV_GROUPS.map((group) => ({
    group,
    entries: DRAWER_ENTRIES.filter((entry) => entry.group === group.id && canSee(entry)).sort(
      (a, b) => a.order - b.order,
    ),
  })).filter((section) => section.entries.length > 0);
}
