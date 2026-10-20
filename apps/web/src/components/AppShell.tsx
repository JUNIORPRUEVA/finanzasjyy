import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { countPendingOperations, countShoppingPending } from '../lib/db';
import { flushShoppingQueue } from '../lib/shopping-offline';
import { syncPendingOperations } from '../lib/sync';
import { useAuth } from '../store/auth';
import { BOTTOM_NAV } from '../navigation/registry';
import { aplicarActualizacion, EVENTO_ACTUALIZACION } from '../lib/pwa';
import { useInstalacionApp } from '../lib/install';
import { Badge, ConfirmDialog, Panel, Sheet } from './ui';
import { Drawer } from './Drawer';
import { MovimientoForm, type EntryKind } from './MovimientoForm';
import { ToastHost, toast } from './Toast';
import {
  IconAlert,
  IconArrowDown,
  IconArrowUp,
  IconBag,
  IconBuilding,
  IconCheck,
  IconChevronRight,
  IconMenu,
  IconRefresh,
  IconTransfer,
  IconWallet,
  IconWifiOff,
} from './icons';
import type { IconProps } from './icons';

/**
 * ESTRUCTURA DE LA APLICACIÓN
 * ===========================
 * Móvil primero, con una idea clara de qué va dónde:
 *
 *  · CABECERA (fija, baja): menú lateral, unidad financiera activa, estado de
 *    sincronización y acceso a lo pendiente. Se ha quitado el cartel «Sesión
 *    activa»: si estás dentro, la sesión está bien; ocupaba sitio sin ofrecer
 *    nada. Ahora sólo se avisa cuando algo va mal (sin conexión) o cuando hay
 *    trabajo pendiente de confirmar.
 *  · BARRA INFERIOR (cinco destinos): Inicio · Movimientos · Añadir · Control ·
 *    Compras. «Más» desapareció: sus funciones están ahora en el menú lateral,
 *    con nombre propio.
 *  · MENÚ LATERAL: todo lo demás, agrupado por para qué sirve (ver
 *    `navigation/registry.ts`, la única fuente de verdad de la navegación).
 *
 * Estado de SESIÓN, de CONEXIÓN y de SINCRONIZACIÓN son tres cosas distintas, y
 * aquí se distinguen: confundirlas fue lo que hacía pensar que la sesión se
 * había cerrado cuando en realidad sólo fallaba la red.
 */

interface PendingTasks {
  tasks: Array<{ id: string; title: string; severity: string; isMandatory: boolean }>;
  mandatoryCount: number;
  level: string;
}

/**
 * ACCIONES RÁPIDAS DEL BOTÓN CENTRAL
 * ----------------------------------
 * Cada una lleva su icono porque en una lista de seis opciones la vista necesita
 * un ancla: se reconoce «el bolso» de Compras antes de leer nada. Van agrupadas
 * por para qué sirven, que es como se piensa al entrar aquí («voy a apuntar un
 * gasto» / «voy a la compra»), no por orden de llegada al código.
 *
 * Las cuatro primeras NO navegan: abren el formulario dentro del mismo panel.
 * Así apuntar un gasto son dos toques (+ → «Registrar gasto») y no se sale de la
 * pantalla en la que se estaba.
 */
interface AccionRapida {
  label: string;
  hint: string;
  icon: (props: IconProps) => React.ReactElement;
  /** Movimiento: abre el formulario aquí mismo. */
  kind?: EntryKind;
  /** Pantalla: navega y cierra el panel. */
  to?: string;
}

