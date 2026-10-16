import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../lib/api';
import { useAuth } from '../store/auth';
import { Badge, Card, EmptyState, Kpi, Money, Notice, SectionTitle, Spinner, Tabs } from '../components/ui';
import { formatBusinessDate, formatMoney } from '../lib/format';

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
  closings: { pendingDays: number; today: Array<{ entityId: string; status: string; closed: boolean; difference: string | null }> };
  dataQuality: { isProvisional: boolean; unsyncedOperations: number; pendingClosings: number; message: string };
}

interface Charts {
  range: { from: string; to: string; days: number };
  dailySeries: Array<{ date: string; income: string; expense: string; result: string; movements: number }>;
  expenseByCategory: Array<{ categoryId: string; categoryName: string; amount: string; share: string }>;
  entitiesComparison: Array<{ entityId: string; entityName: string; income: string; expense: string; result: string; withdrawals: string }>;
  cashEvolution: { totalCash: string; totalLiabilities: string; accounts: Array<{ accountId: string; name: string; balance: string; isLiability: boolean }>; note: string };
  monthlyTrend: Array<{ month: string; income: string; expense: string; result: string }>;
  transfers: { count: number; internalCount: number; total: string; note: string };
}

interface PendingTasks {
  tasks: Array<{ id: string; type: string; title: string; detail: string; severity: string; isMandatory: boolean; amount: string | null; actionUrl: string }>;
  level: string;
}

const PIE_COLORS = ['#f87171', '#fbbf24', '#60a5fa', '#34d399', '#a78bfa', '#fb923c', '#22d3ee', '#f472b6'];

/**
 * PANEL PRINCIPAL
 * ---------------
 * Responde a las preguntas que el usuario hace a diario: cuánto entró, cuánto
 * salió, cuánto tengo disponible, cuánto debo y si los datos son fiables.
 */
