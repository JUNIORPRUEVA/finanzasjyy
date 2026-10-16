import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Badge, Button, Card, EmptyState, Field, Money, Notice, SectionTitle, Spinner } from '../components/ui';
import { formatBusinessDate, txnKindLabel, txnKindTone, todayBusinessDate } from '../lib/format';

interface TransactionRow {
  id: string;
  kind: string;
  status: string;
  amount: string;
  currency: string;
  businessDate: string;
  description: string;
  reference: string | null;
  method: string | null;
  account: { id: string; name: string; type: string } | null;
  category: { id: string; name: string; kind: string } | null;
  entity: { id: string; code: string; name: string } | null;
  recordedOffline: boolean;
  syncStatus: string;
  affectsProfitAndLoss: boolean;
  voidedAt: string | null;
  voidReason: string | null;
}

interface ListResponse {
  data: TransactionRow[];
  meta: { page: number; limit: number; total: number; hasNext: boolean };
}

/**
 * HISTORIAL DE MOVIMIENTOS
 * ------------------------
 * Se distingue SIEMPRE entre:
 *  · movimientos confirmados por el servidor,
 *  · movimientos registrados sin conexión todavía sin confirmar,
 *  · movimientos anulados (nunca desaparecen: se anulan con motivo).
 */
export function TransactionsPage() {
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const entityId = params.get('entityId') ?? '';

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [message, setMessage] = useState<{ tone: 'positive' | 'negative'; text: string } | null>(null);

  const queryString = new URLSearchParams({
    ...(entityId ? { entityId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(kindFilter ? { kinds: kindFilter } : {}),
    ...(search ? { search } : {}),
    page: String(page),
    limit: '50',
  }).toString();

  const listQuery = useQuery<ListResponse>({
    queryKey: ['transactions', queryString],
    queryFn: () => api.get<ListResponse>(`/transactions?${queryString}`),
  });

  const voidMutation = useMutation({
    mutationFn: (transactionId: string) =>
      api.post(`/transactions/${transactionId}/void`, { reason: voidReason }),
    onSuccess: () => {
      setMessage({ tone: 'positive', text: 'Movimiento anulado. El asiento original quedó reversado y trazado.' });
      setVoidReason('');
      setExpanded(null);
      void queryClient.invalidateQueries({ queryKey: ['transactions'] });
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
    onError: (error) => {
      setMessage({
        tone: 'negative',
        text: error instanceof ApiError ? error.message : 'No se pudo anular el movimiento.',
      });
    },
  });

  return (
    <div className="space-y-4">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <Card className="space-y-3">
        <SectionTitle title="Filtros" hint="Busque por descripción, fechas o tipo" />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Desde" value={from} onChange={setFrom} type="date" />
          <Field label="Hasta" value={to} onChange={setTo} type="date" />
        </div>
        <Field label="Buscar" value={search} onChange={setSearch} placeholder="Texto en la descripción" />
        <div className="flex flex-wrap gap-2">
          {[
            { value: '', label: 'Todos' },
            { value: 'INCOME', label: 'Ingresos' },
            { value: 'EXPENSE', label: 'Gastos' },
            { value: 'OWNER_WITHDRAWAL', label: 'Retiros' },
            { value: 'TRANSFER_IN,TRANSFER_OUT', label: 'Transferencias' },
            { value: 'LOAN_DISBURSEMENT,LOAN_PAYMENT', label: 'Préstamos' },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                setKindFilter(option.value);
                setPage(1);
              }}
              className={`rounded-full border px-3 py-1 text-xs ${
                kindFilter === option.value
                  ? 'border-positive/50 bg-positive/20 text-positive'
                  : 'border-border-soft text-muted'
              }`}
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setFrom(todayBusinessDate());
              setTo(todayBusinessDate());
              setPage(1);
            }}
            className="rounded-full border border-border-soft px-3 py-1 text-xs text-muted"
          >
            Hoy
          </button>
        </div>
      </Card>

      {listQuery.isLoading ? <Spinner /> : null}

      {listQuery.data && listQuery.data.data.length === 0 ? (
        <EmptyState title="No hay movimientos con estos filtros" hint="Pruebe a ampliar el rango de fechas." />
      ) : null}

      {listQuery.data && listQuery.data.data.length > 0 ? (
        <Card>
          <SectionTitle
            title={`${listQuery.data.meta.total} movimiento(s)`}
            hint="Los importes y saldos vienen del libro contable del servidor"
          />
          <div className="divide-y divide-border-soft">
            {listQuery.data.data.map((row) => (
              <div key={row.id} className="py-2">
                <button
                  type="button"
                  className="flex w-full items-start justify-between gap-3 text-left"
                  onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{row.description}</p>
                    <p className="truncate text-xs text-faint">
                      {formatBusinessDate(row.businessDate)} · {txnKindLabel(row.kind)}
                      {row.category ? ` · ${row.category.name}` : ''}
                      {row.account ? ` · ${row.account.name}` : ''}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {row.entity ? <Badge tone="neutral">{row.entity.name}</Badge> : null}
                      {row.status === 'VOIDED' ? <Badge tone="critical">anulado</Badge> : null}
                      {row.syncStatus !== 'CONFIRMED' ? <Badge tone="warning">sin confirmar</Badge> : null}
                      {row.recordedOffline ? <Badge tone="neutral">registrado sin conexión</Badge> : null}
                      {!row.affectsProfitAndLoss ? <Badge tone="neutral">no afecta al resultado</Badge> : null}
                    </div>
                  </div>
                  <Money value={row.amount} currency={row.currency} tone={txnKindTone(row.kind)} />
                </button>

                {expanded === row.id ? (
                  <div className="mt-3 space-y-3 rounded-lg border border-border-soft bg-surface-2 p-3">
                    <dl className="grid grid-cols-2 gap-2 text-xs text-muted">
                      <div>
                        <dt>Método</dt>
                        <dd className="text-ink">{row.method ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>Referencia</dt>
                        <dd className="text-ink">{row.reference ?? '—'}</dd>
                      </div>
                    </dl>

                    {row.status === 'VOIDED' ? (
                      <Notice tone="neutral" title="Movimiento anulado">
                        {row.voidReason ?? 'Sin motivo registrado'} ({formatBusinessDate(row.voidedAt)})
                      </Notice>
                    ) : (
                      <div className="space-y-2">
                        <Field
                          label="Motivo de anulación"
                          value={expanded === row.id ? voidReason : ''}
                          onChange={setVoidReason}
                          placeholder="Explique por qué se anula (queda en la auditoría)"
                        />
                        <Button
                          variant="danger"
                          disabled={voidReason.trim().length < 5 || voidMutation.isPending}
                          onClick={() => voidMutation.mutate(row.id)}
                        >
                          Anular movimiento
                        </Button>
                        <p className="text-xs text-faint">
                          Anular no borra: se genera un asiento de reverso y el movimiento queda marcado como anulado.
                        </p>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center justify-between">
            <Button variant="secondary" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
              Anterior
            </Button>
            <span className="text-xs text-muted">Página {page}</span>
            <Button
              variant="secondary"
              disabled={!listQuery.data.meta.hasNext}
              onClick={() => setPage((current) => current + 1)}
            >
              Siguiente
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
