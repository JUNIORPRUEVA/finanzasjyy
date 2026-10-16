import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  exportPendingOperations,
  importPendingOperations,
  listQueuedOperations,
  removeQueuedOperation,
  storageEstimate,
  type QueuedOperation,
} from '../lib/db';
import { localSyncStatus, retryOperation, syncPendingOperations } from '../lib/sync';
import { Badge, Button, Card, EmptyState, Notice, SectionTitle, Spinner, Tabs } from '../components/ui';
import { formatBusinessDate, formatDateTime, formatMoney } from '../lib/format';

type TabId = 'tareas' | 'sincronizacion' | 'accesos';

interface TasksResponse {
  tasks: Array<{
    id: string;
    type: string;
    title: string;
    detail: string;
    severity: string;
    entityName: string | null;
    amount: string | null;
    dueDate: string | null;
    actionUrl: string;
    isMandatory: boolean;
  }>;
  mandatoryCount: number;
  level: string;
}

interface SyncIssue {
  id: string;
  clientOperationId: string;
  operationType: string;
  status: string;
  receivedAt: string;
  attempts: number;
  errorMessage: string | null;
  recommendation: string;
}

/**
 * «MÁS»: TAREAS, SINCRONIZACIÓN Y ACCESOS
 * ---------------------------------------
 * Reúne lo que el usuario necesita para mantener la disciplina:
 *  · TAREAS pendientes (calculadas con datos reales).
 *  · SINCRONIZACIÓN: qué falta por confirmar, qué fue rechazado y por qué.
 *  · ACCESOS al resto de pantallas.
 */
