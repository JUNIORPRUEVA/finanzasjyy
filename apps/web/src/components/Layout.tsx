import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { countPendingOperations } from '../lib/db';
import { localSyncStatus, syncPendingOperations } from '../lib/sync';
import { useAuth } from '../store/auth';
import { Badge, Button } from './ui';

interface PendingTasks {
  tasks: Array<{ id: string; title: string; severity: string; isMandatory: boolean }>;
  mandatoryCount: number;
  level: string;
}

const NAV_ITEMS = [
  { to: '/', label: 'Panel', icon: '📊' },
  { to: '/registrar', label: 'Registrar', icon: '➕' },
  { to: '/control', label: 'Control', icon: '🎯' },
  { to: '/cierres', label: 'Cierre', icon: '✅' },
  { to: '/mas', label: 'Más', icon: '⋯' },
];

/**
 * ESTRUCTURA DE LA APLICACIÓN
 * ---------------------------
 * · Barra superior: unidad financiera activa, estado de conexión/sincronización
 *   y alerta de tareas pendientes (siempre visible, sin abrir menús).
 * · Navegación inferior pensada para el móvil con una sola mano.
 * · El aviso de "sin conexión" aparece SIEMPRE que se navega offline, para que
 *   nadie confunda datos locales con datos conciliados.
 */
export function Layout({ children }: { children: React.ReactNode }) {
  const { user, entities, logout, offlineAllowedUntil } = useAuth();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingLocal, setPendingLocal] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const selectedEntityId = new URLSearchParams(location.search).get('entityId') ?? '';

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
        setSyncMessage(`${result.applied + result.duplicates} operación(es) confirmadas por el servidor.`);
        await queryClient.invalidateQueries();
      }
      if (result.conflicts + result.rejected > 0) {
        setSyncMessage(
          `${result.conflicts + result.rejected} operación(es) necesitan su revisión. Ábralas en "Más → Sincronización".`,
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

  const entityOptions = entities.map((entity) => ({ id: entity.id, name: entity.name }));
  const activeEntity = entityOptions.find((entity) => entity.id === selectedEntityId);

  const setEntity = (entityId: string) => {
    const params = new URLSearchParams(location.search);
    if (entityId) {
      params.set('entityId', entityId);
    } else {
      params.delete('entityId');
    }
    window.location.href = `${location.pathname}?${params.toString()}`;
  };

  const mandatory = tasksQuery.data?.mandatoryCount ?? 0;

  /**
   * Autorización para trabajar sin conexión.
   * Si se acerca su expiración se avisa con antelación: si caduca, la aplicación
   * bloqueará nuevos registros hasta validar la sesión, y el usuario debe saberlo
   * ANTES de quedarse sin cobertura.
   */
  const offlineHoursLeft = offlineAllowedUntil
    ? (new Date(offlineAllowedUntil).getTime() - Date.now()) / 3_600_000
    : null;
  const offlineExpiringSoon = offlineHoursLeft !== null && offlineHoursLeft > 0 && offlineHoursLeft < 4;
  const offlineExpired = offlineHoursLeft !== null && offlineHoursLeft <= 0;

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col">
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-100">FINANZA</p>
            <p className="truncate text-xs text-slate-400">
              {activeEntity ? activeEntity.name : 'Todas las unidades'}
              {user ? ` · ${user.name}` : ''}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setEntity('')}
              className={`rounded-md px-2 py-1 text-xs ${
                selectedEntityId === '' ? 'bg-slate-700 text-white' : 'bg-slate-900 text-slate-400'
              }`}
              title="Ver todas las unidades financieras"
            >
              Todas
            </button>
            {entityOptions.slice(0, 3).map((entity) => (
              <button
                key={entity.id}
                type="button"
                onClick={() => setEntity(entity.id)}
                className={`max-w-[8rem] truncate rounded-md px-2 py-1 text-xs ${
                  selectedEntityId === entity.id ? 'bg-slate-700 text-white' : 'bg-slate-900 text-slate-400'
                }`}
              >
                {entity.name}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!isOnline ? <Badge tone="warning">Sin conexión · datos locales</Badge> : null}

          {pendingLocal > 0 ? (
            <NavLink to="/mas?tab=sincronizacion">
              <Badge tone="warning">{pendingLocal} sin confirmar</Badge>
            </NavLink>
          ) : isOnline && syncStatusQuery.data?.lastSyncedAt ? (
            <Badge tone="positive">Sincronizado</Badge>
          ) : null}

          {mandatory > 0 ? (
            <NavLink to="/mas?tab=tareas">
              <Badge tone="critical">{mandatory} tarea(s) obligatoria(s)</Badge>
            </NavLink>
          ) : null}

          {offlineExpiringSoon ? (
            <NavLink to="/mas?tab=sincronizacion">
              <Badge tone="warning">
                Trabajo sin conexión: quedan {Math.max(1, Math.floor(offlineHoursLeft ?? 0))} h
              </Badge>
            </NavLink>
          ) : null}

          {offlineExpired ? (
            <NavLink to="/mas?tab=sincronizacion">
              <Badge tone="critical">Autorización offline caducada</Badge>
            </NavLink>
          ) : null}

          {syncing ? <Badge tone="neutral">Enviando…</Badge> : null}
        </div>
      </header>

      {syncMessage ? (
        <div className="px-4 pt-3">
          <div className="rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm text-slate-200">{syncMessage}</div>
        </div>
      ) : null}

      {!isOnline ? (
        <div className="px-4 pt-3">
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100">
            Está trabajando <strong>sin conexión</strong>. Los movimientos que registre se guardan en este dispositivo
            y se marcan como <strong>no confirmados</strong> hasta que el servidor los valide. Los saldos que ve son los
            últimos datos conocidos.
            {offlineHoursLeft !== null && offlineHoursLeft > 0 ? (
              <span className="mt-1 block">
                Puede seguir registrando durante {Math.floor(offlineHoursLeft)} hora(s) más. Después será necesario
                conectarse para confirmar su sesión.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {offlineExpiringSoon && isOnline ? (
        <div className="px-4 pt-3">
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100">
            Su autorización para trabajar sin conexión vence en menos de 4 horas. Conéctese un momento para renovarla
            y no quedarse bloqueado si se va la cobertura.
          </div>
        </div>
      ) : null}

      <main className="flex-1 px-4 py-4 pb-24">{children}</main>

      <nav className="fixed bottom-0 left-0 right-0 z-20 border-t border-slate-800 bg-slate-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-stretch justify-between px-2">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={{ pathname: item.to, search: location.search }}
              className={({ isActive }) =>
                `flex flex-1 flex-col items-center gap-0.5 px-2 py-2 text-xs ${
                  isActive ? 'text-emerald-400' : 'text-slate-400'
                }`
              }
            >
              <span aria-hidden className="text-lg leading-none">
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          ))}
        </div>
      </nav>

      {user ? (
        <div className="hidden">
          <Button variant="ghost" onClick={() => void logout()}>
            Cerrar sesión
          </Button>
        </div>
      ) : null}
    </div>
  );
}
