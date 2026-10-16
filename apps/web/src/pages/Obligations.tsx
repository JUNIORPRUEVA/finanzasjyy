import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, newOperationId } from '../lib/api';
import { Badge, Button, Card, EmptyState, Field, MoneyInput, Notice, SectionTitle, Select, Spinner, Tabs } from '../components/ui';
import { useAuth } from '../store/auth';
import { formatBusinessDate, formatMoney, todayBusinessDate } from '../lib/format';

/**
 * OBLIGACIONES
 * ------------
 * Tres cosas que el usuario necesita ver juntas:
 *  · LO QUE PAGA CADA MES (recurrentes): alquiler, internet, nómina, suscripciones.
 *    Al registrar el pago se genera el movimiento real del período.
 *  · LO QUE LE DEBEN (por cobrar): abonos parciales e historial.
 *  · LO QUE DEBE (por pagar): con su vencimiento y sus abonos.
 *
 * Nada se marca como pagado «a mano»: cada abono es un movimiento financiero con
 * su asiento, y el saldo pendiente se recalcula desde esos movimientos.
 */

type TabId = 'recurring' | 'receivables' | 'payables' | 'upcoming';

interface RecurringRow {
  id: string;
  entityId: string;
  entity?: { name: string } | null;
  name: string;
  direction: string;
  amount: string;
  currency: string;
  frequency: string;
  nextDueDate: string;
  daysToDue: number;
  status: string;
}

interface ObligationRow {
  id: string;
  entityId: string;
  entity?: { name: string } | null;
  description: string;
  documentRef: string | null;
  originalAmount: string;
  settledAmount: string;
  pendingAmount: string;
  currency: string;
  issueDate: string;
  dueDate: string | null;
  status: string;
  isOverdue?: boolean;
  daysToDue?: number | null;
}

interface AccountRow {
  id: string;
  name: string;
  balance: string;
  currency: string;
  isCreditCard: boolean;
}

interface UpcomingResponse {
  window?: { days?: number };
  loans?: Array<{ id: string; name: string; direction: string; amount: string; dueDate: string | null }>;
  receivables?: Array<{ id: string; description: string; pendingAmount: string; dueDate: string | null }>;
  payables?: Array<{ id: string; description: string; pendingAmount: string; dueDate: string | null }>;
  recurrings?: Array<{ id: string; name: string; amount: string; nextDueDate: string; direction: string }>;
}

const FREQUENCY_LABELS: Record<string, string> = {
  ONE_TIME: 'Una vez',
  WEEKLY: 'Semanal',
  BIWEEKLY: 'Cada 15 días',
  MONTHLY: 'Mensual',
  QUARTERLY: 'Trimestral',
  SEMIANNUAL: 'Semestral',
  ANNUAL: 'Anual',
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pendiente',
  PARTIAL: 'Abonada en parte',
  SETTLED: 'Saldada',
  OVERDUE: 'Vencida',
  CANCELLED: 'Anulada',
  ACTIVE: 'Activa',
  PAUSED: 'En pausa',
  ENDED: 'Finalizada',
};

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: T[] }).data;
  }
  return [];
}