export function DashboardPage() {
  const [params] = useSearchParams();
  const { preferences } = useAuth();
  const entityId = params.get('entityId') ?? '';
  const currency = preferences?.currency ?? 'DOP';
  const [preset, setPreset] = useState<Preset>('MONTH');

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

  const chartData = useMemo(
    () =>
      (chartsQuery.data?.dailySeries ?? []).map((row) => ({
        date: row.date.slice(5),
        Ingresos: Number(row.income),
        Gastos: Number(row.expense),
      })),
    [chartsQuery.data],
  );

  const pieData = useMemo(
    () =>
      (chartsQuery.data?.expenseByCategory ?? []).slice(0, 8).map((row) => ({
        name: row.categoryName,
        value: Number(row.amount),
        share: row.share,
      })),
    [chartsQuery.data],
  );

  if (summaryQuery.isLoading) {
    return <Spinner label="Cargando el panel…" />;
  }

  if (summaryQuery.isError || !summaryQuery.data) {
    return (
      <Notice tone="warning" title="No se pudo cargar el panel">
        Puede seguir consultando los últimos datos guardados en este dispositivo desde «Movimientos» y «Cierre».
      </Notice>
    );
  }

  const summary = summaryQuery.data;

  return (
    <div className="space-y-4">
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

      {summary.dataQuality.isProvisional ? (
        <Notice tone="warning" title="Cifras provisionales">
          {summary.dataQuality.message}
        </Notice>
      ) : summary.dataQuality.pendingClosings > 0 ? (
        <Notice tone="neutral" title="Hay cierres pendientes">
          {summary.dataQuality.message}
        </Notice>
      ) : (
        <Notice tone="positive">Cifras conciliadas con el libro mayor.</Notice>
      )}

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
          hint={`Margen ${summary.period.margin}%`}
          currency={currency}
        />
      </div>

      <Card>
        <SectionTitle title="Dinero disponible" hint={summary.money.note} />
        <div className="grid grid-cols-3 gap-3">
          <div>
            <p className="text-xs uppercase text-slate-400">Total</p>
            <p className="text-lg font-semibold">
              <Money value={summary.money.availableCash} tone="positive" currency={currency} />
            </p>
          </div>
          <div>
            <p className="text-xs uppercase text-slate-400">En efectivo</p>
            <p className="text-lg font-semibold">
              <Money value={summary.money.inCash} currency={currency} />
            </p>
          </div>
          <div>
            <p className="text-xs uppercase text-slate-400">En bancos</p>
            <p className="text-lg font-semibold">
              <Money value={summary.money.inBanks} currency={currency} />
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle title="Lo que debo y lo que me deben" />
        <div className="grid grid-cols-2 gap-3">
          <Kpi label="Deuda total" value={summary.obligations.totalDebt} tone="negative" currency={currency} />
          <Kpi label="Cuentas por cobrar" value={summary.obligations.receivables} tone="positive" currency={currency} />
          <Kpi label="Préstamos por pagar" value={summary.obligations.loanDebt} tone="negative" currency={currency} />
          <Kpi label="Tarjetas de crédito" value={summary.obligations.creditCardDebt} tone="negative" currency={currency} />
        </div>

        {summary.obligations.upcomingPayments.length > 0 ? (
          <div className="mt-3 space-y-1">
            <p className="text-xs uppercase text-slate-400">Pagos próximos (7 días)</p>
            {summary.obligations.upcomingPayments.slice(0, 5).map((payment) => (
              <div key={payment.id} className="flex items-center justify-between text-sm">
                <span className="truncate text-slate-300">{payment.name}</span>
                <span className="flex items-center gap-2">
                  {payment.daysRemaining < 0 ? <Badge tone="critical">vencido</Badge> : <Badge tone="warning">{payment.daysRemaining} d</Badge>}
                  <Money value={payment.amount} tone="negative" currency={currency} />
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Kpi
          label="Retirado por mí este mes"
          value={summary.owner.withdrawalsThisMonth}
          hint={`Aporté ${formatMoney(summary.owner.contributionsThisMonth, currency)}`}
          currency={currency}
        />
        <Kpi
          label="Presupuesto consumido"
          value={`${summary.budget.percentUsed}%`}
          hint={`Quedan ${formatMoney(summary.budget.remaining, currency)} de ${formatMoney(summary.budget.limit, currency)}`}
          tone={Number(summary.budget.percentUsed) >= 100 ? 'negative' : Number(summary.budget.percentUsed) >= 80 ? 'warning' : 'positive'}
        />
      </div>

      {tasksQuery.data && tasksQuery.data.tasks.length > 0 ? (
        <Card>
          <SectionTitle title="Tareas financieras pendientes" hint="Calculadas con datos reales, no con estimaciones" />
          <div className="space-y-2">
            {tasksQuery.data.tasks.slice(0, 5).map((task) => (
              <div key={task.id} className="flex items-start justify-between gap-2 rounded-lg border border-slate-800 p-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-200">{task.title}</p>
                  <p className="truncate text-xs text-slate-500">{task.detail}</p>
                </div>
                <Badge tone={task.severity === 'CRITICAL' ? 'critical' : task.severity === 'WARNING' ? 'warning' : 'neutral'}>
                  {task.isMandatory ? 'obligatoria' : 'revisar'}
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {chartData.length > 0 ? (
        <Card>
          <SectionTitle title="Ingresos y gastos (30 días)" hint="Las transferencias entre cuentas no aparecen aquí" />
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid stroke="#1e293b" vertical={false} />
                <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} interval={4} />
                <YAxis stroke="#94a3b8" fontSize={11} width={60} />
                <Tooltip
                  contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8 }}
                  formatter={(value) => formatMoney(String(value ?? '0'), currency)}
                />
                <Legend />
                <Bar dataKey="Ingresos" fill="#34d399" radius={[3, 3, 0, 0]} />
                <Bar dataKey="Gastos" fill="#f87171" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      ) : null}

      {pieData.length > 0 ? (
        <Card>
          <SectionTitle title="En qué se está gastando" hint="Gastos reales del período por categoría" />
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90} paddingAngle={2}>
                  {pieData.map((entry, index) => (
                    <Cell key={entry.name} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8 }}
                  formatter={(value) => formatMoney(String(value ?? '0'), currency)}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>
      ) : null}

      {chartsQuery.data && chartsQuery.data.entitiesComparison.length > 1 ? (
        <Card>
          <SectionTitle title="Comparación entre unidades financieras" hint="Ventas no son ganancias: aquí se ve el resultado real" />
          <div className="space-y-2">
            {chartsQuery.data.entitiesComparison.map((row) => (
              <div key={row.entityId} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate text-slate-300">{row.entityName}</span>
                <span className="flex items-center gap-3">
                  <Money value={row.income} tone="positive" currency={currency} />
                  <Money value={row.expense} tone="negative" currency={currency} />
                  <Money value={row.result} tone={row.result.startsWith('-') ? 'negative' : 'positive'} currency={currency} />
                </span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {chartsQuery.data ? (
        <Card>
          <SectionTitle title="Transferencias" hint={chartsQuery.data.transfers.note} />
          <div className="flex items-center justify-between text-sm text-slate-300">
            <span>
              {chartsQuery.data.transfers.count} transferencia(s), {chartsQuery.data.transfers.internalCount} interna(s)
            </span>
            <Money value={chartsQuery.data.transfers.total} currency={currency} />
          </div>
        </Card>
      ) : null}

      {summary.closings.today.length > 0 ? (
        <Card>
          <SectionTitle title="Cierres de hoy" />
          <div className="space-y-1">
            {summary.closings.today.map((closing) => (
              <div key={closing.entityId} className="flex items-center justify-between text-sm">
                <span className="text-slate-400">{formatBusinessDate(summary.range.to)}</span>
                <span className="flex items-center gap-2">
                  {closing.closed ? <Badge tone="positive">cerrado</Badge> : <Badge tone="warning">pendiente</Badge>}
                  {closing.difference ? <Money value={closing.difference} tone="negative" currency={currency} /> : null}
                </span>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <EmptyState
          title="Todavía no hay cierre de hoy"
          hint="Vaya a «Cierre» para revisar el día, contar el efectivo y confirmar."
        />
      )}
    </div>
  );
}
