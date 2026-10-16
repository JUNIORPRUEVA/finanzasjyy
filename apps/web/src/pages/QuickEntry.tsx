import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, OfflineError } from '../lib/api';
import { getCachedAccounts, getCachedCategories } from '../lib/db';
import { canOperateOffline, submitOrQueue } from '../lib/sync';
import { useAuth } from '../store/auth';
import { Badge, Button, Card, Field, MoneyInput, Notice, SectionTitle, Select, Tabs } from '../components/ui';
import { formatBusinessDate, todayBusinessDate } from '../lib/format';

type EntryKind = 'INCOME' | 'EXPENSE' | 'OWNER_WITHDRAWAL' | 'OWNER_CONTRIBUTION' | 'ADJUSTMENT';

interface Account {
  id: string;
  entityId: string;
  name: string;
  type: string;
  isCreditCard: boolean;
  balance: string;
}

interface Category {
  id: string;
  name: string;
  kind: 'INCOME' | 'EXPENSE';
}

const KIND_TABS: Array<{ id: EntryKind; label: string }> = [
  { id: 'INCOME', label: 'Ingreso' },
  { id: 'EXPENSE', label: 'Gasto' },
  { id: 'OWNER_WITHDRAWAL', label: 'Retiro' },
  { id: 'OWNER_CONTRIBUTION', label: 'Aporte' },
  { id: 'ADJUSTMENT', label: 'Ajuste' },
];

const METHOD_OPTIONS = ['EFECTIVO', 'TRANSFERENCIA', 'TARJETA', 'BIZUM', 'CHEQUE', 'DEPOSITO', 'CREDITO', 'OTRO'];

/**
 * REGISTRO RÁPIDO DE MOVIMIENTOS
 * ------------------------------
 * Objetivo: registrar un gasto común en pocos toques desde el teléfono.
 *
 * · Si hay conexión, se envía al servidor y se confirma.
 * · Si NO hay conexión, se guarda en el dispositivo (IndexedDB) con su
 *   identificador de operación y se marca como NO CONFIRMADO hasta que el
 *   servidor lo valide. La app jamás dice "guardado en el servidor" si no lo está.
 */