export function MorePage() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const initialTab = (params.get('tab') as TabId | null) ?? 'tareas';
  const [tab, setTab] = useState<TabId>(initialTab);
  const [queued, setQueued] = useState<QueuedOperation[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ tone: 'positive' | 'warning' | 'negative'; text: string } | null>(null);
  const [storage, setStorage] = useState<{ usageMb: number; quotaMb: number } | null>(null);

  const tasksQuery = useQuery<TasksResponse>({
    queryKey: ['pending-tasks'],
    queryFn: () => api.get<TasksResponse>('/notifications/tasks'),
    enabled: navigator.onLine,
  });

  const issuesQuery = useQuery<SyncIssue[]>({
    queryKey: ['sync-issues'],
    queryFn: () => api.get<SyncIssue[]>('/sync/issues'),
    enabled: navigator.onLine && tab === 'sincronizacion',
  });

  const localStatusQuery = useQuery({
    queryKey: ['local-sync-status'],
    queryFn: localSyncStatus,
  });

  const refreshQueue = async () => {
    setQueued(await listQueuedOperations());
    setStorage(await storageEstimate());
  };

  useEffect(() => {
    void refreshQueue();
    const interval = setInterval(refreshQueue, 5_000);
    return () => clearInterval(interval);
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    const result = await syncPendingOperations();
    setSyncing(false);
    await refreshQueue();
    void queryClient.invalidateQueries();
    setMessage({
      tone: result.failed + result.conflicts + result.rejected > 0 ? 'warning' : 'positive',
      text:
        `Enviadas: ${result.applied} · ya existían: ${result.duplicates} · rechazadas: ${result.rejected} · ` +
        `conflictos: ${result.conflicts} · errores técnicos: ${result.failed}`,
    });
  };

  const handleExport = async () => {
    const json = await exportPendingOperations();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `finanza-pendientes-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage({ tone: 'positive', text: 'Se descargó la copia de los movimientos pendientes.' });
  };

  const handleImport = async (file: File) => {
    try {
      const imported = await importPendingOperations(await file.text());
      await refreshQueue();
      setMessage({ tone: 'positive', text: `Se recuperaron ${imported} operación(es) pendiente(s).` });
    } catch (error) {
      setMessage({ tone: 'negative', text: error instanceof Error ? error.message : 'No se pudo importar el archivo.' });
    }
  };

  return (
    <div className="space-y-4">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <Tabs
        tabs={[
          { id: 'tareas' as TabId, label: 'Tareas' },
          { id: 'sincronizacion' as TabId, label: 'Sincronización' },
          { id: 'accesos' as TabId, label: 'Accesos' },
        ]}
        active={tab}
        onChange={(next) => {
          setTab(next);
          setParams({ tab: next });
        }}
      />

      {tab === 'tareas' ? (
        <Card>
          <SectionTitle
            title="Tareas financieras pendientes"
            hint="Sólo aparecen tareas con datos reales: un día sin movimientos no genera tarea"
            right={tasksQuery.data ? <Badge tone={tasksQuery.data.level === 'RED' ? 'critical' : tasksQuery.data.level === 'YELLOW' ? 'warning' : 'positive'}>{tasksQuery.data.level}</Badge> : null}
          />

          {tasksQuery.isLoading ? <Spinner /> : null}

          {!navigator.onLine ? (
            <Notice tone="warning">Las tareas se calculan en el servidor: conéctese para actualizarlas.</Notice>
          ) : null}

          {tasksQuery.data?.tasks.length === 0 ? (
            <EmptyState title="No hay tareas pendientes" hint="Cierres al día y sin diferencias por explicar." />
          ) : null}

          <div className="space-y-2">
            {tasksQuery.data?.tasks.map((task) => (
              <Link
                key={task.id}
                to={task.actionUrl}
                className="block rounded-lg border border-slate-800 p-3 transition hover:border-slate-600"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-200">{task.title}</p>
                    <p className="truncate text-xs text-slate-500">
                      {task.detail}
                      {task.entityName ? ` · ${task.entityName}` : ''}
                      {task.dueDate ? ` · vence ${formatBusinessDate(task.dueDate)}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    {task.amount ? <p className="money text-sm text-slate-200">{formatMoney(task.amount)}</p> : null}
                    <Badge tone={task.severity === 'CRITICAL' ? 'critical' : task.severity === 'WARNING' ? 'warning' : 'neutral'}>
                      {task.isMandatory ? 'obligatoria' : 'revisar'}
                    </Badge>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      ) : null}

      {tab === 'sincronizacion' ? (
        <>
          <Card>
            <SectionTitle title="Estado de sincronización" />
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs uppercase text-slate-400">Pendientes en este dispositivo</p>
                <p className="text-lg font-semibold text-slate-100">{localStatusQuery.data?.pending ?? 0}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-slate-400">Última confirmación</p>
                <p className="text-sm text-slate-200">
                  {localStatusQuery.data?.lastSyncedAt ? formatDateTime(localStatusQuery.data.lastSyncedAt) : '—'}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase text-slate-400">Ventana sin conexión hasta</p>
                <p className="text-sm text-slate-200">
                  {localStatusQuery.data?.offlineAllowedUntil
                    ? formatDateTime(localStatusQuery.data.offlineAllowedUntil)
                    : '—'}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase text-slate-400">Conexión</p>
                <p className="text-sm text-slate-200">{navigator.onLine ? 'En línea' : 'Sin conexión'}</p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button disabled={syncing || !navigator.onLine} onClick={() => void handleSync()}>
                {syncing ? 'Sincronizando…' : 'Sincronizar ahora'}
              </Button>
              <Button variant="secondary" onClick={() => void handleExport()}>
                Exportar pendientes
              </Button>
              <label className="inline-flex cursor-pointer items-center rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-100">
                Importar pendientes
                <input
                  type="file"
                  accept="application/json"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      void handleImport(file);
                    }
                  }}
                />
              </label>
            </div>

            {storage ? (
              <p className="mt-2 text-xs text-slate-500">
                Almacenamiento local usado: {storage.usageMb} MB de {storage.quotaMb} MB disponibles.
              </p>
            ) : null}
          </Card>

          <Card>
            <SectionTitle
              title="Operaciones sin confirmar"
              hint="Nada de aquí está en la contabilidad del servidor todavía"
            />
            {queued.length === 0 ? (
              <EmptyState title="No hay operaciones pendientes" hint="Todo lo registrado está confirmado por el servidor." />
            ) : (
              <div className="space-y-2">
                {queued.map((operation) => (
                  <div key={operation.id} className="rounded-lg border border-slate-800 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-slate-200">{operation.summary}</p>
                        <p className="truncate text-xs text-slate-500">
                          {formatDateTime(operation.occurredAt)} · {operation.type}
                          {operation.entityName ? ` · ${operation.entityName}` : ''}
                        </p>
                        {operation.lastError ? (
                          <p className="mt-1 text-xs text-rose-300">{operation.lastError}</p>
                        ) : null}
                      </div>
                      <div className="shrink-0 text-right">
                        {operation.amount ? <p className="money text-sm text-slate-200">{formatMoney(operation.amount)}</p> : null}
                        <Badge
                          tone={
                            operation.status === 'CONFLICT' || operation.status === 'REJECTED'
                              ? 'critical'
                              : operation.status === 'ERROR'
                                ? 'warning'
                                : 'neutral'
                          }
                        >
                          {operation.status}
                        </Badge>
                      </div>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <Button variant="secondary" onClick={() => void retryOperation(operation.id).then(refreshQueue)}>
                        Reintentar
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          void removeQueuedOperation(operation.id).then(async () => {
                            await refreshQueue();
                            setMessage({
                              tone: 'warning',
                              text: 'Operación descartada de este dispositivo. No se envió al servidor: si era real, regístrela otra vez.',
                            });
                          })
                        }
                      >
                        Descartar
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {issuesQuery.data && issuesQuery.data.length > 0 ? (
            <Card>
              <SectionTitle title="Operaciones que el servidor rechazó" hint="Requieren su decisión" />
              <div className="space-y-2">
                {issuesQuery.data.map((issue) => (
                  <div key={issue.id} className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-3">
                    <p className="text-sm font-medium text-rose-100">{issue.operationType} · {issue.status}</p>
                    <p className="text-xs text-rose-200">{issue.errorMessage}</p>
                    <p className="mt-1 text-xs text-slate-400">{issue.recommendation}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {formatDateTime(issue.receivedAt)} · intentos: {issue.attempts} · id: {issue.clientOperationId}
                    </p>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </>
      ) : null}

      {tab === 'accesos' ? (
        <>
          <Card>
            <SectionTitle title="Poner orden" hint="Lo que hace que las cuentas cuadren" />
            <div className="grid grid-cols-2 gap-2">
              {[
                { to: '/organizar', label: 'Organizar mi dinero', hint: 'Cuánto hay y de quién es' },
                { to: '/control', label: 'Mi control diario', hint: 'Tareas, semáforo y constancia' },
                { to: '/traspasos', label: 'Traspasos', hint: 'Mover dinero entre cuentas y negocios' },
                { to: '/cierres', label: 'Cierre del día', hint: 'Asistente guiado' },
              ].map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className="rounded-lg border border-slate-800 p-3 transition hover:border-slate-600"
                >
                  <p className="text-sm font-medium text-slate-200">{item.label}</p>
                  <p className="text-xs text-slate-500">{item.hint}</p>
                </Link>
              ))}
            </div>
          </Card>

          <Card>
            <SectionTitle title="Deudas y compromisos" hint="Lo que se paga cada mes y lo que está pendiente" />
            <div className="grid grid-cols-2 gap-2">
              {[
                { to: '/deudas', label: 'Préstamos y deudas', hint: 'Cuotas, tarjetas e intereses' },
                { to: '/obligaciones', label: 'Obligaciones', hint: 'Por cobrar, por pagar y recurrentes' },
                { to: '/presupuestos', label: 'Presupuestos', hint: 'Límites por categoría' },
                { to: '/adjuntos', label: 'Documentos', hint: 'Facturas y comprobantes' },
              ].map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className="rounded-lg border border-slate-800 p-3 transition hover:border-slate-600"
                >
                  <p className="text-sm font-medium text-slate-200">{item.label}</p>
                  <p className="text-xs text-slate-500">{item.hint}</p>
                </Link>
              ))}
            </div>
          </Card>

          <Card>
            <SectionTitle title="Todo lo demás" />
            <div className="grid grid-cols-2 gap-2">
              {[
                { to: '/cuentas', label: 'Cuentas', hint: 'Dónde está el dinero' },
                { to: '/movimientos', label: 'Movimientos', hint: 'Historial y anulaciones' },
                { to: '/unidades', label: 'Unidades financieras', hint: 'Negocios e ingresos futuros' },
                { to: '/informes', label: 'Informes', hint: 'Y exportación CSV' },
                { to: '/ajustes', label: 'Ajustes', hint: 'Preferencias y seguridad' },
              ].map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className="rounded-lg border border-slate-800 p-3 transition hover:border-slate-600"
                >
                  <p className="text-sm font-medium text-slate-200">{item.label}</p>
                  <p className="text-xs text-slate-500">{item.hint}</p>
                </Link>
              ))}
            </div>
          </Card>
        </>
      ) : null}

      <p className="pb-4 text-center text-xs text-slate-600">
        FINANZA · {queued.length} operación(es) locales en este dispositivo
      </p>
    </div>
  );
}
