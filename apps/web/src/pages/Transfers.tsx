import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { submitOrQueue } from '../lib/sync';
import { Badge, Button, Card, EmptyState, Field, MoneyInput, Notice, SectionTitle, Select, Spinner } from '../components/ui';
import { useAuth } from '../store/auth';
import { formatBusinessDate, formatMoney, todayBusinessDate } from '../lib/format';

/**
 * TRASPASOS Y TRANSFERENCIAS
 * --------------------------
 * Mueve dinero entre cuentas de la misma unidad o entre negocios distintos.
 *
 * Reglas contables que la pantalla explica en lugar de esconder:
 *  · Un traspaso NO es una venta: el sistema lo registra con la cuenta puente
 *    1150 y el mismo asiento, así que el consolidado no infla los ingresos.
 *  · El dinero sólo se mueve si sale de una cuenta y entra en otra.
 *  · Si no hay conexión, el traspaso se guarda en el dispositivo y se envía
 *    después, sin duplicarse (lleva un identificador único de operación).
 */

interface AccountRow {
  id: string;
  entityId: string;
  entity?: { id: string; name: string; code: string } | null;
  name: string;
  type: string;
  currency: string;
  balance: string;
  isCreditCard: boolean;
}

interface AccountsResponse {
  data: AccountRow[];
  meta?: { total: number };
}

interface TransferRow {
  id: string;
  amount: string;
  currency: string;
  businessDate: string;
  description: string;
  fromAccount?: { id: string; name: string; entityId: string } | null;
  toAccount?: { id: string; name: string; entityId: string } | null;
  isIntercompany?: boolean;
  reference?: string | null;
}

interface TransfersResponse {
  data: TransferRow[];
  meta?: { total: number };
}

