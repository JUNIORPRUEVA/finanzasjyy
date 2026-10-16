import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Badge, Card, EmptyState, Notice, SectionTitle, Spinner } from '../components/ui';
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
    metrics: Record<string, number | string>;
  }>;
  disciplineLevel: string;
}

const LEVEL_STYLE = {
  GREEN: { tone: 'positive' as const, label: 'VERDE · todo al día' },
  YELLOW: { tone: 'warning' as const, label: 'AMARILLO · hay tareas pendientes' },
  RED: { tone: 'critical' as const, label: 'ROJO · requiere su atención hoy' },
};

const SEVERITY_TONE = {
  CRITICAL: 'critical' as const,
  WARNING: 'warning' as const,
  INFO: 'neutral' as const,
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

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle
          title="Mi control diario"
          hint={`Situación al ${data.businessDate}`}
          right={<Badge tone={style.tone}>{style.label}</Badge>}
        />
        <p className="text-sm text-ink">{data.headline}</p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <Badge tone="critical">{data.counts.critical} urgente(s)</Badge>
          <Badge tone="warning">{data.counts.warning} pendiente(s)</Badge>
          <Badge tone="neutral">{data.counts.total} tarea(s) en total</Badge>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Card>
          <p className="text-xs uppercase text-muted">Días seguidos cerrando</p>
          <p className="text-2xl font-semibold text-positive">{data.streaks.consecutiveClosedDays}</p>
          <p className="mt-1 text-xs text-faint">Cerrar el día es lo que confirma que el saldo cuadra.</p>
        </Card>
        <Card>
          <p className="text-xs uppercase text-muted">Cumplimiento</p>
          <p className="text-sm text-ink">
            Semana: <span className="font-semibold">{data.streaks.week.compliancePct}%</span>
          </p>
          <p className="text-sm text-ink">
            Mes: <span className="font-semibold">{data.streaks.month.compliancePct}%</span>
          </p>
          <p className="mt-1 text-xs text-faint">
            {data.streaks.week.daysClosed}/{data.streaks.week.daysWithActivity} días con actividad esta semana.
          </p>
        </Card>
      </div>

      <Card>
        <SectionTitle title="Tareas" hint="Cada una indica qué pasa y a dónde ir para resolverlo" />
        {data.tasks.length === 0 ? (
          <EmptyState title="No hay nada pendiente" hint="Todas las cuentas están conciliadas y sin vencimientos próximos." />
        ) : (
          <div className="space-y-2">
            {data.tasks.map((task) => (
              <Link
                key={task.id}
                to={task.route}
                className="block rounded-lg border border-border-soft p-3 transition hover:border-border-soft hover:bg-surface-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{task.title}</p>
                    <p className="mt-0.5 text-xs text-muted">{task.detail}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge tone={SEVERITY_TONE[task.severity]}>
                        {task.severity === 'CRITICAL' ? 'Urgente' : task.severity === 'WARNING' ? 'Pendiente' : 'Aviso'}
                      </Badge>
                      {task.entityName ? <Badge tone="neutral">{task.entityName}</Badge> : null}
                      {task.dueDate ? <span className="text-xs text-faint">Vence: {task.dueDate}</span> : null}
                    </div>
                  </div>
                  {task.amount ? (
                    <span className="shrink-0 text-sm text-ink">{formatMoney(task.amount, currency)}</span>
                  ) : null}
                </div>
              </Link>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle title="Unidad por unidad" hint="Mismo criterio de color que en el cierre diario" />
        <div className="space-y-2">
          {data.discipline.map((row) => (
            <div key={row.entityId} className="rounded-lg border border-border-soft p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-ink">{row.entityName}</p>
                <Badge
                  tone={row.level === 'RED' ? 'critical' : row.level === 'YELLOW' ? 'warning' : 'positive'}
                >
                  {row.level}
                </Badge>
              </div>
              {row.reasons.length > 0 ? (
                <ul className="mt-2 list-inside list-disc text-xs text-muted">
                  {row.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-faint">Sin incidencias.</p>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
