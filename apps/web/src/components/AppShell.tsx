import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { countPendingOperations } from '../lib/db';
import { localSyncStatus, syncPendingOperations } from '../lib/sync';
import { useAuth } from '../store/auth';
import { Badge, Sheet } from './ui';
import { ToastHost, toast } from './Toast';
import {
  IconAlert,
  IconBuilding,
  IconCheck,
  IconFile,
  IconHome,
  IconList,
  IconPlus,
  IconRefresh,
  IconTarget,
  IconWifiOff,
} from './icons';

/**
 * ESTRUCTURA DE LA APLICACIÓN
 * ===========================
 * · Cabecera compacta: unidad financiera activa, estado de la sesión y avisos.
 * · Barra inferior de 5 accesos con el botón central «Añadir» elevado, que abre
 *   una hoja con las cuatro acciones que se usan a diario.
 * · Avisos de «sin conexión» y de movimientos sin confirmar, siempre visibles.
 * · Todo respeta las áreas seguras del teléfono (notch y barra de gestos).
 */

interface PendingTasks {
  tasks: Array<{ id: string; title: string; severity: string; isMandatory: boolean }>;
  mandatoryCount: number;
  level: string;
}

const NAV_ITEMS = [
  { to: '/', label: 'Inicio', icon: IconHome },
  { to: '/movimientos', label: 'Movimientos', icon: IconList },
  { to: '/control', label: 'Control', icon: IconTarget },
  { to: '/mas', label: 'Más', icon: IconFile },
];

