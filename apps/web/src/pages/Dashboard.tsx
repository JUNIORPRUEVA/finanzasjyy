import { Suspense, lazy, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../store/auth';
import {
  AmountDisplay,
  Badge,
  Button,
  Card,
  EmptyState,
  Kpi,
  Money,
  Notice,
  ProgressBar,
  SectionTitle,
  Skeleton,
  Spinner,
  Tabs,
} from '../components/ui';
import { formatBusinessDate, formatMoney } from '../lib/format';
import { IconArrowDown, IconArrowUp, IconBag, IconChevronRight, IconTarget, IconWifiOff } from '../components/icons';

// Los gráficos se cargan sólo cuando hacen falta (son la parte más pesada).
const DashboardCharts = lazy(() =>
  import('../components/DashboardCharts').then((module) => ({ default: module.DashboardCharts })),
);

type Preset = 'TODAY' | 'YESTERDAY' | 'WEEK' | 'MONTH' | 'LAST_30_DAYS';

interface Summary {
  range: { from: string; to: string; preset: string };
  today: { income: string; expense: string; result: string; movementCount: number };
  period: { income: string; expense: string; result: string; margin: string };
  money: { availableCash: string; inCash: string; inBanks: string; note: string };
  obligations: {
    totalDebt: string;
    loanDebt: string;
    creditCardDebt: string;
    receivables: string;
    upcomingTotal: string;
    upcomingPayments: Array<{ id: string; name: string; amount: string; dueDate: string; daysRemaining: number }>;
  };
  owner: { withdrawalsThisMonth: string; contributionsThisMonth: string; netExtracted: string };
  budget: { limit: string; spent: string; remaining: string; percentUsed: string };
  closings: {
    pendingDays: number;
    today: Array<{ entityId: string; status: string; closed: boolean; difference: string | null }>;
  };
  dataQuality: { isProvisional: boolean; unsyncedOperations: number; pendingClosings: number; message: string };
}

interface Charts {
  range: { from: string; to: string; days: number };
  dailySeries: Array<{ date: string; income: string; expense: string; result: string; movements: number }>;
  expenseByCategory: Array<{ categoryId: string; categoryName: string; amount: string; share: string }>;
  entitiesComparison: Array<{
    entityId: string;
    entityName: string;
    income: string;
    expense: string;
    result: string;
    withdrawals: string;
  }>;
  cashEvolution: {
    totalCash: string;
    totalLiabilities: string;
    accounts: Array<{ accountId: string; name: string; balance: string; isLiability: boolean }>;
    note: string;
  };
  monthlyTrend: Array<{ month: string; income: string; expense: string; result: string }>;
  transfers: { count: number; internalCount: number; total: string; note: string };
}

interface ShoppingSummary {
  openLists: number;
  itemsPending: number;
  pendingTotal: string;
  estimatedTotal: string;
  lists: Array<{ id: string; name: string; status: string; totals: { estimated: string; actual: string; pending: string } }>;
  note: string;
}

/** Estado del asistente «Organizar mi dinero» (por unidad o en conjunto). */
interface SetupStatus {
  needsSetup: boolean;
  pending: string[];
  entities: Array<{ id: string; code: string; name: string; openingBalancePosted: boolean }>;
}

interface PendingTasks {
  tasks: Array<{
    id: string;
    type: string;
    title: string;
    detail: string;
    severity: string;
    isMandatory: boolean;
    amount: string | null;
    actionUrl: string;
  }>;
  level: string;
}

/**
 * PANEL PRINCIPAL
 * ---------------
 * La primera pregunta del día es «¿dónde está mi dinero?», así que eso es lo
 * primero y lo más grande de la pantalla. Debajo, en orden de utilidad:
 * cómo va hoy, cómo va el período, qué debo, si me estoy pasando del
 * presupuesto, qué tareas tengo y si las cifras son fiables.
 *
 * Ningún número se calcula aquí a ojo: todos vienen del servidor (o de la copia
 * local, marcada como tal cuando no hay conexión).
 */
export function DashboardPage() {
  const [params] = useSearchParams();
  const { preferences } = useAuth();
  const entityId = params.get('entityId') ?? '';
  const currency = preferences?.currency ?? 'DOP';
  const [preset, setPreset] = useState<Preset>('TODAY');
  const [showCharts, setShowCharts] = useState(false);

  const summaryQuery = useQuery<Summary>({
    queryKey: ['dashboard-summary', entityId, preset],
    queryFn: () => api.get<Summary>(`/dashboard/summary?${entityId ? `entityId=${entityId}&` : ''}preset=${preset}`),
  });

  const chartsQuery = useQuery<Charts>({
    queryKey: ['dashboard-charts', entityId],
    queryFn: () => api.get<Charts>(`/dashboard/charts?${entityId ? `entityId=${entityId}&` : ''}days=30`),
  });

  const setupQuery = useQuery<SetupStatus>({
    queryKey: ['setup-status', entityId],
    queryFn: () => api.get<SetupStatus>(`/setup/status${entityId ? `?entityId=${entityId}` : ''}`),
  });

  // Unidades que todavía no han declarado cuánto dinero tienen. Cuando se mira
  // una sola, la lista tiene un elemento; con «todas las unidades», las que falten.
  const unidadesSinSaldos = setupQuery.data?.entities.filter((entity) => !entity.openingBalancePosted) ?? [];
  const nombresSinSaldos = unidadesSinSaldos.map((entity) => `«${entity.code}»`).join(', ');

  const tasksQuery = useQuery<PendingTasks>({
    queryKey: ['pending-tasks'],
    queryFn: () => api.get<PendingTasks>('/notifications/tasks'),
  });

  const controlQuery = useQuery<{
    level: 'GREEN' | 'YELLOW' | 'RED';
    headline: string;
    counts: { critical: number; warning: number; info: number; total: number };
    streaks: { consecutiveClosedDays: number };
  }>({
    queryKey: ['daily-control'],
    queryFn: () =>
      api.get<{
        level: 'GREEN' | 'YELLOW' | 'RED';
        headline: string;
        counts: { critical: number; warning: number; info: number; total: number };
        streaks: { consecutiveClosedDays: number };
      }>('/daily-control'),
    refetchInterval: 120_000,
    enabled: navigator.onLine,
  });

  // Listas de compras abiertas: es trabajo vivo del día, por eso se ve en el inicio.
  const shoppingQuery = useQuery<ShoppingSummary>({
    queryKey: ['shopping-summary', entityId],
    queryFn: () => api.get<ShoppingSummary>(`/shopping-lists/summary${entityId ? `?entityId=${entityId}` : ''}`),
  });

  const summary = summaryQuery.data;
  const periodLabel =
    preset === 'TODAY'
      ? 'hoy'
      : preset === 'YESTERDAY'
        ? 'ayer'
        : preset === 'WEEK'
          ? 'esta semana'
          : preset === 'MONTH'
            ? 'este mes'
            : 'los últimos 30 días';

  const budgetPercent = summary ? Number(summary.budget.percentUsed) : 0;
  const budgetTone = budgetPercent >= 100 ? 'negative' : budgetPercent >= 80 ? 'warning' : 'positive';
  // Un presupuesto de cero NO es «estoy al día»: es «todavía no me he puesto límite».
  const hasBudget = summary ? Number(summary.budget.limit) > 0 : false;
  // Sin ingresos ni gastos en el período, los gráficos no tienen nada que contar.
  const noMovementsInPeriod = summary
    ? Number(summary.period.income) === 0 && Number(summary.period.expense) === 0
    : false;
  const noMovementsToday = summary ? summary.today.movementCount === 0 : true;

  const heroTone = useMemo(() => {
    if (!summary) {
      return 'neutral' as const;
    }
    return Number(summary.money.availableCash) < 0 ? ('negative' as const) : ('positive' as const);
  }, [summary]);

  if (summaryQuery.isLoading) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-36" />
        <Skeleton className="h-20" />
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      </div>
    );
  }

  if (summaryQuery.isError || !summary) {
    return (
      <Notice tone="warning" title="No se pudo cargar el panel">
        <p>
          No se pudo contactar con el servidor. Puede seguir consultando los últimos datos guardados en este dispositivo
          desde «Movimientos» y «Cierre».
        </p>
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={() => void summaryQuery.refetch()}>
            Reintentar ahora
          </Button>
        </div>
      </Notice>
    );
  }

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------------ */}
      {/* DINERO DISPONIBLE: la respuesta principal, en grande                */}
      {/* ------------------------------------------------------------------ */}
      <Card className="overflow-hidden">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">¿Dónde está mi dinero?</p>
          <Link to={`/cuentas${entityId ? `?entityId=${entityId}` : ''}`} className="text-xs font-medium text-brand">
            Ver cuentas
          </Link>
        </div>

        <div className="mt-2">
          <AmountDisplay
            value={summary.money.availableCash}
            currency={currency}
            tone={heroTone}
            size="hero"
            hint={summary.money.note}
          />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border-soft pt-3">
          <div>
            <p className="text-[0.7rem] uppercase tracking-wide text-faint">En efectivo</p>
            <p className="mt-0.5 font-semibold">
              <Money value={summary.money.inCash} currency={currency} />
            </p>
          </div>
          <div>
            <p className="text-[0.7rem] uppercase tracking-wide text-faint">En bancos</p>
            <p className="mt-0.5 font-semibold">
              <Money value={summary.money.inBanks} currency={currency} />
            </p>
          </div>
        </div>

        <div className="mt-3">
          {summary.dataQuality.isProvisional ? (
            <p className="flex items-start gap-1.5 text-xs leading-snug text-warning">
              <IconWifiOff size={14} className="mt-0.5 shrink-0" />
              {summary.dataQuality.message}
            </p>
          ) : summary.dataQuality.pendingClosings > 0 ? (
            <p className="text-xs leading-snug text-muted">{summary.dataQuality.message}</p>
          ) : (
            <p className="text-xs leading-snug text-positive">Cifras conciliadas con el libro mayor.</p>
          )}
        </div>
      </Card>

      {/* Primer uso: lo más importante es declarar cuánto hay y de quién es.
          El aviso es POR UNIDAD. Antes se medía en conjunto, así que una sola
          unidad con saldos declarados lo apagaba para todas: con una unidad de
          prueba configurada, el aviso desaparecía aunque las demás estuvieran
          vacías. Si se miran «todas las unidades», se nombran las que faltan. */}
      {!setupQuery.data ? null : setupQuery.data.needsSetup ? (
        <Card className="border-warning/40 bg-warning/10">
          <SectionTitle title="Falta lo más importante: ¿cuánto dinero hay y de quién es?" />
          <p className="text-sm leading-snug text-ink">
            Sin esta información, FINANZA no puede decirle dónde está su dinero ni si los saldos cuadran. Es un
            asistente de cinco pasos y no hay ningún importe precargado: todas las cifras las escribe usted.
          </p>
          <Link to="/organizar" className="mt-3 block">
            <Button fullWidth>Organizar mi dinero</Button>
          </Link>
        </Card>
      ) : unidadesSinSaldos.length > 0 ? (
        <Card className="border-warning/40 bg-warning/10">
          <SectionTitle title="Hay unidades sin saldos declarados" />
          <p className="text-sm leading-snug text-ink">
            Todavía no ha dicho cuánto dinero hay en {nombresSinSaldos}. Mientras no lo declare,{' '}
            {unidadesSinSaldos.length === 1 ? 'esa unidad cuenta' : 'esas unidades cuentan'} como cero en el total que
            ve arriba.
          </p>
          <Link to="/organizar" className="mt-3 block">
            <Button fullWidth>Organizar mi dinero</Button>
          </Link>
        </Card>
      ) : null}

      {/* Cómo va hoy */}
      <div className="grid grid-cols-2 gap-3">
        <Kpi label="Ingresos de hoy" value={summary.today.income} tone="positive" currency={currency} />
        <Kpi label="Gastos de hoy" value={summary.today.expense} tone="negative" currency={currency} />
        <Kpi
          label="Resultado de hoy"
          value={summary.today.result}
          tone={summary.today.result.startsWith('-') ? 'negative' : 'positive'}
          hint={`${summary.today.movementCount} movimiento(s)`}
          currency={currency}
        />
        <Kpi
          label="Resultado del período"
          value={summary.period.result}
          tone={summary.period.result.startsWith('-') ? 'negative' : 'positive'}
          hint={`Margen ${summary.period.margin}% · ${periodLabel}`}
          currency={currency}
        />
      </div>

      {/* Acciones rápidas: las dos que se usan a diario, y los atajos al lado. */}
      <div className="grid grid-cols-2 gap-2">
        <Link to="/registrar?kind=INCOME">
          <Button fullWidth variant="secondary">
            <IconArrowDown size={16} /> Ingreso
          </Button>
        </Link>
        <Link to="/registrar?kind=EXPENSE">
          <Button fullWidth variant="secondary">
            <IconArrowUp size={16} /> Gasto
          </Button>
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs font-medium">
        <Link to="/traspasos" className="text-brand">
          Transferir
        </Link>
        <Link to="/compras" className="text-brand">
          Compras
        </Link>
        {noMovementsToday ? (
          <Link to="/organizar" className="text-brand">
            Organizar mi dinero
          </Link>
        ) : (
          <Link to="/cierres" className="text-brand">
            Cerrar el día
          </Link>
        )}
      </div>

      {/* Control diario */}
      {controlQuery.data ? (
        <Card>
          <SectionTitle
            title="Mi control diario"
            hint={controlQuery.data.headline}
            right={
              <Badge
                tone={
                  controlQuery.data.level === 'RED' ? 'critical' : controlQuery.data.level === 'YELLOW' ? 'warning' : 'positive'
                }
              >
                {controlQuery.data.level === 'RED' ? 'ROJO' : controlQuery.data.level === 'YELLOW' ? 'AMARILLO' : 'VERDE'}
              </Badge>
            }
          />
          <p className="text-xs leading-snug text-muted">
            {controlQuery.data.counts.total} tarea(s): {controlQuery.data.counts.critical} urgente(s),{' '}
            {controlQuery.data.counts.warning} pendiente(s). Lleva {controlQuery.data.streaks.consecutiveClosedDays}{' '}
            día(s) seguido(s) cerrando.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Link to="/control">
              <Button fullWidth variant="secondary" size="sm">
                <IconTarget size={16} /> Ver mis tareas
              </Button>
            </Link>
            <Link to="/cierres">
              <Button fullWidth variant="secondary" size="sm">
                Cerrar el día
              </Button>
            </Link>
          </div>
        </Card>
      ) : null}

      {/* Compras: lo que está pendiente de comprar y cuánto se calcula gastar */}
      {shoppingQuery.data && shoppingQuery.data.openLists > 0 ? (
        <Card>
          <SectionTitle
            title="Listas de compras"
            hint={`${shoppingQuery.data.openLists} abierta(s) · ${shoppingQuery.data.itemsPending} producto(s) por comprar`}
            right={<IconBag size={18} className="text-brand" />}
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[0.7rem] uppercase tracking-wide text-faint">Falta por comprar</p>
              <p className="mt-0.5 font-semibold">
                <Money value={shoppingQuery.data.pendingTotal} currency={currency} />
              </p>
            </div>
            <div>
              <p className="text-[0.7rem] uppercase tracking-wide text-faint">Cálculo inicial</p>
              <p className="mt-0.5 font-semibold text-muted">
                <Money value={shoppingQuery.data.estimatedTotal} currency={currency} />
              </p>
            </div>
          </div>
          <p className="mt-2 text-[0.7rem] leading-snug text-faint">{shoppingQuery.data.note}</p>
          <Link to="/compras" className="mt-3 block">
            <Button fullWidth variant="secondary" size="sm">
              Ver mis listas <IconChevronRight size={14} />
            </Button>
          </Link>
        </Card>
      ) : null}

      {/* Selector del período que se está mirando */}
      <Tabs
        tabs={[
          { id: 'TODAY' as Preset, label: 'Hoy' },
          { id: 'YESTERDAY' as Preset, label: 'Ayer' },
          { id: 'WEEK' as Preset, label: 'Semana' },
          { id: 'MONTH' as Preset, label: 'Mes' },
          { id: 'LAST_30_DAYS' as Preset, label: '30 días' },
        ]}
        active={preset}
        onChange={setPreset}
      />

      <Card>
        <SectionTitle title={`Resumen ${periodLabel}`} hint={`Del ${summary.range.from} al ${summary.range.to}`} />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2">
          <div>
            <p className="text-[0.7rem] uppercase tracking-wide text-faint">Entró</p>
            <p className="mt-0.5 text-sm font-semibold text-positive">
              <Money value={summary.period.income} currency={currency} />
            </p>
          </div>
          <div>
            <p className="text-[0.7rem] uppercase tracking-wide text-faint">Salió</p>
            <p className="mt-0.5 text-sm font-semibold text-negative">
              <Money value={summary.period.expense} currency={currency} />
            </p>
          </div>
          <div>
            <p className="text-[0.7rem] uppercase tracking-wide text-faint">Resultado</p>
            <p className="mt-0.5 text-sm font-semibold">
              <Money
                value={summary.period.result}
                currency={currency}
                tone={summary.period.result.startsWith('-') ? 'negative' : 'positive'}
              />
            </p>
          </div>
        </div>

        {noMovementsInPeriod ? (
          <p className="mt-3 border-t border-border-soft pt-2 text-xs leading-snug text-muted">
            No hay movimientos en {periodLabel}. Las cifras están a cero porque no ha registrado nada todavía, no porque
            se haya perdido información.
          </p>
        ) : null}
      </Card>

      {/* Deudas y cobros */}
      <Card>
        <SectionTitle title="Lo que debo y lo que me deben" />
        <div className="grid grid-cols-2 gap-3">
          <Kpi label="Deuda total" value={summary.obligations.totalDebt} tone="negative" currency={currency} />
          <Kpi label="Cuentas por cobrar" value={summary.obligations.receivables} tone="positive" currency={currency} />
          <Kpi label="Préstamos por pagar" value={summary.obligations.loanDebt} tone="negative" currency={currency} />
          <Kpi
            label="Tarjetas de crédito"
            value={summary.obligations.creditCardDebt}
            tone="negative"
            currency={currency}
          />
        </div>

        {summary.obligations.upcomingPayments.length > 0 ? (
          <div className="mt-4 space-y-2 border-t border-border-soft pt-3">
            <p className="text-[0.7rem] uppercase tracking-wide text-faint">Pagos próximos (7 días)</p>
            {summary.obligations.upcomingPayments.slice(0, 5).map((payment) => (
              <div key={payment.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate text-ink">{payment.name}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {payment.daysRemaining < 0 ? (
                    <Badge tone="critical">vencido</Badge>
                  ) : (
                    <Badge tone="warning">{payment.daysRemaining} d</Badge>
                  )}
                  <Money value={payment.amount} tone="negative" currency={currency} />
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      {/* Presupuesto y retiros */}
      {hasBudget ? (
        <Card>
          <SectionTitle title="Presupuesto del mes" hint={`Consumido ${summary.budget.percentUsed}%`} />
          <ProgressBar percent={budgetPercent} tone={budgetTone} />
          <p className="mt-2 text-xs leading-snug text-muted">
            Gastado {formatMoney(summary.budget.spent, currency)} de {formatMoney(summary.budget.limit, currency)}. Quedan{' '}
            <strong className="text-ink">{formatMoney(summary.budget.remaining, currency)}</strong>.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border-soft pt-3">
            <div>
              <p className="text-[0.7rem] uppercase tracking-wide text-faint">Retirado por mí este mes</p>
              <p className="mt-0.5 font-semibold">
                <Money value={summary.owner.withdrawalsThisMonth} currency={currency} />
              </p>
            </div>
            <div>
              <p className="text-[0.7rem] uppercase tracking-wide text-faint">Aporté este mes</p>
              <p className="mt-0.5 font-semibold">
                <Money value={summary.owner.contributionsThisMonth} currency={currency} />
              </p>
            </div>
          </div>
          <Link to="/presupuestos" className="mt-3 block">
            <Button fullWidth variant="secondary" size="sm">
              Ajustar presupuesto <IconChevronRight size={14} />
            </Button>
          </Link>
        </Card>
      ) : (
        <Card>
          <SectionTitle title="Presupuesto del mes" />
          <EmptyState
            title="Todavía no ha fijado un presupuesto"
            hint="Sin límite definido no se puede decir si va bien o mal. Póngase uno y FINANZA le avisará al acercarse."
          />
          <Link to="/presupuestos" className="mt-3 block">
            <Button fullWidth variant="secondary" size="sm">
              Definir presupuesto <IconChevronRight size={14} />
            </Button>
          </Link>
        </Card>
      )}

      {/* Tareas financieras pendientes: cada una lleva a donde se resuelve. */}
      {tasksQuery.data && tasksQuery.data.tasks.length > 0 ? (
        <Card>
          <SectionTitle title="Tareas financieras pendientes" hint="Calculadas con datos reales, no con estimaciones" />
          <div className="space-y-2">
            {tasksQuery.data.tasks.slice(0, 5).map((task) => {
              const content = (
                <div className="flex w-full items-start justify-between gap-2 rounded-xl border border-border-soft p-3 text-left">
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug text-ink">{task.title}</p>
                    <p className="mt-0.5 text-xs leading-snug text-muted">{task.detail}</p>
                    {task.amount ? (
                      <p className="mt-1 text-xs">
                        <Money value={task.amount} currency={currency} />
                      </p>
                    ) : null}
                  </div>
                  <Badge
                    tone={task.severity === 'CRITICAL' ? 'critical' : task.severity === 'WARNING' ? 'warning' : 'neutral'}
                  >
                    {task.isMandatory ? 'obligatoria' : 'revisar'}
                  </Badge>
                </div>
              );
              return task.actionUrl ? (
                <Link key={task.id} to={task.actionUrl} className="block">
                  {content}
                </Link>
              ) : (
                <div key={task.id}>{content}</div>
              );
            })}
          </div>
        </Card>
      ) : null}

      {/* Cierres de hoy */}
      <Card>
        <SectionTitle
          title="Cierres de hoy"
          right={
            summary.closings.pendingDays > 0 ? <Badge tone="warning">{summary.closings.pendingDays} día(s) pendiente(s)</Badge> : null
          }
        />
        {summary.closings.today.length > 0 ? (
          <div className="space-y-2">
            {summary.closings.today.map((closing) => (
              <div key={closing.entityId} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate text-muted">{formatBusinessDate(summary.range.to)}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {closing.closed ? <Badge tone="positive">cerrado</Badge> : <Badge tone="warning">pendiente</Badge>}
                  {closing.difference ? <Money value={closing.difference} tone="negative" currency={currency} /> : null}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="Todavía no hay cierre de hoy"
            hint="Vaya a «Cierre» para revisar el día, contar el efectivo y confirmar."
          />
        )}
      </Card>

      {/* Comparación entre unidades */}
      {chartsQuery.data && chartsQuery.data.entitiesComparison.length > 1 ? (
        <Card>
          <SectionTitle title="Comparación entre unidades" hint="Ventas no son ganancias: aquí se ve el resultado real" />
          <div className="space-y-2">
            {chartsQuery.data.entitiesComparison.map((row) => (
              <div key={row.entityId} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-ink">{row.entityName}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <Money value={row.income} tone="positive" currency={currency} />
                  <Money value={row.expense} tone="negative" currency={currency} />
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[0.7rem] text-faint">
            Resultado de cada unidad disponible en «Informes», con el detalle del período.
          </p>
        </Card>
      ) : null}

      {/* Transferencias */}
      {chartsQuery.data ? (
        <Card>
          <SectionTitle title="Transferencias" hint={chartsQuery.data.transfers.note} />
          <div className="flex items-center justify-between gap-2 text-sm text-ink">
            <span>
              {chartsQuery.data.transfers.count} transferencia(s), {chartsQuery.data.transfers.internalCount} interna(s)
            </span>
            <Money value={chartsQuery.data.transfers.total} currency={currency} />
          </div>
        </Card>
      ) : null}

      {/* Gráficos: se piden sólo si el usuario los quiere ver, y sólo si hay algo que contar. */}
      {noMovementsInPeriod ? (
        <Card>
          <SectionTitle title="Gráficos" />
          <p className="text-sm leading-snug text-muted">
            No se muestran gráficos porque no hay movimientos en {periodLabel}. En cuanto registre el primero, aquí
            aparecerá la evolución diaria y el reparto por categoría.
          </p>
          <Link to="/registrar?kind=INCOME" className="mt-3 block">
            <Button fullWidth>Registrar el primer movimiento</Button>
          </Link>
        </Card>
      ) : !showCharts ? (
        <Button fullWidth variant="secondary" onClick={() => setShowCharts(true)}>
          Ver gráficos del período
        </Button>
      ) : (
        <Suspense
          fallback={
            <div className="space-y-3">
              <Skeleton className="h-52" />
              <Skeleton className="h-64" />
            </div>
          }
        >
          {chartsQuery.isLoading ? (
            <Spinner label="Cargando gráficos…" />
          ) : (
            <DashboardCharts
              dailySeries={chartsQuery.data?.dailySeries ?? []}
              expenseByCategory={chartsQuery.data?.expenseByCategory ?? []}
              currency={currency}
            />
          )}
        </Suspense>
      )}
    </div>
  );
}
