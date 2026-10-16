import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../store/auth';
import { Badge, Button, Card, Field, Money, MoneyInput, Notice, SectionTitle, Select, Spinner } from '../components/ui';
import { todayBusinessDate } from '../lib/format';

interface Account {
  id: string;
  entityId: string;
  name: string;
  type: string;
  currency: string;
  status: string;
  isCreditCard: boolean;
  isLiability: boolean;
  openingBalance: string;
  openingDate: string;
  creditLimit: string | null;
  balance: string;
  movementCount: number;
  entity?: { id: string; code: string; name: string };
}

const ACCOUNT_TYPES = [
  { value: 'CASH', label: 'Efectivo' },
  { value: 'BUSINESS_CASH', label: 'Caja de negocio' },
  { value: 'BANK', label: 'Banco' },
  { value: 'CHECKING', label: 'Cuenta corriente' },
  { value: 'SAVINGS', label: 'Cuenta de ahorro' },
  { value: 'DIGITAL_WALLET', label: 'Billetera digital' },
  { value: 'MERCHANT', label: 'Procesador de pagos' },
  { value: 'CREDIT_CARD', label: 'Tarjeta de crédito (pasivo)' },
  { value: 'OTHER', label: 'Otro' },
];

/**
 * CUENTAS: DÓNDE ESTÁ REALMENTE EL DINERO
 * ---------------------------------------
 * · Los saldos son CALCULADOS (saldo inicial + movimientos contables).
 * · Las tarjetas de crédito se muestran aparte: son DEUDA, no dinero disponible.
 * · El saldo inicial sólo se puede corregir mientras la cuenta no tenga
 *   movimientos; después hace falta un ajuste auditado.
 */
export function AccountsPage() {
  const [params] = useSearchParams();
  const { entities, preferences } = useAuth();
  const queryClient = useQueryClient();
  const currency = preferences?.currency ?? 'DOP';

  const [creating, setCreating] = useState(false);
  const [entityId, setEntityId] = useState(params.get('entityId') ?? entities[0]?.id ?? '');
  const [name, setName] = useState('');
  const [type, setType] = useState('CASH');
  const [openingBalance, setOpeningBalance] = useState('');
  const [openingDate, setOpeningDate] = useState(todayBusinessDate(preferences?.timezone));
  const [creditLimit, setCreditLimit] = useState('');
  const [message, setMessage] = useState<{ tone: 'positive' | 'negative'; text: string } | null>(null);

  const accountsQuery = useQuery<Account[]>({
    queryKey: ['accounts', params.get('entityId') ?? ''],
    queryFn: () =>
      api.get<Account[]>(`/accounts?${params.get('entityId') ? `entityId=${params.get('entityId')}&` : ''}includeClosed=true`),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post('/accounts', {
        entityId,
        name: name.trim(),
        type,
        openingBalance: openingBalance || '0',
        openingDate,
        isCreditCard: type === 'CREDIT_CARD',
        creditLimit: type === 'CREDIT_CARD' && creditLimit ? creditLimit : undefined,
      }),
    onSuccess: () => {
      setMessage({ tone: 'positive', text: 'Cuenta creada. El saldo inicial queda documentado.' });
      setName('');
      setOpeningBalance('');
      setCreditLimit('');
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (error) => {
      setMessage({
        tone: 'negative',
        text: error instanceof ApiError ? error.message : 'No se pudo crear la cuenta.',
      });
    },
  });

  if (accountsQuery.isLoading) {
    return <Spinner label="Cargando cuentas…" />;
  }

  const accounts = accountsQuery.data ?? [];
  const assets = accounts.filter((account) => !account.isLiability);
  const liabilities = accounts.filter((account) => account.isLiability);

  const totalAssets = assets.reduce((acc, account) => acc + Number(account.balance), 0);
  const totalLiabilities = liabilities.reduce((acc, account) => acc + Number(account.balance), 0);

  return (
    <div className="space-y-4">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <Card>
        <SectionTitle title="Resumen" hint="El dinero disponible NO incluye tarjetas ni cuentas por cobrar" />
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <p className="text-xs uppercase text-slate-400">Disponible</p>
            <p className="text-lg font-semibold">
              <Money value={totalAssets.toFixed(2)} tone="positive" currency={currency} />
            </p>
          </div>
          <div>
            <p className="text-xs uppercase text-slate-400">Deudas de cuentas</p>
            <p className="text-lg font-semibold">
              <Money value={totalLiabilities.toFixed(2)} tone="negative" currency={currency} />
            </p>
          </div>
          <div>
            <p className="text-xs uppercase text-slate-400">Cuentas</p>
            <p className="text-lg font-semibold text-slate-200">{accounts.length}</p>
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle
          title="Cuentas"
          right={
            <Button variant="secondary" onClick={() => setCreating((value) => !value)}>
              {creating ? 'Cancelar' : 'Nueva cuenta'}
            </Button>
          }
        />

        {creating ? (
          <div className="mb-4 space-y-3 rounded-lg border border-slate-800 p-3">
            <Select
              label="Unidad financiera"
              value={entityId}
              onChange={setEntityId}
              options={entities.map((entity) => ({ value: entity.id, label: entity.name }))}
            />
            <Field label="Nombre de la cuenta" value={name} onChange={setName} placeholder="Ej.: Banco Popular — corriente" />
            <Select label="Tipo" value={type} onChange={setType} options={ACCOUNT_TYPES} />
            <MoneyInput
              label="Saldo inicial documentado"
              value={openingBalance}
              onChange={setOpeningBalance}
              hint="El que figura hoy en el banco o en la caja. Si no lo sabe, déjelo en 0."
            />
            <Field label="Fecha del saldo inicial" value={openingDate} onChange={setOpeningDate} type="date" />
            {type === 'CREDIT_CARD' ? (
              <MoneyInput label="Límite de crédito" value={creditLimit} onChange={setCreditLimit} hint="Opcional" />
            ) : null}
            <Button
              className="w-full"
              disabled={!entityId || name.trim().length < 2 || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? 'Creando…' : 'Crear cuenta'}
            </Button>
          </div>
        ) : null}

        <div className="space-y-3">
          {accounts.map((account) => (
            <div key={account.id} className="rounded-lg border border-slate-800 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate text-sm font-medium text-slate-200">
                    {account.name}
                    {account.isLiability ? <Badge tone="warning">pasivo</Badge> : <Badge tone="positive">activo</Badge>}
                    {account.status !== 'ACTIVE' ? <Badge tone="neutral">{account.status}</Badge> : null}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {account.entity?.name} · {account.type} · {account.movementCount} movimiento(s)
                  </p>
                </div>
                <div className="text-right">
                  <Money value={account.balance} currency={account.currency} tone={account.isLiability ? 'negative' : 'positive'} />
                  <p className="text-xs text-slate-500">inicial {account.openingBalance}</p>
                </div>
              </div>
            </div>
          ))}
          {accounts.length === 0 ? (
            <p className="text-sm text-slate-500">
              Todavía no hay cuentas. Cree la primera con el dinero que tiene hoy disponible.
            </p>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
