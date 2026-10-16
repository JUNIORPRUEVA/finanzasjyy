import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, OfflineError } from '../lib/api';
import { submitOrQueue } from '../lib/sync';
import { useAuth } from '../store/auth';
import { Badge, Button, Card, EmptyState, Money, MoneyInput, Notice, SectionTitle, Select, Spinner } from '../components/ui';
import { CLOSING_STATUS_LABELS, formatBusinessDate, todayBusinessDate } from '../lib/format';

interface PrepareResponse {
  entity: { id: string; code: string; name: string; currency: string };
  businessDateIso: string;
  status: string;
  statusLabel: string;
  countsNeeded: Array<{
    accountId: string;
    name: string;
    type: string;
    expectedBalance: string;
    countedAmount: string | null;
    explanation: string | null;
  }>;
  otherAccounts: Array<{ accountId: string; name: string; type: string; balance: string; isLiability: boolean }>;
  daySummary: {
    income: string;
    expenses: string;
    result: string;
    withdrawals: string;
    contributions: string;
    transactionCount: number;
  };
  transfers: Array<{ id: string; amount: string; description: string; isCrossEntity: boolean }>;
  pendingSync: { total: number; transactions: number; operations: number };
  checklist: Array<{ key: string; label: string; requiresUserConfirmation: boolean; satisfied: boolean }>;
  analysis: {
    differences: Array<{
      accountId: string;
      accountName: string;
      expected: string;
      counted: string;
      difference: string;
      hasDifference: boolean;
      explanation: string | null;
      explained: boolean;
      blocksFinalization: boolean;
    }>;
    totalExpected: string;
    totalCounted: string;
    totalDifference: string;
    accountsWithDifference: number;
    unexplainedDifferences: number;
    canFinalize: boolean;
    blockers: string[];
  };
  existingClosing: null | {
    id: string;
    status: string;
    version: number;
    reopenCount: number;
    closedAt: string | null;
    lastReopenReason: string | null;
  };
}

interface CalendarResponse {
  closed: number;
  pending: number;
  withDifferences: number;
  calendar: Array<{
    date: string;
    hasMovements: boolean;
    movementCount: number;
    status: string;
    statusLabel: string;
    difference: string | null;
  }>;
}

/**
 * ASISTENTE DE CIERRE DIARIO
 * --------------------------
 * Es el módulo que crea la disciplina. El flujo es guiado:
 *   1. El sistema calcula el saldo ESPERADO de cada cuenta desde el libro mayor.
 *   2. El usuario confirma los pasos del día (ingresos, gastos, movimientos,
 *      transferencias) y cuenta el efectivo REAL.
 *   3. El sistema mide la diferencia y NO deja finalizar si hay una diferencia
 *      sin explicar o si quedan movimientos sin confirmar por el servidor.
 *
 * Sin conexión sólo se puede guardar como PROVISIONAL: nunca se cierra un día
 * con datos que el servidor todavía no ha validado.
 */
