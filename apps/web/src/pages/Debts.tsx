import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, newOperationId } from '../lib/api';
import { Badge, Button, Card, EmptyState, Field, MoneyInput, Notice, SectionTitle, Select, Spinner } from '../components/ui';
import { useAuth } from '../store/auth';
import { formatBusinessDate, formatMoney, todayBusinessDate } from '../lib/format';

/**
 * PRÉSTAMOS Y DEUDAS
 * ------------------
 * Lo que debo (pasivo) y lo que me deben (activo) como préstamos formales, más
 * las tarjetas de crédito.
 *
 * Reglas que la pantalla refleja y explica:
 *  · El capital pendiente es DEUDA: no es un ingreso cuando entra, ni un gasto
 *    cuando se devuelve.
 *  · Al pagar una cuota, el sistema separa intereses (gasto real) de capital
 *    (reduce la deuda). Si no se conocen los intereses, los calcula el servidor.
 *  · Un préstamo recibido NO es una ganancia: por eso, si el dinero ya está
 *    declarado en el saldo de una cuenta, no se vuelve a sumar.
 */

interface LoanRow {
  id: string;
  entityId: string;
  entity?: { id: string; name: string } | null;
  direction: string;
  name: string;
  principalAmount: string;
  currentBalance: string;
  currency: string;
  annualRatePct: string | null;
  paymentFrequency: string;
  installmentAmount: string | null;
  nextDueDate: string | null;
  status: string;
  paymentCount: number;
  isLiability: boolean;
}

interface LoanSummary {
  totalDebt: string;
  totalReceivable: string;
  netPosition: string;
  activeLoans: number;
  overdueCount: number;
  dueSoonCount: number;
  dueSoon: Array<{ id: string; name: string; direction: string; amount: string; dueDate: string | null; daysRemaining: number | null }>;
}

interface AccountRow {
  id: string;
  entityId: string;
  name: string;
  balance: string;
  currency: string;
  isCreditCard: boolean;
}

const FREQUENCIES = [
  { value: 'MONTHLY', label: 'Mensual' },
  { value: 'BIWEEKLY', label: 'Cada 15 días' },
  { value: 'WEEKLY', label: 'Semanal' },
  { value: 'QUARTERLY', label: 'Trimestral' },
  { value: 'ANNUAL', label: 'Anual' },
];

/** Normaliza listas que pueden llegar como array o envueltas en `{ data }`. */
function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: T[] }).data;
  }
  return [];
}