const QUICK_ACTIONS = [
  { to: '/registrar?kind=INCOME', label: 'Ingreso', hint: 'Entra dinero', tone: 'positive' as const },
  { to: '/registrar?kind=EXPENSE', label: 'Gasto', hint: 'Sale dinero', tone: 'negative' as const },
  { to: '/traspasos', label: 'Traspaso', hint: 'Entre cuentas o negocios', tone: 'info' as const },
  { to: '/obligaciones', label: 'Compromiso', hint: 'Cobros, pagos y recurrentes', tone: 'warning' as const },
  { to: '/cierres', label: 'Cierre del día', hint: 'Conciliar y cerrar', tone: 'positive' as const },
  { to: '/deudas', label: 'Deuda o cuota', hint: 'Préstamos y tarjetas', tone: 'negative' as const },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, entities, sessionState, offlineAllowedUntil, reload } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingLocal, setPendingLocal] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [entitySheetOpen, setEntitySheetOpen] = useState(false);

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

  // Al recuperar la conexión, se envían los pendientes automáticamente.
  useEffect(() => {
    if (!isOnline || pendingLocal === 0 || syncing) {
      return;
    }
    const run = async () => {
      setSyncing(true);
      const result = await syncPendingOperations();
      setSyncing(false);
      setPendingLocal(result.pendingAfter);
      if (result.applied + result.duplicates > 0) {
        toast.success(`${result.applied + result.duplicates} operación(es) confirmadas por el servidor.`);
        await queryClient.invalidateQueries();
      }
      if (result.conflicts + result.rejected > 0) {
        toast.warning(
          `${result.conflicts + result.rejected} operación(es) necesitan su revisión.`,
          'Ábralas en «Más → Sincronización».',
        );
      }
    };
    void run();
  }, [isOnline, pendingLocal, syncing, queryClient]);

  useEffect(() => {
    if (!syncMessage) {
      return;
    }
    const timeout = setTimeout(() => setSyncMessage(null), 8_000);
    return () => clearTimeout(timeout);
  }, [syncMessage]);

  const syncStatusQuery = useQuery({
    queryKey: ['local-sync-status'],
    queryFn: localSyncStatus,
    refetchInterval: 15_000,
  });

  const setEntity = (entityId: string) => {
    const params = new URLSearchParams(location.search);
    if (entityId) {
      params.set('entityId', entityId);
    } else {
      params.delete('entityId');
    }
    const query = params.toString();
    // Navegación interna (sin recargar la aplicación): al cambiar de unidad, las
    // consultas se vuelven a pedir porque su clave incluye la unidad elegida.
    void navigate(`${location.pathname}${query ? `?${query}` : ''}`);
  };

  const mandatory = tasksQuery.data?.mandatoryCount ?? 0;

  const offlineHoursLeft = offlineAllowedUntil
    ? (new Date(offlineAllowedUntil).getTime() - Date.now()) / 3_600_000
    : null;
  const offlineExpiringSoon = offlineHoursLeft !== null && offlineHoursLeft > 0 && offlineHoursLeft < 4;
  const offlineExpired = offlineHoursLeft !== null && offlineHoursLeft <= 0;

  const entityOptions = useMemo(
    () => [{ id: '', name: 'Todas las unidades' }, ...entities.map((entity) => ({ id: entity.id, name: entity.name }))],
    [entities],
  );

  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col">
      <header className="sticky top-0 z-30 border-b border-border-soft bg-bg/95 pt-[var(--safe-top)] backdrop-blur-md">
        <div className="flex items-center gap-2 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-[0.7rem] font-medium uppercase tracking-wider text-faint">FINANZA</p>
            <button
              type="button"
              onClick={() => setEntitySheetOpen(true)}
              className="flex max-w-full items-center gap-1 text-sm font-semibold text-ink"
            >
              <IconBuilding size={15} className="shrink-0 text-muted" />
              <span className="truncate">{activeEntity ? activeEntity.name : 'Todas las unidades'}</span>
              <span className="text-faint">▾</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => void reload()}
            aria-label="Actualizar estado de la sesión"
            className="flex h-11 w-11 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink"
          >
            <IconRefresh size={18} className={sessionState === 'starting' ? 'animate-spin' : ''} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
          {sessionState === 'offline' || !isOnline ? (
            <Badge tone="warning">
              <IconWifiOff size={13} className="mr-1" />
              Sin conexión · datos locales
            </Badge>
          ) : sessionState === 'starting' ? (
            <Badge tone="neutral">Comprobando sesión…</Badge>
          ) : (
            <Badge tone="positive">
              <IconCheck size={13} className="mr-1" />
              Sesión activa
            </Badge>
          )}

          {pendingLocal > 0 ? (
            <NavLink to="/mas?tab=sincronizacion">
              <Badge tone="warning">{pendingLocal} sin confirmar</Badge>
            </NavLink>
          ) : isOnline && syncStatusQuery.data?.lastSyncedAt ? (
            <Badge tone="neutral">
              <IconCheck size={13} className="mr-1" />
              Sincronizado
            </Badge>
          ) : null}

          {mandatory > 0 ? (
            <NavLink to="/control">
              <Badge tone="critical">
                <IconAlert size={13} className="mr-1" />
                {mandatory} pendiente(s)
              </Badge>
            </NavLink>
          ) : null}

          {syncing ? <Badge tone="info">Enviando…</Badge> : null}
        </div>
      </header>

      {syncMessage ? (
        <div className="px-4 pt-3">
          <div className="rounded-xl border border-border-soft bg-surface p-3 text-sm text-ink">{syncMessage}</div>
        </div>
      ) : null}

      {!isOnline ? (
        <div className="px-4 pt-3">
          <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs leading-snug text-ink">
            Está trabajando <strong>sin conexión</strong>. Lo que registre se guarda en este dispositivo y queda
            <strong> sin confirmar</strong> hasta que el servidor lo valide. Los saldos que ve son los últimos conocidos.
            {offlineHoursLeft !== null && offlineHoursLeft > 0 ? (
              <span className="mt-1 block">Puede seguir registrando durante {Math.floor(offlineHoursLeft)} hora(s) más.</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {offlineExpiringSoon && isOnline ? (
        <div className="px-4 pt-3">
          <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs leading-snug text-ink">
            Su autorización para trabajar sin conexión vence en menos de 4 horas. Conéctese un momento para renovarla.
          </div>
        </div>
      ) : null}

      {offlineExpired && sessionState === 'offline' ? (
        <div className="px-4 pt-3">
          <div className="rounded-xl border border-negative/40 bg-negative/10 p-3 text-xs leading-snug text-ink">
            La autorización para trabajar sin conexión ha caducado. Conéctese a internet para validar su sesión antes de
            seguir registrando movimientos.
          </div>
        </div>
      ) : null}

      <main className="page-bottom-space flex-1 px-4 py-4">{children}</main>

      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border-soft bg-bg/95 pb-[var(--safe-bottom)] backdrop-blur-md"
        style={{ paddingLeft: 'var(--safe-left)', paddingRight: 'var(--safe-right)' }}
      >
        <div className="mx-auto flex max-w-3xl items-stretch justify-between px-1">
          {NAV_ITEMS.slice(0, 2).map((item) => (
            <NavItem key={item.to} to={item.to} label={item.label} icon={item.icon} search={location.search} />
          ))}

          <button
            type="button"
            onClick={() => setQuickOpen(true)}
            aria-label="Añadir movimiento"
            className="-mt-5 flex flex-col items-center gap-0.5 px-2"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-brand text-white shadow-elevated transition active:scale-95">
              <IconPlus size={26} />
            </span>
            <span className="text-[0.68rem] font-medium text-muted">Añadir</span>
          </button>

          {NAV_ITEMS.slice(2).map((item) => (
            <NavItem key={item.to} to={item.to} label={item.label} icon={item.icon} search={location.search} />
          ))}
        </div>
      </nav>

      {/* Selector de unidad financiera: hoja inferior, cómoda con una mano. */}
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

      {/* Acciones rápidas del botón central. */}
      <Sheet open={quickOpen} onClose={() => setQuickOpen(false)} title="¿Qué quiere registrar?">
        <div className="grid grid-cols-2 gap-2 pb-3">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.to}
              type="button"
              onClick={() => {
                setQuickOpen(false);
                void navigate(action.to);
              }}
              className="flex flex-col items-start gap-0.5 rounded-xl border border-border-soft bg-surface p-3 text-left transition active:bg-surface-2"
            >
              <span className="text-sm font-semibold text-ink">{action.label}</span>
              <span className="text-[0.7rem] leading-snug text-muted">{action.hint}</span>
            </button>
          ))}
        </div>
      </Sheet>

      <ToastHost />
    </div>
  );
}

function NavItem({
  to,
  label,
  icon: IconComponent,
  search,
}: {
  to: string;
  label: string;
  icon: (props: { size?: number }) => React.ReactElement;
  search: string;
}) {
  return (
    <NavLink
      to={{ pathname: to, search }}
      className={({ isActive }) =>
        `flex flex-1 flex-col items-center gap-0.5 px-1.5 py-2 text-[0.68rem] font-medium transition ${
          isActive ? 'text-brand' : 'text-faint'
        }`
      }
    >
      <IconComponent size={22} />
      {label}
    </NavLink>
  );
}

