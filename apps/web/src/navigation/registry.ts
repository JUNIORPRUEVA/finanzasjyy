import type { ComponentType } from 'react';
import {
  IconBag,
  IconBell,
  IconCalendar,
  IconChart,
  IconCheck,
  IconDebt,
  IconFile,
  IconHome,
  IconList,
  IconLock,
  IconLogout,
  IconPlus,
  IconSettings,
  IconTarget,
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

/**
 * Grupos del menú lateral.
 *
 * Son SECCIONES fijas, no acordeones: todo se ve de un vistazo y cualquier
 * opción queda a un solo toque. El orden es el de uso real —lo de todos los días
 * arriba, el análisis después y la configuración al final, separada— para que el
 * menú se lea de arriba abajo sin tener que abrir nada.
 */
export const NAV_GROUPS: Array<{ id: NavGroupId; label: string; collapsible?: boolean }> = [
  { id: 'gestion', label: 'Día a día' },
  // «Análisis» es un solo botón que se despliega: sus cuatro pantallas no
  // tienen que estar siempre a la vista en un menú que debe caber de un vistazo.
  { id: 'analisis', label: 'Análisis', collapsible: true },
  { id: 'config', label: 'Configuración' },
  { id: 'sesion', label: 'Sesión' },
];

/**
 * Entradas que SIEMPRE están visibles al pie del menú.
 *
 * Ajustes y Cerrar sesión son las dos cosas que se buscan en un menú cuando ya
 * se está dentro de la aplicación; si quedan al final de una lista larga, hay
 * que desplazarse para encontrarlas. Fijas abajo se ven siempre, sin quitarles
 * el sitio a las opciones del día a día.
 */
export const DRAWER_FOOTER_IDS: readonly string[] = ['ajustes', 'cerrar-sesion'];

/**
 * Barra inferior: TRES destinos y el botón de añadir en medio.
 *
 * Control y Compras se movieron al menú lateral: la barra se queda en lo que se
 * toca a todas horas (Inicio, añadir, Movimientos) y deja de competir por el
 * pulgar con acciones que se usan de vez en cuando.
 */
export const BOTTOM_NAV: NavEntry[] = [
  // «Panel» y no «Inicio»: es una vista de resumen con enlaces, no el arranque
  // del asistente. El nombre dice mejor lo que hay dentro.
  { id: 'panel', label: 'Panel', icon: IconHome, to: '/', group: 'gestion', availability: 'ready', order: 0 },
  {
    id: 'anadir',
    label: 'Añadir',
    hint: 'Registrar un movimiento',
    icon: IconPlus,
    action: 'quick-add',
    group: 'gestion',
    availability: 'ready',
    order: 1,
  },
  {
    id: 'movimientos',
    label: 'Movimientos',
    icon: IconList,
    to: '/movimientos',
    group: 'gestion',
    availability: 'ready',
    order: 2,
  },
];

/** Entradas del menú lateral (las secundarias, agrupadas). */
export const DRAWER_ENTRIES: NavEntry[] = [
  // --- Gestión financiera ---------------------------------------------------
  {
    // Control y Compras, ARRIBA: son las dos pantallas que más se abren y las
    // que antes estaban en la barra inferior.
    id: 'control',
    label: 'Control',
    hint: 'Tareas pendientes y cierre del día',
    icon: IconTarget,
    to: '/control',
    group: 'gestion',
    availability: 'ready',
    order: 1,
  },
  {
    id: 'compras',
    label: 'Compras',
    hint: 'Listas y carrito',
    icon: IconBag,
    to: '/compras',
    group: 'gestion',
    availability: 'ready',
    order: 2,
  },
  {
    id: 'cuentas',
    label: 'Cuentas',
    hint: 'Dónde está el dinero',
    icon: IconWallet,
    to: '/cuentas',
    group: 'gestion',
    availability: 'ready',
    order: 10,
  },
  // NOTA: Traspasos, Fondos en custodia y Reembolsos NO se repiten aquí. Son
  // operaciones y ya están en el botón central «+», que es donde se buscan.
  // Tenerlas en los dos sitios era exactamente el ruido que sobraba.
  {
    id: 'deudas',
    label: 'Deudas',
    hint: 'Cuotas, tarjetas e intereses',
    icon: IconDebt,
    to: '/deudas',
    group: 'gestion',
    availability: 'ready',
    order: 11,
  },
  {
    // Comparar el saldo del libro con el del banco. Va aquí, al lado de las
    // cuentas, porque es lo que se hace al revisar el extracto.
    id: 'conciliacion',
    label: 'Conciliar cuentas',
    hint: 'Comparar con el banco y corregir diferencias',
    icon: IconCheck,
    to: '/conciliacion',
    group: 'gestion',
    availability: 'ready',
    order: 14,
  },
  // «Por cobrar», «por pagar» y «recurrentes» son tres pestañas de la MISMA
  // pantalla: se quedan en una entrada, como en Ajustes.
  {
    id: 'obligaciones',
    label: 'Obligaciones',
    hint: 'Por cobrar, por pagar y recurrentes',
    icon: IconChart,
    to: '/obligaciones',
    group: 'gestion',
    availability: 'ready',
    order: 12,
  },
  {
    id: 'presupuestos',
    label: 'Presupuestos',
    hint: 'Límites por categoría',
    // Diana, no barras: «Informes» ya usa el gráfico de barras y dos iconos
    // iguales en la misma lista obligan a leer para distinguirlos.
    icon: IconTarget,
    to: '/presupuestos',
    group: 'gestion',
    availability: 'ready',
    order: 13,
  },
  {
    // Notas y avisos: lo que no se puede olvidar. La app avisa a la hora fijada
    // y el enlace de calendario lo lleva también a Google Calendar.
    id: 'recordatorios',
    label: 'Recordatorios',
    hint: 'Lo que no se puede olvidar, con aviso',
    icon: IconBell,
    to: '/recordatorios',
    group: 'gestion',
    availability: 'ready',
    order: 15,
  },
  // Las «Unidades financieras» salieron del menú: se gestionan en
  // Configuración → Administración, junto a las personas con acceso.

  // --- Análisis y documentos ------------------------------------------------
  {
    id: 'informes',
    label: 'Informes',
    hint: 'Resultados y descarga en CSV',
    icon: IconChart,
    to: '/informes',
    group: 'analisis',
    availability: 'ready',
    order: 20,
  },
  {
    id: 'cierres',
    label: 'Cierres',
    hint: 'Cada día cerrado, con su diferencia',
    icon: IconCalendar,
    to: '/cierres',
    group: 'analisis',
    availability: 'ready',
    order: 21,
  },
  {
    id: 'documentos',
    label: 'Documentos',
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

  // --- Configuración --------------------------------------------------------
  // UNA sola puerta. Dentro de esa página están todas las opciones: perfil,
  // apariencia, notificaciones, seguridad, unidades, personas con acceso y
  // salud de los datos. En el menú no se repite ninguna de ellas.
  {
    id: 'ajustes',
    label: 'Configuración',
    hint: 'Todo lo que puede cambiar, en un solo sitio',
    icon: IconSettings,
    to: '/ajustes',
    group: 'config',
    availability: 'ready',
    order: 30,
  },

  // --- Sesión ---------------------------------------------------------------
  {
    id: 'cerrar-sesion',
    label: 'Cerrar sesión',
    hint: 'Los movimientos pendientes no se borran',
    icon: IconLogout,
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
  group: { id: NavGroupId; label: string; collapsible?: boolean };
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
