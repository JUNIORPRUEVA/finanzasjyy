import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Badge, Button, Card, EmptyState, Field, MoneyInput, Notice, SectionTitle, Select, Sheet, Spinner } from '../components/ui';
import { useAuth } from '../store/auth';
import { formatMoney, todayBusinessDate } from '../lib/format';

/**
 * PRESUPUESTOS
 * ------------
 * Un límite por categoría y período, comparado con el gasto REAL del libro mayor.
 *
 * Decisión deliberada: superar un presupuesto NO bloquea el gasto. La realidad
 * manda; el presupuesto avisa. Un sistema que impide registrar un gasto real
 * terminaría con las cuentas mal, que es justo lo contrario de lo que se busca.
 */

interface Allocation {
  id: string;
  categoryId: string;
  categoryName: string;
  limitAmount: string;
  spentAmount: string;
  remainingAmount: string;
  percentUsed: string;
  health: 'OK' | 'WARNING' | 'EXCEEDED';
  warnPct?: number;
  alertPct?: number;
}

interface BudgetRow {
  id: string;
  entityId: string;
  entity?: { name: string; currency: string } | null;
  name: string;
  period: string;
  startDate: string;
  endDate: string | null;
  status: string;
  currency: string;
  totalLimit?: string;
  totalSpent?: string;
  health?: 'OK' | 'WARNING' | 'EXCEEDED';
  allocations: Allocation[];
}

interface CategoryRow {
  id: string;
  name: string;
  kind: string;
  isActive: boolean;
}

interface AlertsResponse {
  count: number;
  alerts: Array<{ budgetName: string; categoryName: string; limit: string; spent: string; percentUsed: string; health: string; message: string }>;
}

const PERIODS = [
  { value: 'MONTHLY', label: 'Mensual' },
  { value: 'WEEKLY', label: 'Semanal' },
  { value: 'QUARTERLY', label: 'Trimestral' },
  { value: 'ANNUAL', label: 'Anual' },
  { value: 'CUSTOM', label: 'Personalizado' },
];

const HEALTH_TONE = { OK: 'positive', WARNING: 'warning', EXCEEDED: 'critical' } as const;
const HEALTH_LABEL = { OK: 'En orden', WARNING: 'Cerca del límite', EXCEEDED: 'Excedido' };

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: T[] }).data;
  }
  return [];
}

