import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Badge, Notice, Spinner } from '../components/ui';
import { IconChevronRight } from '../components/icons';
import { formatMoney } from '../lib/format';
import { useAuth } from '../store/auth';

/**
 * MI CONTROL DIARIO
 * -----------------
 * Lo que hay que hacer hoy, con datos reales y sin alarmas inventadas:
 * cierres pendientes, deudas que vencen, cobros, gastos sin clasificar,
 * diferencias de caja, operaciones sin confirmar y presupuestos excedidos.
 *
 * El semáforo NO bloquea nada: ordena y avisa. Nunca impide registrar dinero.
 */

interface DailyTask {
  id: string;
  code: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  title: string;
  detail: string;
  route: string;
  entityId: string | null;
  entityName: string | null;
  amount: string | null;
  dueDate: string | null;
  daysOffset: number | null;
}

interface DailyControl {
  generatedAt: string;
  businessDate: string;
  level: 'GREEN' | 'YELLOW' | 'RED';
  headline: string;
  counts: { critical: number; warning: number; info: number; total: number };
  tasks: DailyTask[];
  streaks: {
    consecutiveClosedDays: number;
    closedDaysLast30: number;
    week: { daysWithActivity: number; daysClosed: number; compliancePct: string };
    month: { daysWithActivity: number; daysClosed: number; compliancePct: string };
  };
  discipline: Array<{
    entityId: string;
    entityName: string;
    level: string;
    reasons: string[];
    checks?: Array<{ name: string; ok: boolean; detail: string }>;
    metrics: Record<string, number | string>;
  }>;
  disciplineLevel: string;
}

const LEVEL_STYLE = {
  GREEN: { tone: 'positive' as const, label: 'Al día' },
  YELLOW: { tone: 'warning' as const, label: 'Pendiente' },
  RED: { tone: 'critical' as const, label: 'Urgente' },
};

