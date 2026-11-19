import { Suspense, lazy, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../store/auth';
import { AgenteDeSalud } from '../components/AgenteDeSalud';
import {
  AmountDisplay,
  Badge,
  Button,
  Card,
  Kpi,
  Money,
  Notice,
  ProgressBar,
  SectionTitle,
  Skeleton,
  Spinner,
} from '../components/ui';
import { formatMoney } from '../lib/format';
import { normalizePeriodo } from '../lib/periods';
import { IconArrowDown, IconArrowUp, IconBag, IconChevronRight, IconWifiOff } from '../components/icons';

// Los gráficos se cargan sólo cuando hacen falta (son la parte más pesada).
const DashboardCharts = lazy(() =>
  import('../components/DashboardCharts').then((module) => ({ default: module.DashboardCharts })),
);

interface Summary {
  range: { from: string; to: string; preset: string };
  today: { income: string; expense: string; result: string; movementCount: number };
  period: { income: string; expense: string; result: string; margin: string };
  money: { availableCash: string; inCash: string; inBanks: string; inCustody?: string; personalNet?: string; note: string };
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
    entityName?: string | null;
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
  // El período lo elige el filtro de la cabecera azul y llega por la dirección:
  // una sola fuente para los dos, sin estado duplicado.
  const preset = normalizePeriodo(params.get('periodo'));
  const [showCharts, setShowCharts] = useState(false);

  const summaryQuery = useQuery<Summary>({
    queryKey: ['dashboard-summary', entityId, preset],
    queryFn: () => api.get<Summary>(`/dashboard/summary?${entityId ? `entityId=${entityId}&` : ''}preset=${preset}`),
  });

  const chartsQuery = useQuery<Charts>({
    queryKey: ['dashboard-charts', entityId],
    queryFn: () => api.get<Charts>(`/dashboard/charts?${entityId ? `entityId=${entityId}&` : ''}days=30`),
  });

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
    // Se consulta también sin conexión: así se usa la copia guardada del día en
    // lugar de dejar el bloque vacío (ver `lib/read-cache.ts`).
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
      <Notice tone="warning" title="El panel necesita una primera conexión">
        <p>
          Todavía no hay cifras guardadas en este dispositivo: el panel se calcula en el servidor y se guarda aquí cada
          vez que se abre con conexión. Conéctese un momento y a partir de ahí podrá consultarlo sin internet.
        </p>
        <p className="mt-2 text-xs leading-snug">
          Mientras tanto, puede seguir <strong>registrando gastos e ingresos</strong> sin conexión desde «Añadir»: se
          guardan en el teléfono y se envían solos al recuperar la señal.
        </p>
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={() => void summaryQuery.refetch()}>
            Reintentar ahora
          </Button>
        </div>
      </Notice>
    );
  }

  /*
   * ¿Hay algo que enseñar?
   *
   * Regla de esta pantalla: un bloque que sólo diría «0» o «todavía no» NO se
   * pinta. Antes el inicio podía acumular siete tarjetas vacías y el usuario
   * tenía que buscar la única cifra que importaba. Ahora se muestran sólo los
   * bloques con datos reales y, si no hay ninguno, una sola tarjeta con lo
   * primero que hay que hacer.
   */
  const sinDeudas =
    Number(summary.obligations.totalDebt) === 0 &&
    Number(summary.obligations.receivables) === 0 &&
    Number(summary.obligations.loanDebt) === 0 &&
    Number(summary.obligations.creditCardDebt) === 0 &&
    summary.obligations.upcomingPayments.length === 0;
  const sinCierres = summary.closings.today.length === 0 && summary.closings.pendingDays === 0;
  const sinControl = !controlQuery.data || controlQuery.data.counts.total === 0;
  const sinTareas = !tasksQuery.data || tasksQuery.data.tasks.length === 0;
  const sinCompras = !shoppingQuery.data || shoppingQuery.data.openLists === 0;
  const sinTransferencias = !chartsQuery.data || chartsQuery.data.transfers.count === 0;
  const panelVacio =
    noMovementsInPeriod && sinDeudas && sinCierres && !hasBudget && sinControl && sinTareas && sinCompras && sinTransferencias;
  // Comparar unidades con ceros no dice nada: se comparan sólo las que tuvieron
  // ingresos o gastos, y la tarjeta sólo aparece si hay al menos dos.
  const comparacionConDatos = (chartsQuery.data?.entitiesComparison ?? []).filter(
    (row) => Number(row.income) !== 0 || Number(row.expense) !== 0,
  );

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
          <AmountDisplay value={summary.money.availableCash} currency={currency} tone={heroTone} size="hero" />
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

        {/* Dinero que está en el banco pero es de una empresa. Sin este aviso, el
            «disponible» del panel parecería todo suyo. */}
        {Number(summary.money.inCustody ?? 0) > 0 ? (
          <div className="mt-3 rounded-xl bg-warning/10 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted">De ese dinero, es de una empresa</p>
              <Money value={summary.money.inCustody} currency={currency} tone="warning" className="font-semibold" />
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs">
              <Link to="/custodia" className="font-semibold text-brand">
                Fondos en custodia →
              </Link>
              <span className="text-muted">
                Suyo de verdad: <Money value={summary.money.personalNet} currency={currency} />
              </span>
            </div>
          </div>
        ) : null}

        {/* Sólo se dice algo si hay algo que decir: con el panel vacío, la línea
            «cifras conciliadas» era una frase de relleno. */}
        {summary.dataQuality.isProvisional ? (
          <p className="mt-3 flex items-start gap-1.5 text-xs leading-snug text-warning">
            <IconWifiOff size={14} className="mt-0.5 shrink-0" />
            {summary.dataQuality.message}
          </p>
        ) : summary.dataQuality.pendingClosings > 0 ? (
          <Link to="/cierres" className="mt-3 inline-flex text-xs font-medium text-brand">
            {summary.dataQuality.pendingClosings} día(s) sin cerrar →
          </Link>
        ) : null}
      </Card>

      {/* El agente de datos: lo primero que ve si algo no llegó al servidor. */}
      <AgenteDeSalud />

      {/* Cómo va hoy: sólo cuando hay movimientos que contar. */}
      {!noMovementsInPeriod ? (
        <div className="grid grid-cols-2 gap-3">
          <Kpi label="Ingresos de hoy" value={summary.today.income} tone="positive" currency={currency} />
          <Kpi label="Gastos de hoy" value={summary.today.expense} tone="negative" currency={currency} />
          <Kpi
            label="Resultado de hoy"
            value={summary.today.result}
            tone={summary.today.result.startsWith('-') ? 'negative' : 'positive'}
            currency={currency}
          />
          <Kpi
            label="Resultado del período"
            value={summary.period.result}
            tone={summary.period.result.startsWith('-') ? 'negative' : 'positive'}
            hint={periodLabel}
            currency={currency}
          />
        </div>
      ) : null}
      {!noMovementsInPeriod ? (
        <div className="px-1 text-right">
          <Link to="/movimientos" className="text-xs font-medium text-brand">
            Ver movimientos
          </Link>
        </div>
      ) : null}

      {/* Acciones rápidas: las dos que se usan a diario. Los demás atajos viven
          en el botón «+»; repetirlos aquí era ruido. */}
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

      {/* Primer uso: una sola tarjeta, con lo primero que hay que hacer. */}
      {panelVacio ? (
        <Card>
          <p className="text-sm font-semibold text-ink">Empiece por aquí</p>
          <p className="mt-1 text-xs leading-snug text-muted">
            Cree una cuenta con el dinero que tiene hoy o registre su primer movimiento. Las cifras aparecen solas.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Link to="/cuentas" className="block">
              <Button fullWidth size="sm" variant="secondary">
                Crear cuenta
              </Button>
            </Link>
            <Link to="/registrar?kind=EXPENSE" className="block">
              <Button fullWidth size="sm">
                Registrar gasto
              </Button>
            </Link>
          </div>
        </Card>
      ) : null}

      {/* Compras: lo que está pendiente de comprar y cuánto se calcula gastar */}
      {!sinCompras && shoppingQuery.data ? (
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

      {/* Resumen del período: sin movimientos no hay nada que resumir. */}
      {!noMovementsInPeriod ? (
        <>
          <Card>
            <SectionTitle
              title={`Resumen ${periodLabel}`}
              hint={`Del ${summary.range.from} al ${summary.range.to}`}
              right={
                <Link to="/informes" className="text-xs font-medium text-brand">
                  Ver informes
                </Link>
              }
            />
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
          </Card>
        </>
      ) : null}

      {/* Deudas y cobros: sólo si existe alguna. */}
      {!sinDeudas ? (
      <Card>
        <SectionTitle
          title="Lo que debo y lo que me deben"
          right={
            <Link to="/deudas" className="text-xs font-medium text-brand">
              Ver deudas
            </Link>
          }
        />
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
      ) : null}

      {/* Presupuesto y retiros: sin límite definido, la tarjeta no se pinta. */}
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
      ) : null}

      {/* Tareas financieras pendientes: cada una lleva a donde se resuelve. */}
      {tasksQuery.data && tasksQuery.data.tasks.length > 0 ? (
        <Card>
          <SectionTitle title="Tareas financieras pendientes" />
          <div className="space-y-2">
            {tasksQuery.data.tasks.slice(0, 3).map((task) => {
              const content = (
                <div className="flex w-full items-start justify-between gap-2 border border-border-soft p-3 text-left">
                  <div className="min-w-0">
                    {task.entityName ? (
                      <p className="text-[0.6rem] font-semibold uppercase tracking-[0.08em] text-faint">
                        {task.entityName}
                      </p>
                    ) : null}
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

      {/* Comparación entre unidades: sólo las que tienen actividad, y sólo si
          hay al menos dos que comparar. */}
      {comparacionConDatos.length > 1 ? (
        <Card>
          <SectionTitle
            title="Comparación entre unidades"
            hint="Ventas no son ganancias: aquí se ve el resultado real"
            right={
              <Link to="/informes" className="text-xs font-medium text-brand">
                Ver informes
              </Link>
            }
          />
          <div className="space-y-2">
            {comparacionConDatos.map((row) => (
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

      {/* Transferencias: sólo si hubo alguna. */}
      {chartsQuery.data && !sinTransferencias ? (
        <Card>
          <SectionTitle
            title="Transferencias"
            hint={chartsQuery.data.transfers.note}
            right={
              <Link to="/traspasos" className="text-xs font-medium text-brand">
                Ver traspasos
              </Link>
            }
          />
          <div className="flex items-center justify-between gap-2 text-sm text-ink">
            <span>
              {chartsQuery.data.transfers.count} transferencia(s), {chartsQuery.data.transfers.internalCount} interna(s)
            </span>
            <Money value={chartsQuery.data.transfers.total} currency={currency} />
          </div>
        </Card>
      ) : null}

      {/* Gráficos: se piden sólo si el usuario los quiere ver, y sólo si hay algo que contar. */}
      {noMovementsInPeriod ? null : !showCharts ? (
        <div className="px-1 py-1 text-center">
          <button type="button" className="text-xs font-medium text-brand" onClick={() => setShowCharts(true)}>
            Ver gráficos del período
          </button>
        </div>
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