export function BudgetsPage() {
  const { entities, preferences } = useAuth();
  const queryClient = useQueryClient();
  const currency = preferences?.currency ?? 'DOP';

  const budgetsQuery = useQuery<unknown>({ queryKey: ['budgets'], queryFn: () => api.get('/budgets?limit=100') });
  const alertsQuery = useQuery<AlertsResponse>({ queryKey: ['budget-alerts'], queryFn: () => api.get<AlertsResponse>('/budgets/alerts') });
  const categoriesQuery = useQuery<unknown>({ queryKey: ['categories'], queryFn: () => api.get('/categories') });

  const budgets = useMemo(() => asArray<BudgetRow>(budgetsQuery.data), [budgetsQuery.data]);
  const categories = useMemo(
    () => asArray<CategoryRow>(categoriesQuery.data).filter((category) => category.kind === 'EXPENSE' && category.isActive),
    [categoriesQuery.data],
  );

  const [message, setMessage] = useState<{ tone: 'positive' | 'warning' | 'negative'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [allocationTarget, setAllocationTarget] = useState<{ budget: BudgetRow; category: CategoryRow } | null>(null);
  const [allocationAmount, setAllocationAmount] = useState('');

  const [entityId, setEntityId] = useState('');
  const [name, setName] = useState('');
  const [period, setPeriod] = useState('MONTHLY');
  const [startDate, setStartDate] = useState(todayBusinessDate());
  const [lines, setLines] = useState<Array<{ categoryId: string; limitAmount: string }>>([{ categoryId: '', limitAmount: '' }]);

  const categoryOptions = categories.map((category) => ({ value: category.id, label: category.name }));

  const totalPlanned = lines.reduce((acc, line) => acc + Number(line.limitAmount || 0), 0);
  const canCreate =
    entityId !== '' &&
    name.trim().length >= 2 &&
    lines.some((line) => line.categoryId !== '' && Number(line.limitAmount) > 0);

  const create = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api.post('/budgets', {
        entityId,
        name: name.trim(),
        period,
        startDate,
        allocations: lines
          .filter((line) => line.categoryId !== '' && Number(line.limitAmount) > 0)
          .map((line) => ({ categoryId: line.categoryId, limitAmount: line.limitAmount })),
      });
      setMessage({
        tone: 'positive',
        text: 'Presupuesto creado. El consumo se calcula con los gastos reales: no hay que anotar nada más.',
      });
      setName('');
      setLines([{ categoryId: '', limitAmount: '' }]);
      await queryClient.invalidateQueries();
    } catch (caught) {
      setMessage({ tone: 'negative', text: caught instanceof ApiError ? caught.message : 'No se pudo crear el presupuesto.' });
    } finally {
      setBusy(false);
    }
  };

  const closeBudget = async (budget: BudgetRow) => {
    setBusy(true);
    try {
      await api.patch(`/budgets/${budget.id}`, { status: budget.status === 'ACTIVE' ? 'CLOSED' : 'ACTIVE' });
      await queryClient.invalidateQueries();
    } catch (caught) {
      setMessage({ tone: 'negative', text: caught instanceof ApiError ? caught.message : 'No se pudo cambiar el estado.' });
    } finally {
      setBusy(false);
    }
  };

  const upsertAllocation = async (budget: BudgetRow, categoryId: string, limitAmount: string) => {
    setBusy(true);
    try {
      await api.post(`/budgets/${budget.id}/allocations`, { categoryId, limitAmount });
      setMessage({ tone: 'positive', text: 'Límite actualizado. El consumo ya registrado se recalcula al instante.' });
      await queryClient.invalidateQueries();
    } catch (caught) {
      setMessage({ tone: 'negative', text: caught instanceof ApiError ? caught.message : 'No se pudo actualizar el límite.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      {alertsQuery.data && alertsQuery.data.count > 0 ? (
        <Card>
          <SectionTitle title="Avisos de presupuesto" hint="Avisa, no bloquea: la realidad manda" />
          <div className="space-y-2">
            {alertsQuery.data.alerts.map((alert) => (
              <Notice key={`${alert.budgetName}-${alert.categoryName}`} tone={alert.health === 'EXCEEDED' ? 'critical' : 'warning'}>
                {alert.message}
              </Notice>
            ))}
          </div>
        </Card>
      ) : null}

      <Card>
        <SectionTitle title="Mis presupuestos" hint="Límite por categoría comparado con el gasto real" />
        {budgetsQuery.isLoading ? <Spinner /> : null}
        {budgets.length === 0 && !budgetsQuery.isLoading ? (
          <EmptyState title="Todavía no hay presupuestos" hint="Empiece por la categoría en la que más gasta." />
        ) : null}

        <div className="space-y-3">
          {budgets.map((budget) => (
            <div key={budget.id} className="rounded-lg border border-border-soft p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-ink">{budget.name}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {budget.entity?.name ?? 'unidad'} · {budget.period} · desde {budget.startDate}
                  </p>
                </div>
                <div className="text-right">
                  <Badge tone={budget.status === 'ACTIVE' ? 'positive' : 'neutral'}>{budget.status === 'ACTIVE' ? 'Activo' : 'Cerrado'}</Badge>
                </div>
              </div>

              <div className="mt-3 space-y-2">
                {budget.allocations.map((allocation) => (
                  <div key={allocation.id}>
                    <div className="flex items-center justify-between text-xs text-ink">
                      <span>{allocation.categoryName}</span>
                      <span>
                        {formatMoney(allocation.spentAmount, budget.currency)} / {formatMoney(allocation.limitAmount, budget.currency)} ·{' '}
                        {allocation.percentUsed}%
                      </span>
                    </div>
                    <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-surface-3">
                      <div
                        className={`h-full ${
                          allocation.health === 'EXCEEDED' ? 'bg-negative' : allocation.health === 'WARNING' ? 'bg-warning' : 'bg-brand'
                        }`}
                        style={{ width: `${Math.min(100, Number(allocation.percentUsed))}%` }}
                      />
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge tone={HEALTH_TONE[allocation.health]}>{HEALTH_LABEL[allocation.health]}</Badge>
                      <span className="text-xs text-faint">Queda {formatMoney(allocation.remainingAmount, budget.currency)}</span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  placeholder="Añadir categoría…"
                  list={`categories-${budget.id}`}
                  className="w-40 rounded-lg border border-border-soft bg-surface-2 px-2 py-1 text-xs text-ink"
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') {
                      return;
                    }
                    const target = event.currentTarget;
                    const selected = categories.find((category) => category.name === target.value);
                    if (!selected) {
                      return;
                    }
                    // Se pide el límite con la hoja de la aplicación, no con el
                    // cuadro del navegador: así el campo es numérico, se ve el
                    // importe formateado y puedo cancelar sin perder lo escrito.
                    setAllocationTarget({ budget, category: selected });
                    setAllocationAmount('');
                    target.value = '';
                  }}
                />
                <datalist id={`categories-${budget.id}`}>
                  {categories.map((category) => (
                    <option key={category.id} value={category.name} />
                  ))}
                </datalist>
                <Button variant="ghost" disabled={busy} onClick={() => void closeBudget(budget)}>
                  {budget.status === 'ACTIVE' ? 'Cerrar presupuesto' : 'Reactivar'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="space-y-3">
        <SectionTitle title="Crear un presupuesto" hint="Se compara con los gastos que ya registra: no hay que anotar nada aparte" />
        <Select label="Unidad" value={entityId} onChange={setEntityId} options={entities.map((entity) => ({ value: entity.id, label: entity.name }))} />
        <Field label="Nombre" value={name} onChange={setName} hint="Por ejemplo: Gastos mensuales Fulltech" />
        <Select label="Período" value={period} onChange={setPeriod} options={PERIODS} />
        <Field label="Empieza el" value={startDate} onChange={setStartDate} type="date" />

        <div className="space-y-2">
          {lines.map((line, index) => (
            <div key={`line-${index}`} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Select
                label={`Categoría ${index + 1}`}
                value={line.categoryId}
                onChange={(value) => {
                  const next = [...lines];
                  next[index] = { ...line, categoryId: value };
                  setLines(next);
                }}
                options={categoryOptions}
              />
              <MoneyInput
                label="Límite"
                value={line.limitAmount}
                onChange={(value) => {
                  const next = [...lines];
                  next[index] = { ...line, limitAmount: value };
                  setLines(next);
                }}
              />
            </div>
          ))}
          <Button variant="secondary" onClick={() => setLines([...lines, { categoryId: '', limitAmount: '' }])}>
            Añadir otra categoría
          </Button>
        </div>

        <p className="text-xs text-muted">Total presupuestado: {formatMoney(totalPlanned.toFixed(2), currency)}</p>

        <Button disabled={!canCreate || busy} onClick={() => void create()}>
          {busy ? 'Guardando…' : 'Crear presupuesto'}
        </Button>
      </Card>

      <p className="pb-4 text-center text-xs text-faint">
        Superar un presupuesto no impide registrar el gasto: se avisa y se muestra en rojo, porque el gasto ya ocurrió.
      </p>

      {/* Límite por categoría: hoja inferior con campo de importe de verdad. */}
      <Sheet
        open={allocationTarget !== null}
        onClose={() => setAllocationTarget(null)}
        title={allocationTarget ? `Límite para «${allocationTarget.category.name}»` : ''}
      >
        <div className="space-y-3 pb-3">
          <MoneyInput
            label="Límite del período"
            value={allocationAmount}
            onChange={setAllocationAmount}
            autoFocus
            size="md"
          />
          <p className="text-xs leading-snug text-muted">
            Se aplica al presupuesto «{allocationTarget?.budget.name}». Si ya existía un límite para esta categoría, se
            reemplaza.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setAllocationTarget(null)}>
              Cancelar
            </Button>
            <Button
              disabled={busy || Number(allocationAmount) <= 0}
              onClick={() => {
                if (!allocationTarget) {
                  return;
                }
                void upsertAllocation(allocationTarget.budget, allocationTarget.category.id, allocationAmount);
                setAllocationTarget(null);
              }}
            >
              Guardar límite
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