export function DebtsPage() {
  const { entities, preferences } = useAuth();
  const queryClient = useQueryClient();
  const currency = preferences?.currency ?? 'DOP';

  const loansQuery = useQuery<unknown>({
    queryKey: ['loans'],
    queryFn: () => api.get('/loans?limit=100'),
  });
  const summaryQuery = useQuery<LoanSummary>({
    queryKey: ['loans-summary'],
    queryFn: () => api.get<LoanSummary>('/loans/summary'),
  });
  const accountsQuery = useQuery<unknown>({
    queryKey: ['accounts-all'],
    queryFn: () => api.get('/accounts'),
  });

  const loans = useMemo(() => asArray<LoanRow>(loansQuery.data), [loansQuery.data]);
  const accounts = useMemo(() => asArray<AccountRow>(accountsQuery.data), [accountsQuery.data]);
  const creditCards = accounts.filter((account) => account.isCreditCard);

  const [message, setMessage] = useState<{ tone: 'positive' | 'warning' | 'negative'; text: string } | null>(null);
  const [payingLoanId, setPayingLoanId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payAccountId, setPayAccountId] = useState('');
  const [payDate, setPayDate] = useState(todayBusinessDate());
  const [busy, setBusy] = useState(false);

  // Alta de préstamo
  const [newEntityId, setNewEntityId] = useState('');
  const [newDirection, setNewDirection] = useState<'PAYABLE' | 'RECEIVABLE'>('PAYABLE');
  const [newName, setNewName] = useState('');
  const [newPrincipal, setNewPrincipal] = useState('');
  const [newRate, setNewRate] = useState('');
  const [newInstallment, setNewInstallment] = useState('');
  const [newFrequency, setNewFrequency] = useState('MONTHLY');
  const [newStartDate, setNewStartDate] = useState(todayBusinessDate());
  const [newAccountId, setNewAccountId] = useState('');

  const entityOptions = entities.map((entity) => ({ value: entity.id, label: entity.name }));
  const bankAccounts = accounts.filter((account) => !account.isCreditCard);
  const accountOptions = bankAccounts.map((account) => ({
    value: account.id,
    label: `${account.name} (${formatMoney(account.balance, account.currency)})`,
  }));

  const registerPayment = async (loan: LoanRow) => {
    setMessage(null);
    setBusy(true);
    try {
      await api.post(`/loans/${loan.id}/payments`, {
        clientOperationId: newOperationId('loanpay'),
        totalAmount: payAmount,
        accountId: payAccountId,
        businessDate: payDate,
      });
      setMessage({
        tone: 'positive',
        text: `Pago registrado en «${loan.name}». El servidor reparte capital e intereses: los intereses son gasto, el capital reduce la deuda.`,
      });
      setPayingLoanId(null);
      setPayAmount('');
      await queryClient.invalidateQueries();
    } catch (caught) {
      setMessage({ tone: 'negative', text: caught instanceof ApiError ? caught.message : 'No se pudo registrar el pago.' });
    } finally {
      setBusy(false);
    }
  };

  const createLoan = async () => {
    setMessage(null);
    setBusy(true);
    try {
      await api.post('/loans', {
        entityId: newEntityId,
        direction: newDirection,
        name: newName.trim(),
        principalAmount: newPrincipal,
        startDate: newStartDate,
        paymentFrequency: newFrequency,
        ...(newRate ? { annualRatePct: newRate } : {}),
        ...(newInstallment ? { installmentAmount: newInstallment } : {}),
        ...(newAccountId ? { accountId: newAccountId } : {}),
      });
      setMessage({
        tone: 'positive',
        text: newAccountId
          ? 'Deuda registrada y dinero ingresado en la cuenta indicada. El ingreso NO cuenta como venta: es un pasivo que hay que devolver.'
          : 'Deuda registrada sin mover dinero. Úselo cuando el dinero ya esté declarado en el saldo de una cuenta.',
      });
      setNewName('');
      setNewPrincipal('');
      setNewRate('');
      setNewInstallment('');
      await queryClient.invalidateQueries();
    } catch (caught) {
      setMessage({ tone: 'negative', text: caught instanceof ApiError ? caught.message : 'No se pudo registrar la deuda.' });
    } finally {
      setBusy(false);
    }
  };

  const payCreditCard = async (account: AccountRow) => {
    setMessage(null);
    setBusy(true);
    try {
      const payload = {
        entityId: account.entityId,
        kind: 'CREDIT_CARD_PAYMENT',
        accountId: payAccountId,
        amount: payAmount,
        businessDate: payDate,
        description: `Pago de tarjeta: ${account.name}`,
      };
      await api.post('/transactions', { ...payload, clientOperationId: newOperationId('ccpay') });
      setMessage({
        tone: 'positive',
        text: 'Pago de tarjeta registrado. Reduce la deuda (cuenta 2210) y NO se cuenta como gasto dos veces.',
      });
      setPayingLoanId(null);
      setPayAmount('');
      await queryClient.invalidateQueries();
    } catch (caught) {
      setMessage({ tone: 'negative', text: caught instanceof ApiError ? caught.message : 'No se pudo pagar la tarjeta.' });
    } finally {
      setBusy(false);
    }
  };

  const summary = summaryQuery.data;
  const canCreate = newEntityId !== '' && newName.trim().length >= 2 && newPrincipal !== '' && Number(newPrincipal) > 0;

  return (
    <div className="space-y-4">
      {summary ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Card>
            <p className="text-xs uppercase text-muted">Total que debo</p>
            <p className="text-xl font-semibold text-negative">{formatMoney(summary.totalDebt, currency)}</p>
            <p className="mt-1 text-xs text-faint">Capital pendiente de préstamos y deudas.</p>
          </Card>
          <Card>
            <p className="text-xs uppercase text-muted">Total que me deben</p>
            <p className="text-xl font-semibold text-positive">{formatMoney(summary.totalReceivable, currency)}</p>
            <p className="mt-1 text-xs text-faint">No es dinero disponible: todavía no está en caja.</p>
          </Card>
          <Card>
            <p className="text-xs uppercase text-muted">Posición neta</p>
            <p className="text-xl font-semibold text-ink">{formatMoney(summary.netPosition, currency)}</p>
            <p className="mt-1 text-xs text-faint">
              {summary.overdueCount} vencido(s) · {summary.dueSoonCount} por vencer
            </p>
          </Card>
        </div>
      ) : null}

      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <Card className="space-y-3">
        <SectionTitle title="Préstamos y deudas" hint="Toque una deuda para registrar el pago de una cuota" />
        {loansQuery.isLoading ? <Spinner /> : null}
        {/* Sin conexión y sin copia guardada, «no hay deudas» sería falso: lo que
            pasa es que no se pudo preguntar. Se dice así. */}
        {loansQuery.isError && !loansQuery.data ? (
          <EmptyState
            title="No se pudieron consultar las deudas"
            hint="Este dispositivo todavía no tiene una copia de sus préstamos. Conéctese una vez para descargarla y después podrá consultarlas sin internet."
            action={
              <Button variant="secondary" onClick={() => void loansQuery.refetch()}>
                Reintentar
              </Button>
            }
          />
        ) : null}
        {loans.length === 0 && !loansQuery.isLoading && !loansQuery.isError ? (
          <EmptyState
            title="No hay deudas registradas"
            hint="Registre abajo un préstamo o una tarjeta."
          />
        ) : null}

        <div className="space-y-2">
          {loans.map((loan) => {
            const overdue = loan.nextDueDate ? new Date(loan.nextDueDate) < new Date() : false;
            return (
              <div key={loan.id} className="rounded-lg border border-border-soft p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{loan.name}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Badge tone={loan.isLiability ? 'negative' : 'positive'}>
                        {loan.isLiability ? 'Yo debo' : 'Me deben'}
                      </Badge>
                      <Badge tone="neutral">{loan.entity?.name ?? 'unidad'}</Badge>
                      {loan.annualRatePct ? <Badge tone="neutral">{loan.annualRatePct}% anual</Badge> : null}
                      {overdue && loan.status === 'ACTIVE' ? <Badge tone="critical">Vencido</Badge> : null}
                    </div>
                    <p className="mt-2 text-xs text-muted">
                      Capital pendiente: {formatMoney(loan.currentBalance, loan.currency)} de{' '}
                      {formatMoney(loan.principalAmount, loan.currency)}
                      {loan.installmentAmount ? ` · cuota ${formatMoney(loan.installmentAmount, loan.currency)}` : ''}
                      {loan.nextDueDate ? ` · vence ${formatBusinessDate(loan.nextDueDate)}` : ''}
                    </p>
                    <p className="text-xs text-faint">{loan.paymentCount} pago(s) registrado(s)</p>
                  </div>
                </div>

                {loan.status === 'ACTIVE' ? (
                  <div className="mt-2">
                    {payingLoanId === loan.id ? (
                      <div className="space-y-2 rounded-lg border border-border-soft p-3">
                        <MoneyInput
                          label="Importe pagado"
                          value={payAmount}
                          onChange={setPayAmount}
                          hint="Si conoce el reparto, indíquelo al registrar; si no, el sistema calcula intereses y capital."
                        />
                        <Select label="Desde qué cuenta" value={payAccountId} onChange={setPayAccountId} options={accountOptions} />
                        <Field label="Fecha" value={payDate} onChange={setPayDate} type="date" />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            disabled={busy || payAmount === '' || payAccountId === ''}
                            onClick={() => void registerPayment(loan)}
                          >
                            {busy ? 'Registrando…' : 'Confirmar pago'}
                          </Button>
                          <Button variant="ghost" onClick={() => setPayingLoanId(null)}>
                            Cancelar
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setPayingLoanId(loan.id);
                          setPayAmount(loan.installmentAmount ?? '');
                        }}
                      >
                        Registrar pago de cuota
                      </Button>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>

      {creditCards.length > 0 ? (
        <Card className="space-y-3">
          <SectionTitle title="Tarjetas de crédito" hint="Es deuda: reduce el patrimonio, no es dinero disponible" />
          {creditCards.map((card) => (
            <div key={card.id} className="rounded-lg border border-border-soft p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-ink">{card.name}</p>
                  <p className="text-xs text-muted">
                    Deuda actual: {formatMoney(card.balance, card.currency)}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPayingLoanId(card.id);
                    setPayAmount('');
                  }}
                >
                  Pagar
                </Button>
              </div>
              {payingLoanId === card.id ? (
                <div className="mt-2 space-y-2 rounded-lg border border-border-soft p-3">
                  <MoneyInput label="Importe a pagar" value={payAmount} onChange={setPayAmount} />
                  <Select label="Desde qué cuenta se paga" value={payAccountId} onChange={setPayAccountId} options={accountOptions} />
                  <Field label="Fecha" value={payDate} onChange={setPayDate} type="date" />
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy || payAmount === '' || payAccountId === ''} onClick={() => void payCreditCard(card)}>
                      {busy ? 'Registrando…' : 'Confirmar pago'}
                    </Button>
                    <Button variant="ghost" onClick={() => setPayingLoanId(null)}>
                      Cancelar
                    </Button>
                  </div>
                  <p className="text-xs text-faint">
                    El pago baja la deuda de tarjetas de esa unidad (cuenta 2210) y sale del dinero de la cuenta elegida. No
                    se vuelve a contar como gasto.
                  </p>
                </div>
              ) : null}
            </div>
          ))}
        </Card>
      ) : null}

      <Card className="space-y-3">
        <SectionTitle title="Registrar una deuda o un préstamo" hint="Con lo que ya debe hoy, no con lo que va a deber" />
        <Select label="Unidad financiera" value={newEntityId} onChange={setNewEntityId} options={entityOptions} />
        <Select
          label="Naturaleza"
          value={newDirection}
          onChange={(value) => setNewDirection(value as 'PAYABLE' | 'RECEIVABLE')}
          options={[
            { value: 'PAYABLE', label: 'Yo debo (deuda mía)' },
            { value: 'RECEIVABLE', label: 'Me deben (préstamo que otorgué)' },
          ]}
        />
        <Field label="Descripción" value={newName} onChange={setNewName} hint="Por ejemplo: Préstamo del Banco BHD a 24 meses" />
        <MoneyInput label="Capital pendiente" value={newPrincipal} onChange={setNewPrincipal} />
        <MoneyInput label="Cuota (opcional)" value={newInstallment} onChange={setNewInstallment} />
        <Field
          label="Tasa anual % (opcional)"
          value={newRate}
          onChange={setNewRate}
          hint="Si no la conoce, déjela vacía: no se inventa ninguna tasa."
        />
        <Select label="Frecuencia de pago" value={newFrequency} onChange={setNewFrequency} options={FREQUENCIES} />
        <Field label="Fecha de inicio" value={newStartDate} onChange={setNewStartDate} type="date" />
        <Select
          label="¿Ya recibió el dinero en alguna cuenta? (opcional)"
          value={newAccountId}
          onChange={setNewAccountId}
          options={accountOptions}
          placeholder="— No, el dinero ya está contado en el saldo —"
        />
        <Notice tone="neutral" title="Para no contar el dinero dos veces">
          Si el dinero recibido <strong>ya está incluido</strong> en el saldo de una cuenta (porque esa cuenta ya tenía
          ese saldo), deje la última casilla vacía: así sólo se registra la deuda. Si el préstamo acaba de entrar y el
          saldo de la cuenta todavía no lo incluye, elija la cuenta y el sistema lo ingresará.
        </Notice>
        <Button disabled={!canCreate || busy} onClick={() => void createLoan()}>
          {busy ? 'Registrando…' : 'Registrar deuda'}
        </Button>
      </Card>

      <p className="pb-4 text-center text-xs text-faint">
        Un préstamo recibido no es una ganancia, y devolver capital no es un gasto: sólo los intereses son gasto real.
      </p>
    </div>
  );
}