const QUICK_ACTIONS: Array<{ titulo: string; acciones: AccionRapida[] }> = [
  {
    titulo: 'Movimientos',
    acciones: [
      { kind: 'INCOME', label: 'Registrar ingreso', hint: 'Entra dinero', icon: IconArrowDown },
      { kind: 'EXPENSE', label: 'Registrar gasto', hint: 'Sale dinero', icon: IconArrowUp },
      { to: '/traspasos', label: 'Transferir dinero', hint: 'Entre sus cuentas o negocios', icon: IconTransfer },
      {
        kind: 'OWNER_WITHDRAWAL',
        label: 'Retiro personal',
        hint: 'Saca dinero para usted, no es gasto',
        icon: IconWallet,
      },
    ],
  },
  {
    titulo: 'Otros',
    acciones: [
      { to: '/compras', label: 'Compras', hint: 'Lista de la compra', icon: IconBag },
      { to: '/cierres', label: 'Cerrar el día', hint: 'Cuadrar las cuentas del día', icon: IconCheck },
    ],
  },
];

const TITULO_FORMULARIO: Record<EntryKind, string> = {
  INCOME: 'Registrar ingreso',
  EXPENSE: 'Registrar gasto',
  OWNER_WITHDRAWAL: 'Retiro personal',
  OWNER_CONTRIBUTION: 'Registrar aporte',
  ADJUSTMENT: 'Ajuste de saldo',
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, entities, sessionState, offlineAllowedUntil, reload, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingLocal, setPendingLocal] = useState(0);
  const [pendingShopping, setPendingShopping] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  // Qué se está registrando dentro del panel del «+». `null` = menú de opciones.
  const [quickKind, setQuickKind] = useState<EntryKind | null>(null);
  const [entitySheetOpen, setEntitySheetOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  // Versión nueva del service worker esperando: se avisa en una franja discreta.
  // Antes se quedaba esperando para siempre y el teléfono seguía con la vieja.
  const [hayVersionNueva, setHayVersionNueva] = useState(false);
  useEffect(() => {
    const alHaberActualizacion = () => setHayVersionNueva(true);
    window.addEventListener(EVENTO_ACTUALIZACION, alHaberActualizacion);
    return () => window.removeEventListener(EVENTO_ACTUALIZACION, alHaberActualizacion);
  }, []);

  // Instalar en el teléfono: el botón del menú sólo aparece si de verdad se
  // puede (Chrome con la instalación disponible, o iPhone con instrucciones).
  const instalacion = useInstalacionApp();

  /**
   * ABRIR EL MENÚ DESLIZANDO DESDE EL BORDE IZQUIERDO
   * -------------------------------------------------
   * El gesto que todo el mundo espera en un móvil. Se mide desde el borde
   * (28 px) para no chocar con los deslizamientos horizontales de dentro de la
   * aplicación, y se exige un recorrido claramente horizontal (más de 70 px y
   * menos de 60 en vertical) para no abrirlo al desplazar una lista.
   */
  const gestoMenu = useRef<{ x: number; y: number } | null>(null);

  const empezarGesto = (event: React.TouchEvent, desdeElBorde: boolean) => {
    const punto = event.touches[0];
    const libre = !drawerOpen && !quickOpen && !entitySheetOpen && !confirmLogout;
    gestoMenu.current = libre && (!desdeElBorde || punto.clientX <= 28) ? { x: punto.clientX, y: punto.clientY } : null;
  };

  const terminarGesto = (event: React.TouchEvent) => {
    const desde = gestoMenu.current;
    gestoMenu.current = null;
    if (!desde) {
      return;
    }
    const punto = event.changedTouches[0];
    const dx = punto.clientX - desde.x;
    const dy = punto.clientY - desde.y;
    if (dx > 70 && Math.abs(dy) < 60) {
      setDrawerOpen(true);
    }
  };
  /**
   * UNA OPERACIÓN A LA VEZ
   * ----------------------
   * Si ya hay un panel, una hoja o un diálogo abierto, el «+» no apila otra capa
   * encima: primero se termina —o se cierra— lo que se estaba haciendo. Antes se
   * podía acabar con el menú encima del formulario a medio rellenar.
   */
  const abrirAcciones = () => {
    if (quickOpen || drawerOpen || entitySheetOpen || confirmLogout) {
      return;
    }
    setQuickKind(null);
    setQuickOpen(true);
  };

  const cerrarAcciones = () => {
    setQuickOpen(false);
    setQuickKind(null);
  };

  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  const selectedEntityId = new URLSearchParams(location.search).get('entityId') ?? '';
  const activeEntity = entities.find((entity) => entity.id === selectedEntityId) ?? null;

  const tasksQuery = useQuery<PendingTasks>({
    queryKey: ['pending-tasks'],
    queryFn: () => api.get<PendingTasks>('/notifications/tasks'),
    enabled: Boolean(user) && isOnline,
    refetchInterval: 120_000,
  });

  useEffect(() => {
    const refreshLocal = async () => {
      setPendingLocal(await countPendingOperations());
      setPendingShopping(await countShoppingPending());
    };
    void refreshLocal();
    const interval = setInterval(refreshLocal, 5_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Al recuperar la conexión se envían los pendientes: movimientos y listas.
  useEffect(() => {
    if (!isOnline || (pendingLocal === 0 && pendingShopping === 0) || syncing) {
      return;
    }
    const run = async () => {
      setSyncing(true);
      const shopping = pendingShopping > 0 ? await flushShoppingQueue() : { sent: 0, pending: 0 };
      const result = await syncPendingOperations();
      setSyncing(false);
      setPendingLocal(result.pendingAfter);
      setPendingShopping(shopping.pending);

      if (result.applied + result.duplicates > 0) {
        toast.success(`${result.applied + result.duplicates} operación(es) confirmadas por el servidor.`);
        await queryClient.invalidateQueries();
      }
      if (shopping.sent > 0) {
        toast.success(`${shopping.sent} lista(s) de compras enviadas.`);
        await queryClient.invalidateQueries({ queryKey: ['shopping'] });
      }
      if (result.conflicts + result.rejected > 0) {
        toast.warning(
          `${result.conflicts + result.rejected} operación(es) necesitan su revisión.`,
          'Ábralas en «Sincronización», dentro del menú.',
        );
      }
    };
    void run();
  }, [isOnline, pendingLocal, pendingShopping, syncing, queryClient]);

  const setEntity = (entityId: string) => {
    const params = new URLSearchParams(location.search);
    if (entityId) {
      params.set('entityId', entityId);
    } else {
      params.delete('entityId');
    }
    const query = params.toString();
    void navigate(`${location.pathname}${query ? `?${query}` : ''}`);
  };

  const mandatory = tasksQuery.data?.mandatoryCount ?? 0;
  const pendingTotal = pendingLocal + pendingShopping;

  // «Sin conexión» significa una cosa muy concreta: **no se puede hablar con el
  // servidor**. Da igual que sea porque el teléfono no tiene datos o porque el
  // servidor esté de mantenimiento: en los dos casos lo que se ve son las
  // últimas cifras conocidas y hay que decirlo. Mirar sólo `navigator.onLine`
  // dejaba la aplicación diciendo «Al día» con el servidor caído.
  const serverUnreachable = !isOnline || sessionState === 'offline';

  // Lo que anuncia el indicador de la cabecera. Se juntan los dos datos cuando
  // hacen falta a la vez: estar sin conexión y tener operaciones sin confirmar
  // son cosas distintas, y quien no ve la pantalla necesita saber las dos.
  const statusLabel = [
    serverUnreachable ? 'Sin conexión' : null,
    pendingTotal > 0 ? `${pendingTotal} operación(es) sin confirmar` : null,
  ]
    .filter(Boolean)
    .concat('comprobar el estado y actualizar')
    .join(' · ');

  const offlineHoursLeft = offlineAllowedUntil
    ? (new Date(offlineAllowedUntil).getTime() - Date.now()) / 3_600_000
    : null;
  const offlineExpiringSoon = offlineHoursLeft !== null && offlineHoursLeft > 0 && offlineHoursLeft < 4;
  const offlineExpired = offlineHoursLeft !== null && offlineHoursLeft <= 0;

  const entityOptions = useMemo(
    () => [
      { id: '', name: 'Todas las unidades' },
      ...entities.map((entity) => ({ id: entity.id, name: entity.name })),
    ],
    [entities],
  );

  const isActiveRoute = (to: string) => {
    const path = to.split('?')[0];
    if (path === '/') {
      return location.pathname === '/';
    }
    return location.pathname === path || location.pathname.startsWith(`${path}/`);
  };

  return (
    <div
      className="mx-auto flex h-[100dvh] w-full max-w-3xl flex-col overflow-hidden"
      onTouchStart={(event) => empezarGesto(event, true)}
      onTouchEnd={terminarGesto}
    >
      {/* CABECERA: baja, con lo que se usa a diario */}
      <header className="z-30 shrink-0 border-b border-border-soft bg-bg/95 backdrop-blur-md">
        <div className="flex items-center gap-1 px-2 pb-1.5 pt-[calc(var(--safe-top)+0.35rem)]">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Abrir el menú"
            aria-expanded={drawerOpen}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink transition hover:bg-surface-2"
          >
            <IconMenu size={22} />
          </button>

          <div className="min-w-0 flex-1">
            <Link to="/" className="block leading-tight">
              <span className="text-[0.95rem] font-bold tracking-tight text-ink">FINANZA</span>
            </Link>
            <button
              type="button"
              onClick={() => setEntitySheetOpen(true)}
              className="flex max-w-full items-center gap-1 text-xs font-medium text-muted"
            >
              <IconBuilding size={13} className="shrink-0" />
              <span className="truncate">{activeEntity ? activeEntity.name : 'Todas las unidades'}</span>
              <span className="text-faint">▾</span>
            </button>
          </div>

          {/* Estado de sincronización: un indicador con acción */}
          <button
            type="button"
            onClick={() => void reload()}
            aria-label={statusLabel}
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-muted transition hover:bg-surface-2 hover:text-ink"
          >
            {serverUnreachable ? (
              <>
                <IconWifiOff size={16} className="text-warning" />
                <span className="hidden min-[340px]:inline text-warning">Sin conexión</span>
              </>
            ) : syncing ? (
              <>
                <IconRefresh size={16} className="animate-spin" />
                <span className="hidden min-[340px]:inline">Enviando</span>
              </>
            ) : pendingTotal > 0 ? (
              <>
                <IconAlert size={16} className="text-warning" />
                <span className="text-warning">{pendingTotal}</span>
              </>
            ) : sessionState === 'starting' ? (
              <IconRefresh size={16} className="animate-spin" />
            ) : (
              <>
                <IconCheck size={16} className="text-positive" />
                <span className="hidden min-[340px]:inline">Al día</span>
              </>
            )}
          </button>
        </div>
      </header>

      {serverUnreachable ? (
        <div className="shrink-0 px-4 pt-3">
          <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs leading-snug text-ink">
            {isOnline ? (
              <>
                <strong>No se puede contactar con el servidor.</strong> Lo que ve son las últimas cifras conocidas, y lo
                que registre quedará <strong>sin confirmar</strong> hasta que el servidor lo valide.
              </>
            ) : (
              <>
                Está trabajando <strong>sin conexión</strong>. Lo que registre se guarda en este dispositivo y queda
                <strong> sin confirmar</strong> hasta que el servidor lo valide. Los saldos que ve son los últimos
                conocidos.
              </>
            )}
            {offlineHoursLeft !== null && offlineHoursLeft > 0 ? (
              <span className="mt-1 block">Puede seguir registrando durante {Math.floor(offlineHoursLeft)} hora(s) más.</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {offlineExpiringSoon && isOnline ? (
        <div className="shrink-0 px-4 pt-3">
          <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs leading-snug text-ink">
            Su autorización para trabajar sin conexión vence en menos de 4 horas. Conéctese un momento para renovarla.
          </div>
        </div>
      ) : null}

      {offlineExpired && sessionState === 'offline' ? (
        <div className="shrink-0 px-4 pt-3">
          <div className="rounded-xl border border-negative/40 bg-negative/10 p-3 text-xs leading-snug text-ink">
            La autorización para trabajar sin conexión ha caducado. Conéctese a internet para validar su sesión antes de
            seguir registrando movimientos.
          </div>
        </div>
      ) : null}

      {hayVersionNueva ? (
        <div className="shrink-0 px-4 pt-3">
          <div className="flex items-center justify-between gap-2 rounded-xl border border-brand/50 bg-brand/10 p-2.5 text-xs leading-snug text-ink">
            <span>
              <strong>Hay una versión nueva de FINANZA.</strong> Actualícela para ver los últimos cambios.
            </span>
            <button
              type="button"
              onClick={() => void aplicarActualizacion()}
              className="shrink-0 rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-white"
            >
              Actualizar
            </button>
          </div>
        </div>
      ) : null}

      <main className="page-bottom-space min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {children}
      </main>

      {/* BARRA INFERIOR: cinco destinos, el central para añadir */}
      <nav
        aria-label="Navegación principal"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border-soft bg-bg/95 pb-[var(--safe-bottom)] backdrop-blur-md"
        style={{ paddingLeft: 'var(--safe-left)', paddingRight: 'var(--safe-right)' }}
      >
        <div className="mx-auto flex max-w-3xl items-stretch justify-between px-1">
          {BOTTOM_NAV.map((entry) => {
            const Icon = entry.icon;

            // El botón central no navega: abre las acciones rápidas.
            if (entry.action === 'quick-add') {
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={abrirAcciones}
                  aria-label="Añadir movimiento"
                  aria-haspopup="dialog"
                  className="flex flex-col items-center justify-center gap-0.5 px-2"
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand text-white shadow-elevated transition active:scale-95">
                    <Icon size={24} />
                  </span>
                  <span className="text-[0.66rem] font-medium text-muted">{entry.label}</span>
                </button>
              );
            }

            const target = entry.to ?? '/';
            const pendingHere = entry.id === 'control' ? mandatory : 0;
            return (
              <NavItem
                key={entry.id}
                to={target}
                label={entry.label}
                active={isActiveRoute(target)}
                search={location.search}
                // El contador se anuncia como parte del nombre del acceso, no
                // como un número suelto delante: quien no ve la pantalla oye
                // «Control, 2 tareas obligatorias», no «2 Control».
                ariaLabel={
                  pendingHere > 0 ? `${entry.label}, ${pendingHere} tarea(s) obligatoria(s)` : undefined
                }
              >
                <span className="relative">
                  <Icon size={21} />
                  {/* «Control» avisa con un número cuando hay tareas obligatorias:
                      el trabajo pendiente tiene que verse sin entrar. */}
                  {pendingHere > 0 ? (
                    <span
                      aria-hidden="true"
                      className="absolute -right-1.5 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-negative px-1 text-[0.6rem] font-bold text-white"
                    >
                      {pendingHere}
                    </span>
                  ) : null}
                </span>
              </NavItem>
            );
          })}
        </div>
      </nav>

      {/* Menú lateral con todo lo demás */}
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        role={user?.role}
        userName={user?.name}
        entityName={activeEntity ? activeEntity.name : 'Todas las unidades'}
        onLogout={() => setConfirmLogout(true)}
        returnFocusTo={menuButtonRef.current}
        instalacion={instalacion}
      />

      {/* Selector de unidad financiera */}
      <Sheet open={entitySheetOpen} onClose={() => setEntitySheetOpen(false)} title="Unidad financiera">
        <div className="space-y-1 pb-2">
          {entityOptions.map((option) => {
            const isActive = selectedEntityId === option.id;
            return (
              <button
                key={option.id || 'all'}
                type="button"
                onClick={() => {
                  setEntitySheetOpen(false);
                  setEntity(option.id);
                }}
                className={`flex w-full touch-target items-center justify-between rounded-xl px-3 py-3 text-left text-sm transition ${
                  isActive ? 'bg-brand-soft text-ink' : 'text-ink hover:bg-surface-2'
                }`}
              >
                <span className="truncate font-medium">{option.name}</span>
                {isActive ? <IconCheck size={18} className="text-brand" /> : null}
              </button>
            );
          })}
        </div>
        <p className="pb-2 text-xs text-faint">
          El consolidado suma todas las unidades sin contar dos veces los traspasos entre ellas.
        </p>
      </Sheet>

      {/* Acciones rápidas del botón central: tarjeta centrada con el fondo
          difuminado. Dos pasos en el mismo panel: elegir, y rellenar. */}
      <Panel
        open={quickOpen}
        onClose={cerrarAcciones}
        onBack={quickKind ? () => setQuickKind(null) : undefined}
        title={quickKind ? TITULO_FORMULARIO[quickKind] : '¿Qué quiere registrar?'}
        subtitle={quickKind ? 'Importe, descripción y cuenta.' : undefined}
      >
        {quickKind ? (
          <MovimientoForm initialKind={quickKind} onSaved={cerrarAcciones} />
        ) : (
          <div className="space-y-4">
            {QUICK_ACTIONS.map((grupo) => (
              <section key={grupo.titulo}>
                <h2 className="px-1 pb-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-faint">
                  {grupo.titulo}
                </h2>
                <div className="divide-y divide-border-soft overflow-hidden rounded-2xl border border-border-soft bg-surface">
                  {grupo.acciones.map((accion) => {
                    const Icon = accion.icon;
                    return (
                      <button
                        key={accion.kind ?? accion.to}
                        type="button"
                        onClick={() => {
                          if (accion.kind) {
                            setQuickKind(accion.kind);
                            return;
                          }
                          cerrarAcciones();
                          void navigate(accion.to!);
                        }}
                        className="flex min-h-[3.5rem] w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-surface-2 active:bg-surface-2"
                      >
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                          <Icon size={20} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-ink">{accion.label}</span>
                          <span className="block truncate text-[0.72rem] leading-snug text-muted">{accion.hint}</span>
                        </span>
                        <IconChevronRight size={18} className="shrink-0 text-faint" />
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </Panel>

      <ConfirmDialog
        open={confirmLogout}
        title="¿Cerrar sesión?"
        confirmLabel="Cerrar sesión"
        message={
          <>
            <p>Se cerrará la sesión en este dispositivo y habrá que volver a identificarse.</p>
            <p className="mt-2">
              Los movimientos y las listas <strong>sin confirmar se conservan</strong> en el teléfono: no se pierde nada.
            </p>
          </>
        }
        onCancel={() => setConfirmLogout(false)}
        onConfirm={async () => {
          setConfirmLogout(false);
          await logout();
        }}
      />

      <ToastHost />
    </div>
  );
}

function NavItem({
  to,
  label,
  active,
  search,
  ariaLabel,
  children,
}: {
  to: string;
  label: string;
  active: boolean;
  search: string;
  ariaLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <NavLink
      to={{ pathname: to, search }}
      aria-current={active ? 'page' : undefined}
      aria-label={ariaLabel}
      className={`flex min-h-[3rem] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-[0.4rem] text-[0.66rem] font-medium transition ${
        active ? 'text-brand' : 'text-faint'
      }`}
    >
      {children}
      {label}
    </NavLink>
  );
}

/** Etiqueta de estado reutilizable (para pantallas que quieran mostrarla). */
export function StatusBadge({ tone, children }: { tone: 'positive' | 'warning' | 'neutral'; children: React.ReactNode }) {
  return <Badge tone={tone}>{children}</Badge>;
}