export function DailyControlPage() {
  const { preferences } = useAuth();
  const currency = preferences?.currency ?? 'DOP';

  const controlQuery = useQuery<DailyControl>({
    queryKey: ['daily-control'],
    queryFn: () => api.get<DailyControl>('/daily-control'),
    refetchInterval: 60_000,
  });

  if (controlQuery.isLoading) {
    return <Spinner label="Revisando sus cuentas…" />;
  }

  if (controlQuery.isError || !controlQuery.data) {
    return (
      <Notice tone="warning" title="No se pudo calcular el control diario">
        Este cálculo necesita conexión con el servidor porque se hace sobre los datos confirmados. Vuelva a intentarlo
        cuando tenga conexión.
      </Notice>
    );
  }

  const data = controlQuery.data;
  const style = LEVEL_STYLE[data.level];
  const primera = data.tasks[0];

  return (
    <div className="space-y-3">
      {/* QUÉ ES Y CÓMO ESTÁ EL DÍA, EN TRES LÍNEAS. */}
      <div className="border border-border-soft bg-surface p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-ink">Control del día</h1>
            <p className="mt-0.5 text-[0.68rem] text-faint">Qué falta para cerrar bien el día ({data.businessDate}).</p>
          </div>
          <Badge tone={style.tone}>{style.label}</Badge>
        </div>

        <p className="mt-2 text-sm leading-snug text-ink">
          {data.counts.total === 0
            ? 'No hay nada pendiente.'
            : `${data.counts.total} tarea(s) por resolver · ${data.counts.critical} urgente(s) · ${data.counts.warning} pendiente(s).`}
        </p>
        {primera ? (
          <Link to={primera.route} className="mt-1 inline-flex text-xs font-medium text-brand">
            Empezar por: {primera.title} →
          </Link>
        ) : null}
      </div>

      {/* DOS DATOS, EN PEQUEÑO: racha y cumplimiento. */}
      <div className="grid grid-cols-2 gap-2">
        <div className="border border-border-soft bg-surface p-3">
          <p className="text-[0.62rem] uppercase tracking-wide text-faint">Días seguidos</p>
          <p className="mt-0.5 text-2xl font-semibold leading-none text-positive">
            {data.streaks.consecutiveClosedDays}
          </p>
          <p className="mt-1 text-[0.68rem] text-muted">cerrando el día</p>
        </div>
        <div className="border border-border-soft bg-surface p-3">
          <p className="text-[0.62rem] uppercase tracking-wide text-faint">Cumplimiento</p>
          <p className="mt-1 text-sm text-ink">
            Semana <strong>{data.streaks.week.compliancePct}%</strong>
          </p>
          <p className="text-sm text-ink">
            Mes <strong>{data.streaks.month.compliancePct}%</strong>
          </p>
          <p className="mt-1 text-[0.68rem] text-muted">
            {data.streaks.week.daysClosed}/{data.streaks.week.daysWithActivity} días esta semana
          </p>
        </div>
      </div>
      <p className="px-1 text-[0.68rem] leading-snug text-faint">
        Cerrar el día confirma que el saldo de sus cuentas cuadra con lo contado.
      </p>

      {/* TAREAS: lista plana, una fila por tarea y enlace directo. */}
      <section className="border border-border-soft bg-surface">
        <div className="flex items-center justify-between px-3 py-2">
          <h2 className="text-sm font-semibold text-ink">Tareas</h2>
          <span className="text-[0.68rem] text-faint">{data.tasks.length}</span>
        </div>
        {data.tasks.length === 0 ? (
          <p className="border-t border-border-soft px-3 py-3 text-xs text-muted">No hay nada pendiente.</p>
        ) : (
          <div className="divide-y divide-border-soft border-t border-border-soft">
            {data.tasks.map((task) => (
              <Link
                key={task.id}
                to={task.route}
                className="flex items-start gap-2 px-3 py-2.5 transition hover:bg-surface-2"
              >
                <span
                  aria-hidden="true"
                  className={`mt-1.5 h-2 w-2 shrink-0 ${
                    task.severity === 'CRITICAL'
                      ? 'bg-negative'
                      : task.severity === 'WARNING'
                        ? 'bg-warning'
                        : 'bg-faint'
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium leading-snug text-ink">
                    {task.title}
                    {task.entityName ? <span className="font-normal text-muted"> · {task.entityName}</span> : null}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[0.7rem] leading-snug text-muted">{task.detail}</span>
                  {task.dueDate || task.amount ? (
                    <span className="mt-1 block text-[0.65rem] text-faint">
                      {task.dueDate ? `Vence ${task.dueDate}` : ''}
                      {task.dueDate && task.amount ? ' · ' : ''}
                      {task.amount ? formatMoney(task.amount, currency) : ''}
                    </span>
                  ) : null}
                </span>
                <IconChevronRight size={16} className="mt-1 shrink-0 text-faint" />
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* UNIDAD POR UNIDAD: filas finas, sin cajas dentro de cajas. */}
      <section className="border border-border-soft bg-surface">
        <h2 className="px-3 py-2 text-sm font-semibold text-ink">Unidad por unidad</h2>
        <div className="divide-y divide-border-soft border-t border-border-soft">
          {data.discipline.map((row) => (
            <div key={row.entityId} className="flex items-start justify-between gap-2 px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">{row.entityName}</p>
                <p className="mt-0.5 text-[0.68rem] leading-snug text-muted">
                  {row.reasons.length > 0
                    ? row.reasons.join(' · ')
                    : (row.checks?.find((check) => check.name === 'Cierres al día')?.detail ?? 'Sin incidencias.')}
                </p>
              </div>
              <Badge tone={row.level === 'RED' ? 'critical' : row.level === 'YELLOW' ? 'warning' : 'positive'}>
                {row.level === 'RED' ? 'Urgente' : row.level === 'YELLOW' ? 'Pendiente' : 'Al día'}
              </Badge>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