export function QuickEntryPage() {
  const [params] = useSearchParams();
  const { entities, preferences } = useAuth();
  const queryClient = useQueryClient();

  const initialEntity = params.get('entityId') ?? entities[0]?.id ?? '';

  const [kind, setKind] = useState<EntryKind>('EXPENSE');
  const [entityId, setEntityId] = useState(initialEntity);
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [businessDate, setBusinessDate] = useState(todayBusinessDate(preferences?.timezone));
  const [method, setMethod] = useState('EFECTIVO');
  const [adjustmentDebit, setAdjustmentDebit] = useState('');
  const [adjustmentCredit, setAdjustmentCredit] = useState('');
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [message, setMessage] = useState<{ tone: 'positive' | 'warning' | 'negative'; text: string } | null>(null);

  const [cachedAccounts, setCachedAccounts] = useState<Account[]>([]);
  const [cachedCategories, setCachedCategories] = useState<Category[]>([]);
  const [offlinePermission, setOfflinePermission] = useState<{ allowed: boolean; reason: string } | null>(null);

  const accountsQuery = useQuery<Account[]>({
    queryKey: ['accounts', entityId],
    queryFn: () => api.get<Account[]>(`/accounts?entityId=${entityId}`),
    enabled: Boolean(entityId),
  });

  const categoriesQuery = useQuery<Category[]>({
    queryKey: ['categories', entityId, kind],
    queryFn: () =>
      api.get<Category[]>(
        `/categories?entityId=${entityId}&kind=${kind === 'INCOME' ? 'INCOME' : kind === 'EXPENSE' ? 'EXPENSE' : ''}`,
      ),
    enabled: Boolean(entityId) && (kind === 'INCOME' || kind === 'EXPENSE'),
  });

  // Si no hay red, se usan las copias locales para poder registrar igualmente.
  useEffect(() => {
    void (async () => {
      setCachedAccounts(await getCachedAccounts(entityId));
      setCachedCategories(await getCachedCategories());
      setOfflinePermission(await canOperateOffline());
    })();
  }, [entityId, accountsQuery.dataUpdatedAt, categoriesQuery.dataUpdatedAt]);

  const accounts = accountsQuery.data ?? cachedAccounts;
  const categories = useMemo(() => {
    const source = categoriesQuery.data ?? cachedCategories;
    if (kind === 'INCOME') {
      return source.filter((category) => category.kind === 'INCOME');
    }
    if (kind === 'EXPENSE') {
      return source.filter((category) => category.kind === 'EXPENSE');
    }
    return [];
  }, [categoriesQuery.data, cachedCategories, kind]);

  useEffect(() => {
    if (!accountId && accounts.length > 0) {
      setAccountId(accounts[0].id);
    }
  }, [accounts, accountId]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const entity = entities.find((item) => item.id === entityId);

      const payload: Record<string, unknown> = {
        entityId,
        kind,
        accountId,
        amount,
        businessDate,
        description: description.trim(),
      };

      if (kind === 'INCOME' || kind === 'EXPENSE') {
        payload.categoryId = categoryId || undefined;
        payload.method = method;
      }
      if (kind === 'ADJUSTMENT') {
        payload.adjustmentDebitCode = adjustmentDebit;
        payload.adjustmentCreditCode = adjustmentCredit;
        payload.adjustmentReason = adjustmentReason;
      }

      return submitOrQueue({
        type: 'TRANSACTION',
        payload,
        summary: description.trim() || kind,
        amount,
        entityId,
        entityName: entity?.name ?? null,
      });
    },
    onSuccess: (result) => {
      if (result.sentNow) {
        setMessage({ tone: 'positive', text: 'Movimiento registrado y confirmado por el servidor.' });
      } else if (result.error) {
        setMessage({
          tone: 'negative',
          text: `El servidor lo rechazó: ${result.error} Quedó guardado en el dispositivo para que pueda corregirlo.`,
        });
      } else {
        setMessage({
          tone: 'warning',
          text: 'Guardado en este dispositivo SIN CONFIRMAR. Se enviará automáticamente cuando haya conexión.',
        });
      }

      setAmount('');
      setDescription('');
      void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
    onError: (error) => {
      if (error instanceof OfflineError) {
        setMessage({ tone: 'negative', text: error.message });
        return;
      }
      setMessage({
        tone: 'negative',
        text: error instanceof ApiError ? error.message : 'No se pudo registrar el movimiento.',
      });
    },
  });

  const canSubmit =
    Boolean(entityId && accountId && amount) &&
    description.trim().length >= 2 &&
    (kind !== 'ADJUSTMENT' || (adjustmentDebit.length === 4 && adjustmentCredit.length === 4 && adjustmentReason.length >= 5));

  return (
    <div className="space-y-4">
      <Tabs tabs={KIND_TABS} active={kind} onChange={setKind} />

      {offlinePermission && !offlinePermission.allowed ? (
        <Notice tone="warning" title="Trabajo sin conexión no disponible">
          {offlinePermission.reason}
        </Notice>
      ) : null}

      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <Card className="space-y-4">
        <MoneyInput
          label={kind === 'INCOME' ? '¿Cuánto entró?' : kind === 'EXPENSE' ? '¿Cuánto salió?' : 'Importe'}
          value={amount}
          onChange={setAmount}
          autoFocus
          hint="Escriba sólo números; use el punto para los centavos."
        />

        <Select
          label="Unidad financiera"
          value={entityId}
          onChange={setEntityId}
          options={entities.map((entity) => ({ value: entity.id, label: `${entity.name} (${entity.code})` }))}
        />

        <Select
          label="Cuenta"
          value={accountId}
          onChange={setAccountId}
          options={accounts.map((account) => ({
            value: account.id,
            label: `${account.name}${account.isCreditCard ? ' (tarjeta de crédito)' : ''} · ${account.balance}`,
          }))}
        />

        {kind === 'INCOME' || kind === 'EXPENSE' ? (
          <Select
            label="Categoría"
            value={categoryId}
            onChange={setCategoryId}
            options={categories.map((category) => ({ value: category.id, label: category.name }))}
            placeholder="— Sin categoría (se usará «Otros») —"
          />
        ) : null}

        <Field
          label="Descripción"
          value={description}
          onChange={setDescription}
          placeholder={kind === 'EXPENSE' ? 'Ej.: Combustible del carro' : 'Ej.: Venta de servicio'}
        />

        <Field label="Fecha" value={businessDate} onChange={setBusinessDate} type="date" />

        {kind === 'INCOME' || kind === 'EXPENSE' ? (
          <Select
            label="Método"
            value={method}
            onChange={setMethod}
            options={METHOD_OPTIONS.map((option) => ({ value: option, label: option }))}
          />
        ) : null}

        {kind === 'OWNER_WITHDRAWAL' ? (
          <Notice tone="neutral">
            Un retiro del propietario <strong>no es un gasto del negocio</strong>: baja el patrimonio y aparece en su
            informe de retiros.
          </Notice>
        ) : null}

        {kind === 'OWNER_CONTRIBUTION' ? (
          <Notice tone="neutral">
            Un aporte de capital <strong>no es un ingreso</strong>: entra dinero y sube el patrimonio.
          </Notice>
        ) : null}

        {kind === 'ADJUSTMENT' ? (
          <div className="space-y-3">
            <Notice tone="warning">
              Un ajuste corrige un saldo <strong>dejando rastro</strong>. Indique qué cuenta se carga y cuál se abona, y
              el motivo.
            </Notice>
            <Field label="Cuenta que se carga (4 dígitos)" value={adjustmentDebit} onChange={setAdjustmentDebit} placeholder="8010" />
            <Field label="Cuenta que se abona (4 dígitos)" value={adjustmentCredit} onChange={setAdjustmentCredit} placeholder="1010" />
            <Field label="Motivo del ajuste" value={adjustmentReason} onChange={setAdjustmentReason} placeholder="Ej.: Faltante detectado en el cierre" />
          </div>
        ) : null}

        <Button
          className="w-full"
          disabled={!canSubmit || createMutation.isPending}
          onClick={() => createMutation.mutate()}
        >
          {createMutation.isPending ? 'Registrando…' : 'Registrar movimiento'}
        </Button>

        <p className="text-center text-xs text-slate-500">
          Fecha de negocio: {formatBusinessDate(businessDate)} · Zona {preferences?.timezone ?? 'America/Santo_Domingo'}
        </p>
      </Card>

      <Card>
        <SectionTitle title="Cuentas disponibles" hint="Saldos calculados desde el libro mayor" />
        <div className="space-y-1">
          {accounts.map((account) => (
            <div key={account.id} className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 truncate text-slate-300">
                {account.name}
                {account.isCreditCard ? <Badge tone="warning">pasivo</Badge> : null}
              </span>
              <span className="money text-slate-200">{account.balance}</span>
            </div>
          ))}
          {accounts.length === 0 ? <p className="text-sm text-slate-500">No hay cuentas en esta unidad.</p> : null}
        </div>
      </Card>
    </div>
  );
}