export function ObligationsPage() {
  const { entities, preferences } = useAuth();
  const queryClient = useQueryClient();
  const currency = preferences?.currency ?? 'DOP';
  const [tab, setTab] = useState<TabId>('recurring');
  const [message, setMessage] = useState<{ tone: 'positive' | 'warning' | 'negative'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [payDate, setPayDate] = useState(todayBusinessDate());

  const recurringQuery = useQuery<unknown>({ queryKey: ['recurring'], queryFn: () => api.get('/obligations/recurring') });
  const receivablesQuery = useQuery<unknown>({ queryKey: ['receivables'], queryFn: () => api.get('/obligations/receivables?limit=100') });
  const payablesQuery = useQuery<unknown>({ queryKey: ['payables'], queryFn: () => api.get('/obligations/payables?limit=100') });
  const upcomingQuery = useQuery<UpcomingResponse>({ queryKey: ['upcoming'], queryFn: () => api.get<UpcomingResponse>('/obligations/upcoming?days=15') });
  const accountsQuery = useQuery<unknown>({ queryKey: ['accounts-all'], queryFn: () => api.get('/accounts?limit=200') });

  const recurrings = useMemo(() => asArray<RecurringRow>(recurringQuery.data), [recurringQuery.data]);
  const receivables = useMemo(() => asArray<ObligationRow>(receivablesQuery.data), [receivablesQuery.data]);
  const payables = useMemo(() => asArray<ObligationRow>(payablesQuery.data), [payablesQuery.data]);
  const accounts = useMemo(() => asArray<AccountRow>(accountsQuery.data), [accountsQuery.data]);
  const accountOptions = accounts
    .filter((account) => !account.isCreditCard)
    .map((account) => ({ value: account.id, label: `${account.name} (${formatMoney(account.balance, account.currency)})` }));
  const entityOptions = entities.map((entity) => ({ value: entity.id, label: entity.name }));

  // Alta de obligación recurrente
  const [newEntityId, setNewEntityId] = useState('');
  const [newName, setNewName] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newFrequency, setNewFrequency] = useState('MONTHLY');
  const [newDueDate, setNewDueDate] = useState(todayBusinessDate());

  // Alta de por cobrar / por pagar
  const [newDescription, setNewDescription] = useState('');
  const [newOriginal, setNewOriginal] = useState('');
  const [newIssueDate, setNewIssueDate] = useState(todayBusinessDate());
  const [newDueDateObligation, setNewDueDateObligation] = useState('');

  const refresh = async () => {
    await queryClient.invalidateQueries();
    setActiveId(null);
    setAmount('');
  };

  const payRecurring = async (row: RecurringRow) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.post<{ message: string; alreadyPaid: boolean }>(`/obligations/recurring/${row.id}/pay`, {
        clientOperationId: newOperationId('recurring'),
        accountId,
        businessDate: payDate,
        ...(amount ? { amount } : {}),
      });
      setMessage({ tone: result.alreadyPaid ? 'warning' : 'positive', text: result.message });
      await refresh();
    } catch (caught) {
      setMessage({ tone: 'negative', text: caught instanceof ApiError ? caught.message : 'No se pudo registrar el pago.' });
    } finally {
      setBusy(false);
    }
  };

  const settle = async (kind: 'receivables' | 'payables', row: ObligationRow) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.post<{ message: string }>(`/obligations/${kind}/${row.id}/payments`, {
        clientOperationId: newOperationId('settle'),
        accountId,
        amount,
        businessDate: payDate,
      });
      setMessage({ tone: 'positive', text: result.message });
      await refresh();
    } catch (caught) {
      setMessage({ tone: 'negative', text: caught instanceof ApiError ? caught.message : 'No se pudo registrar el abono.' });
    } finally {
      setBusy(false);
    }
  };

  const createRecurring = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api.post('/obligations/recurring', {
        entityId: newEntityId,
        name: newName.trim(),
        amount: newAmount,
        frequency: newFrequency,
        nextDueDate: newDueDate,
        direction: 'PAYABLE',
      });
      setMessage({ tone: 'positive', text: 'Compromiso registrado. Aparecerá en sus avisos antes de vencer.' });
      setNewName('');
      setNewAmount('');
      await queryClient.invalidateQueries();
    } catch (caught) {
      setMessage({ tone: 'negative', text: caught instanceof ApiError ? caught.message : 'No se pudo registrar el compromiso.' });
    } finally {
      setBusy(false);
    }
  };

  const createObligation = async (kind: 'receivables' | 'payables') => {
    setBusy(true);
    setMessage(null);
    try {
      await api.post(`/obligations/${kind}`, {
        entityId: newEntityId,
        description: newDescription.trim(),
        originalAmount: newOriginal,
        issueDate: newIssueDate,
        ...(newDueDateObligation ? { dueDate: newDueDateObligation } : {}),
      });
      setMessage({
        tone: 'positive',
        text:
          kind === 'receivables'
            ? 'Registrado lo que le deben. No cuenta como ingreso hasta que se cobre de verdad.'
            : 'Registrado lo que debe. No cuenta como gasto hasta que se pague de verdad.',
      });
      setNewDescription('');
      setNewOriginal('');
      await queryClient.invalidateQueries();
    } catch (caught) {
      setMessage({ tone: 'negative', text: caught instanceof ApiError ? caught.message : 'No se pudo registrar.' });
    } finally {
      setBusy(false);
    }
  };

  const toggleRecurring = async (row: RecurringRow) => {
    setBusy(true);
    try {
      await api.patch(`/obligations/recurring/${row.id}`, { status: row.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED' });
      setMessage({
        tone: 'positive',
        text: row.status === 'PAUSED' ? 'Compromiso reactivado: volverá a avisarle.' : 'Compromiso en pausa: no avisará mientras esté así.',
      });
      await queryClient.invalidateQueries();
    } catch (caught) {
      setMessage({ tone: 'negative', text: caught instanceof ApiError ? caught.message : 'No se pudo cambiar el estado.' });
    } finally {
      setBusy(false);
    }
  };

  const renderSettleForm = (kind: 'receivables' | 'payables' | 'recurring', row: ObligationRow | RecurringRow) => (
    <div className="mt-2 space-y-2 rounded-lg border border-slate-700 p-3">
      <MoneyInput
        label={kind === 'receivables' ? 'Importe cobrado' : 'Importe pagado'}
        value={amount}
        onChange={setAmount}
        hint={
          kind === 'recurring'
            ? 'Si lo deja vacío se usa el importe del compromiso.'
            : `Pendiente: ${formatMoney((row as ObligationRow).pendingAmount, (row as ObligationRow).currency)}. Puede abonar una parte.`
        }
      />
      <Select label="Cuenta" value={accountId} onChange={setAccountId} options={accountOptions} />
      <Field label="Fecha" value={payDate} onChange={setPayDate} type="date" />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || accountId === '' || (kind !== 'recurring' && amount === '')}
          onClick={() => (kind === 'recurring' ? void payRecurring(row as RecurringRow) : void settle(kind, row as ObligationRow))}
        >
          {busy ? 'Registrando…' : 'Confirmar'}
        </Button>
        <Button variant="ghost" onClick={() => setActiveId(null)}>
          Cancelar
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <Tabs
        tabs={[
          { id: 'recurring' as TabId, label: 'Cada mes' },
          { id: 'receivables' as TabId, label: 'Me deben' },
          { id: 'payables' as TabId, label: 'Yo debo' },
          { id: 'upcoming' as TabId, label: 'Vencimientos' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'recurring' ? (
        <>
          <Card>
            <SectionTitle
              title="Compromisos de cada mes"
              hint="Al registrar el pago se crea el gasto real del período y avanza el vencimiento"
            />
            {recurringQuery.isLoading ? <Spinner /> : null}
            {recurrings.length === 0 && !recurringQuery.isLoading ? (
              <EmptyState title="Sin compromisos registrados" hint="Añada el alquiler, internet, nómina o suscripciones." />
            ) : null}
            <div className="space-y-2">
              {recurrings.map((row) => (
                <div key={row.id} className="rounded-lg border border-slate-800 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-100">{row.name}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <Badge tone={row.status === 'ACTIVE' ? 'positive' : 'neutral'}>{STATUS_LABELS[row.status] ?? row.status}</Badge>
                        <Badge tone="neutral">{FREQUENCY_LABELS[row.frequency] ?? row.frequency}</Badge>
                        {row.daysToDue <= 0 ? <Badge tone="critical">Vence hoy o ya venció</Badge> : null}
                      </div>
                      <p className="mt-1 text-xs text-slate-400">
                        Vence el {formatBusinessDate(row.nextDueDate)} · {row.daysToDue} día(s)
                      </p>
                    </div>
                    <span className="shrink-0 text-sm text-slate-100">{formatMoney(row.amount, row.currency)}</span>
                  </div>
                  {activeId === row.id ? (
                    renderSettleForm('recurring', row)
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setActiveId(row.id);
                          setAmount(row.amount);
                        }}
                      >
                        Registrar pago
                      </Button>
                      <Button variant="ghost" onClick={() => void toggleRecurring(row)}>
                        {row.status === 'PAUSED' ? 'Reactivar' : 'Pausar'}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>

          <Card className="space-y-3">
            <SectionTitle title="Añadir un compromiso" hint="Es una plantilla de aviso: no suma ningún gasto hasta que se pague" />
            <Select label="Unidad" value={newEntityId} onChange={setNewEntityId} options={entityOptions} />
            <Field label="Nombre" value={newName} onChange={setNewName} hint="Alquiler del local, Internet, Nómina, Netflix…" />
            <MoneyInput label="Importe" value={newAmount} onChange={setNewAmount} />
            <Select
              label="Cada cuánto"
              value={newFrequency}
              onChange={setNewFrequency}
              options={Object.entries(FREQUENCY_LABELS).map(([value, label]) => ({ value, label }))}
            />
            <Field label="Próximo vencimiento" value={newDueDate} onChange={setNewDueDate} type="date" />
            <Button disabled={busy || newEntityId === '' || newName.trim().length < 2 || newAmount === ''} onClick={() => void createRecurring()}>
              Registrar compromiso
            </Button>
          </Card>
        </>
      ) : null}

      {tab === 'receivables' || tab === 'payables' ? (
        <>
          <Card>
            <SectionTitle
              title={tab === 'receivables' ? 'Lo que me deben' : 'Lo que yo debo'}
              hint="No cuenta como ingreso ni como gasto hasta que el dinero se mueve de verdad"
            />
            {(tab === 'receivables' ? receivablesQuery.isLoading : payablesQuery.isLoading) ? <Spinner /> : null}
            <div className="space-y-2">
              {(tab === 'receivables' ? receivables : payables).map((row) => (
                <div key={row.id} className="rounded-lg border border-slate-800 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-100">{row.description}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <Badge
                          tone={row.status === 'SETTLED' ? 'positive' : row.isOverdue ? 'critical' : row.status === 'PARTIAL' ? 'warning' : 'neutral'}
                        >
                          {STATUS_LABELS[row.status] ?? row.status}
                        </Badge>
                        {row.entity?.name ? <Badge tone="neutral">{row.entity.name}</Badge> : null}
                        {row.isOverdue ? <Badge tone="critical">Vencida</Badge> : null}
                      </div>
                      <p className="mt-1 text-xs text-slate-400">
                        Total {formatMoney(row.originalAmount, row.currency)} · abonado{' '}
                        {formatMoney(row.settledAmount, row.currency)}
                        {row.dueDate ? ` · vence ${formatBusinessDate(row.dueDate)}` : ''}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs text-slate-500">Pendiente</p>
                      <p className="text-sm text-slate-100">{formatMoney(row.pendingAmount, row.currency)}</p>
                    </div>
                  </div>
                  {row.status !== 'SETTLED' && row.status !== 'CANCELLED' ? (
                    activeId === row.id ? (
                      renderSettleForm(tab, row)
                    ) : (
                      <Button
                        variant="secondary"
                        className="mt-2"
                        onClick={() => {
                          setActiveId(row.id);
                          setAmount(row.pendingAmount);
                        }}
                      >
                        {tab === 'receivables' ? 'Registrar cobro' : 'Registrar pago'}
                      </Button>
                    )
                  ) : null}
                </div>
              ))}
              {(tab === 'receivables' ? receivables : payables).length === 0 ? (
                <EmptyState
                  title={tab === 'receivables' ? 'No hay nada por cobrar' : 'No hay nada por pagar'}
                  hint="Cada abono que registre genera su movimiento y su asiento."
                />
              ) : null}
            </div>
          </Card>

          <Card className="space-y-3">
            <SectionTitle title={tab === 'receivables' ? 'Añadir lo que me deben' : 'Añadir lo que debo'} />
            <Select label="Unidad" value={newEntityId} onChange={setNewEntityId} options={entityOptions} />
            <Field
              label="A quién y por qué"
              value={newDescription}
              onChange={setNewDescription}
              hint={tab === 'receivables' ? 'Cliente y factura pendiente' : 'Proveedor y factura por pagar'}
            />
            <MoneyInput label="Importe" value={newOriginal} onChange={setNewOriginal} />
            <Field label="Fecha de emisión" value={newIssueDate} onChange={setNewIssueDate} type="date" />
            <Field label="Vence el (opcional)" value={newDueDateObligation} onChange={setNewDueDateObligation} type="date" />
            <Button
              disabled={busy || newEntityId === '' || newDescription.trim().length < 2 || newOriginal === ''}
              onClick={() => void createObligation(tab)}
            >
              {busy ? 'Registrando…' : 'Registrar'}
            </Button>
          </Card>
        </>
      ) : null}

      {tab === 'upcoming' ? (
        <Card>
          <SectionTitle title="Próximos 15 días" hint="Todo lo que vence, junto y en orden" />
          {upcomingQuery.isLoading ? <Spinner /> : null}
          {upcomingQuery.data ? (
            <div className="space-y-4">
              <div>
                <p className="mb-1 text-xs uppercase text-slate-400">Compromisos del mes</p>
                {(upcomingQuery.data.recurrings ?? []).length === 0 ? (
                  <p className="text-xs text-slate-500">Nada en este período.</p>
                ) : null}
                {(upcomingQuery.data.recurrings ?? []).map((row) => (
                  <div key={row.id} className="flex items-center justify-between border-b border-slate-900 py-2 text-sm">
                    <span className="text-slate-200">{row.name}</span>
                    <span className="text-slate-400">
                      {formatBusinessDate(row.nextDueDate)} · {formatMoney(row.amount, currency)}
                    </span>
                  </div>
                ))}
              </div>
              <div>
                <p className="mb-1 text-xs uppercase text-slate-400">Cuotas de préstamos</p>
                {(upcomingQuery.data.loans ?? []).length === 0 ? <p className="text-xs text-slate-500">Nada en este período.</p> : null}
                {(upcomingQuery.data.loans ?? []).map((row) => (
                  <div key={row.id} className="flex items-center justify-between border-b border-slate-900 py-2 text-sm">
                    <span className="text-slate-200">{row.name}</span>
                    <span className="text-slate-400">
                      {row.dueDate ? formatBusinessDate(row.dueDate) : 'sin fecha'} · {formatMoney(row.amount, currency)}
                    </span>
                  </div>
                ))}
              </div>
              <div>
                <p className="mb-1 text-xs uppercase text-slate-400">Por pagar</p>
                {(upcomingQuery.data.payables ?? []).length === 0 ? <p className="text-xs text-slate-500">Nada en este período.</p> : null}
                {(upcomingQuery.data.payables ?? []).map((row) => (
                  <div key={row.id} className="flex items-center justify-between border-b border-slate-900 py-2 text-sm">
                    <span className="text-slate-200">{row.description}</span>
                    <span className="text-slate-400">
                      {row.dueDate ? formatBusinessDate(row.dueDate) : 'sin fecha'} · {formatMoney(row.pendingAmount, currency)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      <p className="pb-4 text-center text-xs text-slate-600">
        Lo que le deben no es dinero disponible; lo que debe no es un gasto hasta que se paga.
      </p>
    </div>
  );
}