export function TransfersPage() {
  const { entities, preferences } = useAuth();
  const queryClient = useQueryClient();
  const currency = preferences?.currency ?? 'DOP';

  const accountsQuery = useQuery<AccountsResponse>({
    queryKey: ['accounts-all'],
    queryFn: () => api.get<AccountsResponse>('/accounts'),
  });

  const transfersQuery = useQuery<TransfersResponse>({
    queryKey: ['transfers'],
    queryFn: () => api.get<TransfersResponse>('/transfers?limit=30'),
  });

  const [fromAccountId, setFromAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [businessDate, setBusinessDate] = useState(todayBusinessDate());
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'positive' | 'warning' | 'negative'; text: string } | null>(null);

  // `?? []` dentro de un useMemo: si se dejara en línea, cada render crearía un
  // array nuevo y la lista agrupada de abajo se recalcularía sin motivo.
  const accounts = useMemo(() => accountsQuery.data?.data ?? [], [accountsQuery.data]);

  // Las cuentas se agrupan por unidad financiera: al elegir origen y destino se
  // ve de inmediato si el traspaso cruza de un negocio a otro.
  const accountOptions = useMemo(() => {
    const byEntity = new Map<string, AccountRow[]>();
    for (const account of accounts) {
      const key = account.entityId;
      byEntity.set(key, [...(byEntity.get(key) ?? []), account]);
    }
    return [...byEntity.entries()].map(([entityId, rows]) => ({
      label: entities.find((entity) => entity.id === entityId)?.name ?? 'Unidad',
      options: rows.map((row) => ({
        value: row.id,
        label: `${row.name} (${formatMoney(row.balance, row.currency)})`,
      })),
    }));
  }, [accounts, entities]);

  const fromAccount = accounts.find((account) => account.id === fromAccountId);
  const toAccount = accounts.find((account) => account.id === toAccountId);
  const isIntercompany = Boolean(fromAccount && toAccount && fromAccount.entityId !== toAccount.entityId);
  const sameAccount = Boolean(fromAccountId) && fromAccountId === toAccountId;

  const availableBalance = fromAccount ? Number(fromAccount.balance) : 0;
  const exceedsBalance =
    fromAccount !== undefined && amount !== '' && Number(amount) > availableBalance && !fromAccount.isCreditCard;

  const submit = async () => {
    setMessage(null);
    setBusy(true);
    try {
      const payload = {
        fromAccountId,
        toAccountId,
        amount,
        businessDate,
        description: description.trim(),
        ...(reference.trim() ? { description: `${description.trim()} (ref. ${reference.trim()})` } : {}),
      };

      const result = await submitOrQueue({
        type: 'TRANSFER',
        payload,
        summary: isIntercompany
          ? `Traspaso entre negocios: ${formatMoney(amount, currency)}`
          : `Traspaso: ${formatMoney(amount, currency)}`,
        amount,
        entityId: fromAccount?.entityId ?? '',
        entityName: fromAccount?.entity?.name ?? null,
      });

      if (result.queued) {
        setMessage({
          tone: 'warning',
          text: 'Guardado en este dispositivo. Se enviará al recuperar la conexión y entonces quedará confirmado.',
        });
      } else {
        setMessage({
          tone: 'positive',
          text: isIntercompany
            ? 'Traspaso confirmado entre negocios. Se ha contabilizado con la cuenta puente, así que NO cuenta como ingreso en ninguna de las dos unidades.'
            : 'Traspaso confirmado. El asiento está cuadrado y el mismo asiento respalda la salida y la entrada.',
        });
      }

      setAmount('');
      setDescription('');
      setReference('');
      await queryClient.invalidateQueries();
    } catch (caught) {
      setMessage({
        tone: 'negative',
        text: caught instanceof ApiError ? caught.message : 'No se pudo registrar el traspaso.',
      });
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    fromAccountId !== '' &&
    toAccountId !== '' &&
    !sameAccount &&
    amount !== '' &&
    Number(amount) > 0 &&
    description.trim().length >= 2 &&
    !busy;

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <SectionTitle
          title="Traspaso entre cuentas"
          hint="Mueva dinero del banco a la caja, entre negocios, o entre una cuenta y otra"
        />

        {accountsQuery.isLoading ? <Spinner label="Cargando cuentas…" /> : null}

        {accounts.length === 0 && !accountsQuery.isLoading ? (
          <EmptyState
            title="Todavía no hay cuentas"
            hint="Cree sus cuentas en la pantalla de Cuentas (o con el asistente «Organizar mi dinero») antes de traspasar."
          />
        ) : null}

        {accounts.length > 0 ? (
          <>
            <Select
              label="Desde (cuenta origen)"
              value={fromAccountId}
              onChange={setFromAccountId}
              groups={accountOptions}
              placeholder="— Elija de dónde sale el dinero —"
            />
            <Select
              label="Hacia (cuenta destino)"
              value={toAccountId}
              onChange={setToAccountId}
              groups={accountOptions}
              placeholder="— Elija a dónde entra el dinero —"
            />

            {fromAccount ? (
              <p className="text-xs text-muted">
                Saldo actual: {formatMoney(fromAccount.balance, fromAccount.currency)}
                {fromAccount.isCreditCard ? ' (deuda de la tarjeta)' : ''}
              </p>
            ) : null}

            {isIntercompany ? (
              <Notice tone="neutral" title="Traspaso entre negocios">
                El dinero sale de <strong>{fromAccount?.entity?.name}</strong> y entra en{' '}
                <strong>{toAccount?.entity?.name}</strong>. Se contabiliza con la cuenta puente 1150 y el mismo asiento,
                así que <strong>no cuenta como ingreso en ninguna de las dos unidades</strong> y el consolidado no se
                infla.
              </Notice>
            ) : null}

            {sameAccount ? (
              <Notice tone="negative">La cuenta de origen y la de destino no pueden ser la misma.</Notice>
            ) : null}

            <MoneyInput
              label="Importe a traspasar"
              value={amount}
              onChange={setAmount}
              hint={
                fromAccount && !fromAccount.isCreditCard
                  ? `Puede traspasar como máximo el saldo disponible: ${formatMoney(fromAccount.balance, fromAccount.currency)}.`
                  : undefined
              }
            />

            {exceedsBalance ? (
              <Notice tone="warning" title="El importe supera el saldo de la cuenta">
                El traspaso dejaría la cuenta en negativo. Si es correcto (por ejemplo, un descubierto acordado), puede
                continuar; el sistema no se lo impedirá, pero quedará registrado.
              </Notice>
            ) : null}

            <Field
              label="Descripción"
              value={description}
              onChange={setDescription}
              hint="Por ejemplo: traspaso a la caja de Fulltech, aporte a Phytoemagry, retiro para uso personal"
            />
            <Field label="Referencia (opcional)" value={reference} onChange={setReference} hint="Número de transferencia bancaria, comprobante…" />
            <Field label="Fecha" value={businessDate} onChange={setBusinessDate} type="date" />

            {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

            <Button disabled={!canSubmit} onClick={() => void submit()}>
              {busy ? 'Registrando…' : 'Registrar traspaso'}
            </Button>
          </>
        ) : null}
      </Card>

      <Card>
        <SectionTitle title="Últimos traspasos" hint="Salida y entrada comparten el mismo asiento" />
        {transfersQuery.isLoading ? <Spinner /> : null}
        {transfersQuery.data && transfersQuery.data.data.length === 0 ? (
          <EmptyState title="No hay traspasos registrados todavía" />
        ) : null}
        <div className="space-y-2">
          {(transfersQuery.data?.data ?? []).map((transfer) => {
            const crossesEntities = Boolean(
              transfer.fromAccount && transfer.toAccount && transfer.fromAccount.entityId !== transfer.toAccount.entityId,
            );
            return (
              <div key={transfer.id} className="rounded-lg border border-border-soft p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{transfer.description}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {transfer.fromAccount?.name ?? 'origen'} → {transfer.toAccount?.name ?? 'destino'}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-faint">{formatBusinessDate(transfer.businessDate)}</span>
                      {crossesEntities ? <Badge tone="neutral">entre negocios</Badge> : null}
                    </div>
                  </div>
                  <span className="shrink-0 text-sm text-ink">{formatMoney(transfer.amount, transfer.currency)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <p className="pb-4 text-center text-xs text-faint">
        Un traspaso nunca aparece como ingreso ni como gasto: sólo cambia el dinero de sitio.
      </p>
    </div>
  );
}