export function ClosingPage() {
  const [params] = useSearchParams();
  const { entities, preferences } = useAuth();
  const queryClient = useQueryClient();
  const currency = preferences?.currency ?? 'DOP';

  const [entityId, setEntityId] = useState(params.get('entityId') ?? entities[0]?.id ?? '');
  const [date, setDate] = useState(params.get('date') ?? todayBusinessDate(preferences?.timezone));
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [explanations, setExplanations] = useState<Record<string, string>>({});
  const [confirmedSteps, setConfirmedSteps] = useState<string[]>([]);
  const [adjustDifferences, setAdjustDifferences] = useState(true);
  const [reopenReason, setReopenReason] = useState('');
  const [showCalendar, setShowCalendar] = useState(false);
  const [message, setMessage] = useState<{ tone: 'positive' | 'warning' | 'negative'; text: string } | null>(null);

  const prepareQuery = useQuery<PrepareResponse>({
    queryKey: ['closing-prepare', entityId, date],
    queryFn: () => api.get<PrepareResponse>(`/closings/prepare?entityId=${entityId}&date=${date}`),
    enabled: Boolean(entityId),
  });

  const calendarQuery = useQuery<CalendarResponse>({
    queryKey: ['closing-calendar', entityId],
    queryFn: () => api.get<CalendarResponse>(`/closings/calendar?entityId=${entityId}&days=30`),
    enabled: Boolean(entityId) && showCalendar,
  });

  // Se precargan los importes contados con el saldo esperado (lo habitual es que
  // coincidan) y las explicaciones ya guardadas.
  useEffect(() => {
    if (!prepareQuery.data) {
      return;
    }
    const nextCounts: Record<string, string> = {};
    const nextExplanations: Record<string, string> = {};
    for (const row of prepareQuery.data.countsNeeded) {
      nextCounts[row.accountId] = row.countedAmount ?? row.expectedBalance;
      nextExplanations[row.accountId] = row.explanation ?? '';
    }
    setCounts(nextCounts);
    setExplanations(nextExplanations);
  }, [prepareQuery.data]);

  const isClosed = Boolean(prepareQuery.data?.existingClosing?.closedAt);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        entityId,
        businessDate: date,
        counts: Object.entries(counts).map(([accountId, countedAmount]) => ({
          accountId,
          countedAmount: countedAmount || '0',
          explanation: explanations[accountId]?.trim() ? explanations[accountId].trim() : undefined,
        })),
        confirmedSteps,
        recordedOffline: !navigator.onLine,
      };

      if (!navigator.onLine) {
        await submitOrQueue({
          type: 'CLOSING_SAVE',
          payload,
          summary: `Cierre provisional ${date}`,
          amount: null,
          entityId,
          entityName: prepareQuery.data?.entity.name ?? null,
        });
        return { offline: true as const };
      }

      return api.post<{ status: string; canFinalize: boolean; blockers?: string[]; analysis: PrepareResponse['analysis'] }>(
        '/closings/count',
        payload,
      );
    },
    onSuccess: (result) => {
      if ('offline' in result) {
        setMessage({
          tone: 'warning',
          text: 'Cierre guardado como PROVISIONAL en este dispositivo. Se enviará al servidor cuando haya conexión.',
        });
      } else {
        setMessage({
          tone: result.canFinalize ? 'positive' : 'warning',
          text: result.canFinalize
            ? 'Conteo guardado. Ya puede finalizar el cierre.'
            : `Guardado como ${CLOSING_STATUS_LABELS[result.status] ?? result.status}. Revise las diferencias.`,
        });
      }
      void prepareQuery.refetch();
      void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
    onError: (error) => {
      setMessage({
        tone: 'negative',
        text:
          error instanceof OfflineError
            ? error.message
            : error instanceof ApiError
              ? error.message
              : 'No se pudo guardar el cierre.',
      });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: () =>
      api.post<{
        status: string;
        totals: { expected: string; counted: string; difference: string };
        differences: PrepareResponse['analysis']['differences'];
        adjustments: unknown[];
        message: string;
      }>('/closings/finalize', { entityId, businessDate: date, adjustDifferences, confirmedSteps }),
    onSuccess: (result) => {
      setMessage({ tone: 'positive', text: result.message });
      void prepareQuery.refetch();
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.details) {
        const details = Array.isArray(error.details) ? error.details.join(' ') : JSON.stringify(error.details);
        setMessage({ tone: 'negative', text: `${error.message} ${details}` });
        return;
      }
      setMessage({
        tone: 'negative',
        text: error instanceof ApiError ? error.message : 'No se pudo finalizar el cierre.',
      });
    },
  });

  const reopenMutation = useMutation({
    mutationFn: () => api.post('/closings/reopen', { entityId, businessDate: date, reason: reopenReason }),
    onSuccess: () => {
      setMessage({ tone: 'warning', text: 'Cierre reabierto. La reapertura quedó registrada con su motivo.' });
      setReopenReason('');
      void prepareQuery.refetch();
    },
    onError: (error) => {
      setMessage({
        tone: 'negative',
        text: error instanceof ApiError ? error.message : 'No se pudo reabrir el cierre.',
      });
    },
  });

  const analysis = prepareQuery.data?.analysis;

  const differenceSummary = useMemo(() => {
    if (!analysis) {
      return null;
    }
    return {
      total: analysis.totalDifference,
      hasDifference: analysis.accountsWithDifference > 0,
      unexplained: analysis.unexplainedDifferences,
    };
  }, [analysis]);

  if (prepareQuery.isLoading) {
    return <Spinner label="Calculando los saldos esperados…" />;
  }

  if (prepareQuery.isError || !prepareQuery.data) {
    return (
      <Notice tone="warning" title="No se pudo preparar el cierre">
        Puede consultar los últimos movimientos guardados, pero el cierre necesita conexión con el servidor para
        calcular los saldos esperados.
      </Notice>
    );
  }

  const data = prepareQuery.data;

  return (
    <div className="space-y-4">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <Card className="space-y-3">
        <Select
          label="Unidad financiera"
          value={entityId}
          onChange={setEntityId}
          options={entities.map((entity) => ({ value: entity.id, label: entity.name }))}
        />
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">Día que se cierra</span>
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="w-full rounded-lg border border-border-soft bg-surface-2 px-3 py-2 text-sm text-ink"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={isClosed ? 'positive' : 'warning'}>{data.statusLabel}</Badge>
          {data.existingClosing?.reopenCount ? (
            <Badge tone="neutral">{data.existingClosing.reopenCount} reapertura(s)</Badge>
          ) : null}
          {data.pendingSync.total > 0 ? <Badge tone="critical">{data.pendingSync.total} sin confirmar</Badge> : null}
        </div>
        <Button variant="ghost" onClick={() => setShowCalendar((value) => !value)}>
          {showCalendar ? 'Ocultar calendario' : 'Ver últimos 30 días'}
        </Button>
      </Card>

      {showCalendar && calendarQuery.data ? (
        <Card>
          <SectionTitle
            title="Calendario de cierres"
            hint={`${calendarQuery.data.closed} cerrado(s) · ${calendarQuery.data.pending} pendiente(s) · ${calendarQuery.data.withDifferences} con diferencias`}
          />
          <div className="grid grid-cols-7 gap-1">
            {calendarQuery.data.calendar.map((day) => (
              <button
                key={day.date}
                type="button"
                onClick={() => setDate(day.date)}
                title={`${day.date}: ${day.statusLabel}${day.movementCount > 0 ? ` (${day.movementCount} movimientos)` : ' (sin movimientos)'}`}
                className={`aspect-square rounded-md border text-[10px] leading-tight ${
                  day.status === 'FINALIZED'
                    ? 'border-positive/50 bg-positive/20 text-positive'
                    : day.status === 'WITH_DIFFERENCES'
                      ? 'border-warning/40 bg-warning/20 text-warning'
                      : day.hasMovements
                        ? 'border-negative/40 bg-negative/15 text-negative'
                        : 'border-border-soft bg-surface text-faint'
                }`}
              >
                {day.date.slice(8)}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-faint">
            Los días sin movimientos no generan tarea de cierre, pero también se pueden cerrar.
          </p>
        </Card>
      ) : null}

      <Card>
        <SectionTitle title="Resumen del día" hint="Calculado con los movimientos ya registrados" />
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs uppercase text-muted">Ingresos</p>
            <p className="text-lg font-semibold">
              <Money value={data.daySummary.income} tone="positive" currency={currency} />
            </p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted">Gastos</p>
            <p className="text-lg font-semibold">
              <Money value={data.daySummary.expenses} tone="negative" currency={currency} />
            </p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted">Resultado</p>
            <p className="text-lg font-semibold">
              <Money value={data.daySummary.result} currency={currency} />
            </p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted">Movimientos</p>
            <p className="text-lg font-semibold text-ink">{data.daySummary.transactionCount}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted">Retiros del propietario</p>
            <p className="text-sm text-ink">
              <Money value={data.daySummary.withdrawals} currency={currency} />
            </p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted">Transferencias</p>
            <p className="text-sm text-ink">{data.transfers.length}</p>
          </div>
        </div>
        <p className="mt-2 text-xs text-faint">
          Fecha de negocio: {formatBusinessDate(data.businessDateIso)} (no cambia aunque el dispositivo tenga otra hora)
        </p>
      </Card>

      <Card>
        <SectionTitle title="Paso 1 · Confirme el día" hint="Marque lo que ya verificó" />
        <div className="space-y-2">
          {data.checklist
            .filter((step) => step.requiresUserConfirmation)
            .map((step) => (
              <label key={step.key} className="flex items-start gap-3 rounded-lg border border-border-soft p-3 text-sm">
                <input
                  type="checkbox"
                  checked={confirmedSteps.includes(step.key)}
                  onChange={(event) =>
                    setConfirmedSteps((current) =>
                      event.target.checked ? [...current, step.key] : current.filter((key) => key !== step.key),
                    )
                  }
                  className="mt-0.5 h-5 w-5"
                />
                <span className="text-ink">{step.label}</span>
              </label>
            ))}
        </div>
        <div className="mt-3 space-y-1">
          {data.checklist
            .filter((step) => !step.requiresUserConfirmation)
            .map((step) => (
              <div key={step.key} className="flex items-center justify-between text-xs">
                <span className="text-muted">{step.label}</span>
                <Badge tone={step.satisfied ? 'positive' : 'warning'}>{step.satisfied ? 'ok' : 'pendiente'}</Badge>
              </div>
            ))}
        </div>
      </Card>

      <Card>
        <SectionTitle
          title="Paso 2 · Cuente el efectivo"
          hint="Compare lo que tiene en la mano con lo que dice el sistema"
        />
        <div className="space-y-4">
          {data.countsNeeded.map((row) => {
            const counted = counts[row.accountId] ?? row.expectedBalance;
            const differenceCents = Math.round((Number(counted) - Number(row.expectedBalance)) * 100);
            const hasDifference = differenceCents !== 0;

            return (
              <div key={row.accountId} className="rounded-lg border border-border-soft p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-ink">{row.name}</span>
                  <span className="text-xs text-muted">
                    esperado <Money value={row.expectedBalance} currency={currency} />
                  </span>
                </div>

                <div className="mt-2">
                  <MoneyInput label="Contado" value={counted} onChange={(value) => setCounts((c) => ({ ...c, [row.accountId]: value }))} />
                </div>

                {hasDifference ? (
                  <div className="mt-2 space-y-2">
                    <Notice tone={differenceCents < 0 ? 'negative' : 'warning'} title={differenceCents < 0 ? 'Falta dinero' : 'Sobra dinero'}>
                      Diferencia de <Money value={(differenceCents / 100).toFixed(2)} currency={currency} />. Es obligatorio
                      explicarla antes de cerrar el día.
                    </Notice>
                    <label className="block">
                      <span className="mb-1 block text-sm text-ink">¿Qué pasó con esa diferencia?</span>
                      <input
                        value={explanations[row.accountId] ?? ''}
                        onChange={(event) => setExplanations((e) => ({ ...e, [row.accountId]: event.target.value }))}
                        placeholder="Ej.: Se pagó el almuerzo del equipo sin comprobante"
                        className="w-full rounded-lg border border-border-soft bg-surface-2 px-3 py-2 text-sm text-ink"
                      />
                    </label>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {data.otherAccounts.length > 0 ? (
          <div className="mt-4">
            <p className="mb-1 text-xs uppercase text-muted">Otras cuentas (no se cuentan a mano)</p>
            <div className="space-y-1">
              {data.otherAccounts.map((account) => (
                <div key={account.accountId} className="flex items-center justify-between text-xs text-muted">
                  <span>{account.name}</span>
                  <Money value={account.balance} currency={currency} tone={account.isLiability ? 'negative' : 'positive'} />
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      {differenceSummary ? (
        <Card>
          <SectionTitle title="Paso 3 · Resultado del conteo" />
          <div className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-3 text-sm">
            <div>
              <p className="text-xs uppercase text-muted">Esperado</p>
              <Money value={analysis?.totalExpected} currency={currency} />
            </div>
            <div>
              <p className="text-xs uppercase text-muted">Contado</p>
              <Money value={analysis?.totalCounted} currency={currency} />
            </div>
            <div>
              <p className="text-xs uppercase text-muted">Diferencia</p>
              <Money
                value={differenceSummary.total}
                currency={currency}
                tone={differenceSummary.total.startsWith('-') ? 'negative' : 'positive'}
              />
            </div>
          </div>

          {analysis && analysis.blockers.length > 0 ? (
            <div className="mt-3">
              <Notice tone="warning" title="Para poder finalizar falta lo siguiente">
                <ul className="list-inside list-disc space-y-1">
                  {analysis.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              </Notice>
            </div>
          ) : null}

          <div className="mt-4 space-y-3">
            <label className="flex items-start gap-3 text-sm text-ink">
              <input
                type="checkbox"
                checked={adjustDifferences}
                onChange={(event) => setAdjustDifferences(event.target.checked)}
                className="mt-0.5 h-5 w-5"
              />
              <span>
                Registrar el asiento de ajuste por la diferencia explicada (faltante a «8010 Faltantes», sobrante a
                «4920 Sobrantes»). Así el saldo del sistema coincide con la realidad y queda el rastro contable.
              </span>
            </label>

            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                {saveMutation.isPending ? 'Guardando…' : 'Guardar conteo'}
              </Button>
              <Button
                disabled={!analysis?.canFinalize || finalizeMutation.isPending || isClosed}
                onClick={() => finalizeMutation.mutate()}
              >
                {finalizeMutation.isPending ? 'Cerrando…' : 'Finalizar cierre'}
              </Button>
            </div>

            {!analysis?.canFinalize ? (
              <p className="text-xs text-faint">
                El cierre definitivo exige: diferencias explicadas, ningún movimiento sin confirmar por el servidor y
                conexión activa. Mientras tanto, el cierre se guarda como provisional.
              </p>
            ) : null}
          </div>
        </Card>
      ) : null}

      {isClosed ? (
        <Card>
          <SectionTitle title="Reabrir el cierre" hint="Queda registrado en la auditoría con su motivo" />
          <label className="block">
            <span className="mb-1 block text-sm text-ink">Motivo de la reapertura</span>
            <input
              value={reopenReason}
              onChange={(event) => setReopenReason(event.target.value)}
              placeholder="Explique por qué hay que reabrir (mínimo 10 caracteres)"
              className="w-full rounded-lg border border-border-soft bg-surface-2 px-3 py-2 text-sm text-ink"
            />
          </label>
          <Button
            variant="danger"
            className="mt-3"
            disabled={reopenReason.trim().length < 10 || reopenMutation.isPending}
            onClick={() => reopenMutation.mutate()}
          >
            {reopenMutation.isPending ? 'Reabriendo…' : 'Reabrir cierre'}
          </Button>
          {data.existingClosing?.lastReopenReason ? (
            <p className="mt-2 text-xs text-faint">Última reapertura: {data.existingClosing.lastReopenReason}</p>
          ) : null}
        </Card>
      ) : null}

      {!isClosed && data.countsNeeded.length === 0 ? (
        <EmptyState
          title="Esta unidad no tiene cuentas para contar"
          hint="Cree al menos una cuenta de efectivo, caja de negocio o billetera digital."
        />
      ) : null}
    </div>
  );
}
