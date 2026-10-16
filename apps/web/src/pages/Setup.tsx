import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, MoneyInput, Notice, SectionTitle, Select, Spinner } from '../components/ui';
import { useAuth } from '../store/auth';
import { formatMoney } from '../lib/format';

/**
 * ORGANIZAR MI DINERO — conciliación inicial
 * ------------------------------------------
 * El primer paso del uso real: declarar cuánto dinero hay, a quién pertenece,
 * qué deudas existen y qué compromisos se pagan cada mes.
 *
 * Tres reglas que se respetan en toda la pantalla:
 *  1. No hay ningún importe precargado: todas las cifras son las que escribe el
 *     usuario. La aplicación no inventa nada.
 *  2. El progreso se guarda en el dispositivo: se puede dejar a medias y volver.
 *  3. Se puede empezar con información incompleta, y la pantalla dice
 *     exactamente qué falta por registrar.
 */

interface EntityStatus {
  id: string;
  code: string;
  name: string;
  type: string;
  currency: string;
  accounts: number;
  openingBalancePosted: boolean;
  openingBalanceDate: string | null;
  loans: number;
  receivables: number;
  payables: number;
  recurrings: number;
  closings: number;
}

interface SetupStatus {
  generatedAt: string;
  businessDate: string;
  needsSetup: boolean;
  entities: EntityStatus[];
  checklist: Array<{ key: string; label: string; done: boolean; detail: string }>;
  pending: string[];
  message: string;
}

interface DraftAccount {
  entityId: string;
  name: string;
  type: string;
  openingBalance: string;
}

interface DraftLoan {
  entityId: string;
  direction: 'PAYABLE' | 'RECEIVABLE';
  name: string;
  principalAmount: string;
  annualRatePct: string;
  installmentAmount: string;
  nextDueDate: string;
}

interface DraftReceivable {
  entityId: string;
  description: string;
  originalAmount: string;
  dueDate: string;
}

interface DraftPayable {
  entityId: string;
  description: string;
  originalAmount: string;
  dueDate: string;
}

interface DraftRecurring {
  entityId: string;
  name: string;
  amount: string;
  frequency: string;
  nextDueDate: string;
}

interface Draft {
  asOfDate: string;
  accounts: DraftAccount[];
  loans: DraftLoan[];
  receivables: DraftReceivable[];
  payables: DraftPayable[];
  recurrings: DraftRecurring[];
}

interface OrganizeResult {
  asOfDate: string;
  accountsCreated: number;
  loansCreated: number;
  receivablesCreated: number;
  payablesCreated: number;
  recurringsCreated: number;
  entriesPosted: number;
  perEntity: Array<{
    entityId: string;
    entityName: string | null;
    accounts: number;
    cash: string;
    debts: string;
    equity: string;
    debits: string;
    credits: string;
    entrySequence: number;
  }>;
  totals: { debits: string; credits: string };
  message: string;
}

const ACCOUNT_TYPES = [
  { value: 'CASH', label: 'Efectivo (caja)' },
  { value: 'BANK', label: 'Banco' },
  { value: 'SAVINGS', label: 'Ahorro' },
  { value: 'CHECKING', label: 'Cuenta corriente' },
  { value: 'DIGITAL_WALLET', label: 'Billetera digital' },
  { value: 'MERCHANT', label: 'Cuenta de comercio (pasarela)' },
  { value: 'CREDIT_CARD', label: 'Tarjeta de crédito (lo que debo)' },
  { value: 'OTHER', label: 'Otra' },
];

const FREQUENCIES = [
  { value: 'MONTHLY', label: 'Mensual' },
  { value: 'BIWEEKLY', label: 'Cada 15 días' },
  { value: 'WEEKLY', label: 'Semanal' },
  { value: 'QUARTERLY', label: 'Trimestral' },
  { value: 'SEMIANNUAL', label: 'Semestral' },
  { value: 'ANNUAL', label: 'Anual' },
];

const STORAGE_KEY = 'finanza.setupDraft';

const emptyDraft = (asOfDate: string): Draft => ({
  asOfDate,
  accounts: [],
  loans: [],
  receivables: [],
  payables: [],
  recurrings: [],
});

export function SetupPage() {
  const { entities, preferences } = useAuth();
  const queryClient = useQueryClient();
  const currency = preferences?.currency ?? 'DOP';

  const statusQuery = useQuery<SetupStatus>({
    queryKey: ['setup-status'],
    queryFn: () => api.get<SetupStatus>('/setup/status'),
  });

  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<OrganizeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  // Recupera el borrador guardado: se puede dejar el asistente a medias.
  useEffect(() => {
    if (draft !== null || !statusQuery.data) {
      return;
    }
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        setDraft(JSON.parse(stored) as Draft);
        return;
      } catch {
        // Si el borrador está corrupto se empieza de cero en lugar de fallar.
      }
    }
    setDraft(emptyDraft(statusQuery.data.businessDate));
  }, [draft, statusQuery.data]);

  useEffect(() => {
    if (draft) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    }
  }, [draft]);

  const entityOptions = useMemo(
    () => entities.map((entity) => ({ value: entity.id, label: entity.name })),
    [entities],
  );

  const totales = useMemo(() => {
    if (!draft) {
      return { cash: 0, debts: 0, commit: 0, items: 0 };
    }
    const cash = draft.accounts
      .filter((row) => row.type !== 'CREDIT_CARD')
      .reduce((acc, row) => acc + Number(row.openingBalance || 0), 0);
    const debts =
      draft.accounts
        .filter((row) => row.type === 'CREDIT_CARD')
        .reduce((acc, row) => acc + Number(row.openingBalance || 0), 0) +
      draft.loans
        .filter((row) => row.direction === 'PAYABLE')
        .reduce((acc, row) => acc + Number(row.principalAmount || 0), 0) +
      draft.payables.reduce((acc, row) => acc + Number(row.originalAmount || 0), 0);
    const commit = draft.recurrings.reduce((acc, row) => acc + Number(row.amount || 0), 0);
    const items =
      draft.accounts.length + draft.loans.length + draft.receivables.length + draft.payables.length + draft.recurrings.length;
    return { cash, debts, commit, items };
  }, [draft]);

  if (!draft) {
    return <Spinner label="Preparando el asistente…" />;
  }

  if (result) {
    return (
      <div className="space-y-4">
        <Notice tone="positive" title="Situación inicial registrada">
          {result.message}
        </Notice>

        <Card>
          <SectionTitle title="Qué ha quedado registrado" hint={`Fecha de corte: ${result.asOfDate}`} />
          <div className="space-y-3">
            {result.perEntity.map((row) => (
              <div key={row.entityId} className="rounded-lg border border-border-soft p-3">
                <p className="font-medium text-ink">{row.entityName ?? 'Unidad'}</p>
                <div className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                  <div>
                    <p className="text-xs text-muted">Dinero declarado</p>
                    <p className="text-positive">{formatMoney(row.cash, currency)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">Deudas</p>
                    <p className="text-negative">{formatMoney(row.debts, currency)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">Patrimonio neto</p>
                    <p className="text-ink">{formatMoney(row.equity, currency)}</p>
                  </div>
                </div>
                <p className="mt-2 text-xs text-faint">
                  Asiento nº {row.entrySequence} · debe {formatMoney(row.debits, currency)} = haber{' '}
                  {formatMoney(row.credits, currency)}
                </p>
              </div>
            ))}
          </div>
        </Card>

        <Notice tone="neutral" title="Cómo se ha contabilizado">
          Los saldos declarados y las deudas que ya existían se han registrado contra el{' '}
          <strong>patrimonio de apertura (cuenta 3400)</strong>. Por eso <strong>no aparecen como ingresos del mes</strong>{' '}
          (serían ventas falsas) y las deudas <strong>no cuentan como dinero disponible</strong>. El resultado del día y del
          mes sigue reflejando sólo la actividad real.
        </Notice>

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              localStorage.removeItem(STORAGE_KEY);
              window.location.href = '/';
            }}
          >
            Ir al panel
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              localStorage.removeItem(STORAGE_KEY);
              window.location.href = '/control';
            }}
          >
            Ver mi control diario
          </Button>
        </div>
      </div>
    );
  }

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const payload = {
        confirm: true,
        asOfDate: draft.asOfDate,
        accounts: draft.accounts.map((row) => ({
          entityId: row.entityId,
          name: row.name,
          type: row.type,
          openingBalance: row.openingBalance,
        })),
        loans: draft.loans.map((row) => ({
          entityId: row.entityId,
          direction: row.direction,
          name: row.name,
          principalAmount: row.principalAmount,
          ...(row.annualRatePct ? { annualRatePct: row.annualRatePct } : {}),
          ...(row.installmentAmount ? { installmentAmount: row.installmentAmount } : {}),
          ...(row.nextDueDate ? { nextDueDate: row.nextDueDate } : {}),
        })),
        receivables: draft.receivables.map((row) => ({
          entityId: row.entityId,
          description: row.description,
          originalAmount: row.originalAmount,
          ...(row.dueDate ? { dueDate: row.dueDate } : {}),
        })),
        payables: draft.payables.map((row) => ({
          entityId: row.entityId,
          description: row.description,
          originalAmount: row.originalAmount,
          ...(row.dueDate ? { dueDate: row.dueDate } : {}),
        })),
        recurrings: draft.recurrings.map((row) => ({
          entityId: row.entityId,
          name: row.name,
          amount: row.amount,
          frequency: row.frequency,
          nextDueDate: row.nextDueDate,
        })),
      };

      const saved = await api.post<OrganizeResult>('/setup/organize', payload);
      setResult(saved);
      localStorage.removeItem(STORAGE_KEY);
      await queryClient.invalidateQueries();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'No se pudo guardar la conciliación inicial.');
    } finally {
      setSaving(false);
    }
  };

  const steps = ['Mi dinero', 'Lo que debo', 'Lo que me deben y yo debo', 'Compromisos del mes', 'Confirmar'];

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle
          title="Organizar mi dinero"
          hint="Sin esto, FINANZA todavía no sabe cuánto dinero hay ni de quién es"
          right={<Badge tone="warning">{step + 1} / {steps.length}</Badge>}
        />
        <div className="flex flex-wrap gap-1 text-xs">
          {steps.map((label, index) => (
            <button
              key={label}
              type="button"
              onClick={() => setStep(index)}
              className={`rounded-full border px-2 py-1 ${
                index === step
                  ? 'border-positive/50 text-positive'
                  : 'border-border-soft text-muted hover:border-border-soft'
              }`}
            >
              {index + 1}. {label}
            </button>
          ))}
        </div>
        {statusQuery.data ? (
          <p className="mt-3 text-xs text-muted">
            Falta por registrar: {statusQuery.data.pending.length === 0 ? 'nada' : statusQuery.data.pending.join(' · ')}
          </p>
        ) : null}
      </Card>

      {error ? <Notice tone="negative" title="No se pudo guardar">{error}</Notice> : null}

      {step === 0 ? (
        <Card className="space-y-3">
          <SectionTitle
            title="Cuánto dinero tengo y dónde"
            hint="Escriba lo que tiene HOY en cada cuenta. Si un banco no lo usa, no lo añada."
          />
          <Select
            label="Unidad financiera"
            value={draft.accounts[draft.accounts.length - 1]?.entityId ?? entityOptions[0]?.value ?? ''}
            onChange={(value) => setDraft({ ...draft, accounts: [...draft.accounts, { entityId: value, name: '', type: 'BANK', openingBalance: '' }] })}
            options={entityOptions}
            placeholder="— Elija la unidad y se añadirá una fila —"
          />

          {draft.accounts.length === 0 ? (
            <EmptyState
              title="Todavía no ha añadido ninguna cuenta"
              hint="Empiece por el efectivo que tiene encima y la cuenta del banco que más usa."
            />
          ) : null}

          {draft.accounts.map((row, index) => (
            <div key={`account-${index}`} className="space-y-2 rounded-lg border border-border-soft p-3">
              <div className="flex items-center justify-between">
                <Badge tone="neutral">{entities.find((entity) => entity.id === row.entityId)?.name ?? 'Unidad'}</Badge>
                <button
                  type="button"
                  className="text-xs text-negative underline"
                  onClick={() => setDraft({ ...draft, accounts: draft.accounts.filter((_, position) => position !== index) })}
                >
                  Quitar
                </button>
              </div>
              <Field
                label="Nombre de la cuenta"
                value={row.name}
                onChange={(value) => {
                  const accounts = [...draft.accounts];
                  accounts[index] = { ...row, name: value };
                  setDraft({ ...draft, accounts });
                }}
                hint="Por ejemplo: Banco Popular, Caja de la oficina, Efectivo personal"
              />
              <Select
                label="Tipo"
                value={row.type}
                onChange={(value) => {
                  const accounts = [...draft.accounts];
                  accounts[index] = { ...row, type: value };
                  setDraft({ ...draft, accounts });
                }}
                options={ACCOUNT_TYPES}
              />
              <MoneyInput
                label={row.type === 'CREDIT_CARD' ? '¿Cuánto debo en esta tarjeta?' : '¿Cuánto hay en esta cuenta?'}
                value={row.openingBalance}
                onChange={(value) => {
                  const accounts = [...draft.accounts];
                  accounts[index] = { ...row, openingBalance: value };
                  setDraft({ ...draft, accounts });
                }}
              />
            </div>
          ))}

          <p className="text-xs text-faint">
            Las tarjetas de crédito se registran como DEUDA (pasivo), nunca como dinero disponible.
          </p>
        </Card>
      ) : null}

      {step === 1 ? (
        <Card className="space-y-3">
          <SectionTitle
            title="Préstamos y deudas que ya tengo"
            hint="Capital pendiente hoy. Si no sabe la tasa, déjela vacía: no se inventa ninguna."
          />

          <Select
            label="Añadir préstamo"
            value=""
            onChange={(value) =>
              setDraft({
                ...draft,
                loans: [
                  ...draft.loans,
                  {
                    entityId: value,
                    direction: 'PAYABLE',
                    name: '',
                    principalAmount: '',
                    annualRatePct: '',
                    installmentAmount: '',
                    nextDueDate: '',
                  },
                ],
              })
            }
            options={entityOptions}
            placeholder="— Elija la unidad —"
          />

          {draft.loans.length === 0 ? (
            <EmptyState title="Sin préstamos registrados" hint="Si no tiene deudas, puede pasar al siguiente paso." />
          ) : null}

          {draft.loans.map((row, index) => (
            <div key={`loan-${index}`} className="space-y-2 rounded-lg border border-border-soft p-3">
              <div className="flex items-center justify-between">
                <Badge tone="neutral">{entities.find((entity) => entity.id === row.entityId)?.name ?? 'Unidad'}</Badge>
                <button
                  type="button"
                  className="text-xs text-negative underline"
                  onClick={() => setDraft({ ...draft, loans: draft.loans.filter((_, position) => position !== index) })}
                >
                  Quitar
                </button>
              </div>
              <Select
                label="¿Yo debo o me deben?"
                value={row.direction}
                onChange={(value) => {
                  const loans = [...draft.loans];
                  loans[index] = { ...row, direction: value as 'PAYABLE' | 'RECEIVABLE' };
                  setDraft({ ...draft, loans });
                }}
                options={[
                  { value: 'PAYABLE', label: 'Yo debo (deuda mía)' },
                  { value: 'RECEIVABLE', label: 'Me deben (préstamo que otorgué)' },
                ]}
              />
              <Field
                label="Descripción"
                value={row.name}
                onChange={(value) => {
                  const loans = [...draft.loans];
                  loans[index] = { ...row, name: value };
                  setDraft({ ...draft, loans });
                }}
                hint="Por ejemplo: Préstamo del Banco BHD, Tarjeta Visa, Financiamiento del vehículo"
              />
              <MoneyInput
                label="Capital pendiente"
                value={row.principalAmount}
                onChange={(value) => {
                  const loans = [...draft.loans];
                  loans[index] = { ...row, principalAmount: value };
                  setDraft({ ...draft, loans });
                }}
              />
              <MoneyInput
                label="Cuota (si la conoce)"
                value={row.installmentAmount}
                onChange={(value) => {
                  const loans = [...draft.loans];
                  loans[index] = { ...row, installmentAmount: value };
                  setDraft({ ...draft, loans });
                }}
              />
              <Field
                label="Tasa anual % (opcional)"
                value={row.annualRatePct}
                onChange={(value) => {
                  const loans = [...draft.loans];
                  loans[index] = { ...row, annualRatePct: value };
                  setDraft({ ...draft, loans });
                }}
                hint="Si no la conoce, déjela vacía. Cuando la sepa, se puede añadir después."
              />
              <Field
                label="Próximo vencimiento"
                value={row.nextDueDate}
                onChange={(value) => {
                  const loans = [...draft.loans];
                  loans[index] = { ...row, nextDueDate: value };
                  setDraft({ ...draft, loans });
                }}
                type="date"
                hint="Sirve para avisarle antes de que venza."
              />
            </div>
          ))}
        </Card>
      ) : null}

      {step === 2 ? (
        <div className="space-y-4">
          <Card className="space-y-3">
            <SectionTitle title="Lo que ME DEBEN" hint="Facturas o préstamos por cobrar. Es dinero suyo que aún no está en caja." />
            <Select
              label="Añadir por cobrar"
              value=""
              onChange={(value) =>
                setDraft({
                  ...draft,
                  receivables: [...draft.receivables, { entityId: value, description: '', originalAmount: '', dueDate: '' }],
                })
              }
              options={entityOptions}
              placeholder="— Elija la unidad —"
            />
            {draft.receivables.map((row, index) => (
              <div key={`receivable-${index}`} className="space-y-2 rounded-lg border border-border-soft p-3">
                <div className="flex items-center justify-between">
                  <Badge tone="neutral">{entities.find((entity) => entity.id === row.entityId)?.name ?? 'Unidad'}</Badge>
                  <button
                    type="button"
                    className="text-xs text-negative underline"
                    onClick={() => setDraft({ ...draft, receivables: draft.receivables.filter((_, position) => position !== index) })}
                  >
                    Quitar
                  </button>
                </div>
                <Field
                  label="Quién y por qué"
                  value={row.description}
                  onChange={(value) => {
                    const receivables = [...draft.receivables];
                    receivables[index] = { ...row, description: value };
                    setDraft({ ...draft, receivables });
                  }}
                  hint="Por ejemplo: Cliente Juan, factura 0012 pendiente"
                />
                <MoneyInput
                  label="Importe pendiente"
                  value={row.originalAmount}
                  onChange={(value) => {
                    const receivables = [...draft.receivables];
                    receivables[index] = { ...row, originalAmount: value };
                    setDraft({ ...draft, receivables });
                  }}
                />
                <Field
                  label="Vence el (opcional)"
                  value={row.dueDate}
                  onChange={(value) => {
                    const receivables = [...draft.receivables];
                    receivables[index] = { ...row, dueDate: value };
                    setDraft({ ...draft, receivables });
                  }}
                  type="date"
                />
              </div>
            ))}
          </Card>

          <Card className="space-y-3">
            <SectionTitle title="Lo que YO DEBO" hint="Facturas de proveedores, servicios pendientes. No es dinero disponible: es un compromiso." />
            <Select
              label="Añadir por pagar"
              value=""
              onChange={(value) =>
                setDraft({
                  ...draft,
                  payables: [...draft.payables, { entityId: value, description: '', originalAmount: '', dueDate: '' }],
                })
              }
              options={entityOptions}
              placeholder="— Elija la unidad —"
            />
            {draft.payables.map((row, index) => (
              <div key={`payable-${index}`} className="space-y-2 rounded-lg border border-border-soft p-3">
                <div className="flex items-center justify-between">
                  <Badge tone="neutral">{entities.find((entity) => entity.id === row.entityId)?.name ?? 'Unidad'}</Badge>
                  <button
                    type="button"
                    className="text-xs text-negative underline"
                    onClick={() => setDraft({ ...draft, payables: draft.payables.filter((_, position) => position !== index) })}
                  >
                    Quitar
                  </button>
                </div>
                <Field
                  label="A quién y por qué"
                  value={row.description}
                  onChange={(value) => {
                    const payables = [...draft.payables];
                    payables[index] = { ...row, description: value };
                    setDraft({ ...draft, payables });
                  }}
                  hint="Por ejemplo: Proveedor de internet, factura de octubre"
                />
                <MoneyInput
                  label="Importe pendiente"
                  value={row.originalAmount}
                  onChange={(value) => {
                    const payables = [...draft.payables];
                    payables[index] = { ...row, originalAmount: value };
                    setDraft({ ...draft, payables });
                  }}
                />
                <Field
                  label="Vence el (opcional)"
                  value={row.dueDate}
                  onChange={(value) => {
                    const payables = [...draft.payables];
                    payables[index] = { ...row, dueDate: value };
                    setDraft({ ...draft, payables });
                  }}
                  type="date"
                />
              </div>
            ))}
          </Card>
        </div>
      ) : null}

      {step === 3 ? (
        <Card className="space-y-3">
          <SectionTitle
            title="Compromisos de cada mes"
            hint="Alquiler, internet, nómina, suscripciones. NO se registran como gasto hasta que se pagan de verdad."
          />
          <Select
            label="Añadir compromiso"
            value=""
            onChange={(value) =>
              setDraft({
                ...draft,
                recurrings: [...draft.recurrings, { entityId: value, name: '', amount: '', frequency: 'MONTHLY', nextDueDate: '' }],
              })
            }
            options={entityOptions}
            placeholder="— Elija la unidad —"
          />
          {draft.recurrings.length === 0 ? (
            <EmptyState title="Sin compromisos registrados" hint="Los avisos de vencimiento se calculan con lo que añada aquí." />
          ) : null}
          {draft.recurrings.map((row, index) => (
            <div key={`recurring-${index}`} className="space-y-2 rounded-lg border border-border-soft p-3">
              <div className="flex items-center justify-between">
                <Badge tone="neutral">{entities.find((entity) => entity.id === row.entityId)?.name ?? 'Unidad'}</Badge>
                <button
                  type="button"
                  className="text-xs text-negative underline"
                  onClick={() => setDraft({ ...draft, recurrings: draft.recurrings.filter((_, position) => position !== index) })}
                >
                  Quitar
                </button>
              </div>
              <Field
                label="Nombre"
                value={row.name}
                onChange={(value) => {
                  const recurrings = [...draft.recurrings];
                  recurrings[index] = { ...row, name: value };
                  setDraft({ ...draft, recurrings });
                }}
                hint="Por ejemplo: Alquiler del local, Internet, Nómina, Netflix"
              />
              <MoneyInput
                label="Importe"
                value={row.amount}
                onChange={(value) => {
                  const recurrings = [...draft.recurrings];
                  recurrings[index] = { ...row, amount: value };
                  setDraft({ ...draft, recurrings });
                }}
              />
              <Select
                label="Cada cuánto"
                value={row.frequency}
                onChange={(value) => {
                  const recurrings = [...draft.recurrings];
                  recurrings[index] = { ...row, frequency: value };
                  setDraft({ ...draft, recurrings });
                }}
                options={FREQUENCIES}
              />
              <Field
                label="Próximo vencimiento"
                value={row.nextDueDate}
                onChange={(value) => {
                  const recurrings = [...draft.recurrings];
                  recurrings[index] = { ...row, nextDueDate: value };
                  setDraft({ ...draft, recurrings });
                }}
                type="date"
              />
            </div>
          ))}
        </Card>
      ) : null}

      {step === 4 ? (
        <div className="space-y-4">
          <Card className="space-y-3">
            <SectionTitle title="Resumen antes de guardar" hint="Revise las cifras: son suyas, y quedarán registradas tal cual." />
            <Field
              label="Fecha de corte de esta situación"
              value={draft.asOfDate}
              onChange={(value) => setDraft({ ...draft, asOfDate: value })}
              type="date"
              hint="La fecha en la que el dinero y las deudas son como los declara aquí."
            />
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-border-soft p-3">
                <p className="text-xs uppercase text-muted">Dinero declarado</p>
                <p className="text-lg text-positive">{formatMoney(totales.cash.toFixed(2), currency)}</p>
              </div>
              <div className="rounded-lg border border-border-soft p-3">
                <p className="text-xs uppercase text-muted">Deudas</p>
                <p className="text-lg text-negative">{formatMoney(totales.debts.toFixed(2), currency)}</p>
              </div>
              <div className="rounded-lg border border-border-soft p-3">
                <p className="text-xs uppercase text-muted">Patrimonio neto</p>
                <p className="text-lg text-ink">
                  {formatMoney((totales.cash - totales.debts).toFixed(2), currency)}
                </p>
              </div>
              <div className="rounded-lg border border-border-soft p-3">
                <p className="text-xs uppercase text-muted">Compromisos al mes</p>
                <p className="text-lg text-warning">{formatMoney(totales.commit.toFixed(2), currency)}</p>
              </div>
            </div>

            <div className="space-y-1 text-sm text-ink">
              <p>· Cuentas: {draft.accounts.length}</p>
              <p>· Préstamos y deudas: {draft.loans.length}</p>
              <p>· Por cobrar: {draft.receivables.length}</p>
              <p>· Por pagar: {draft.payables.length}</p>
              <p>· Compromisos recurrentes: {draft.recurrings.length}</p>
            </div>

            <Notice tone="warning" title="Importante">
              El patrimonio neto es dinero − deudas. Las deudas no se presentan como dinero disponible, y los saldos
              declarados no se registran como ingresos del mes.
            </Notice>

            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                className="mt-1 h-4 w-4"
              />
              <span>
                Confirmo que estas cifras son mi situación real en la fecha indicada y que quiero registrarlas como saldos
                iniciales.
              </span>
            </label>
          </Card>

          <div className="flex flex-wrap gap-2">
            <Button disabled={!confirmed || totales.items === 0 || saving} onClick={() => void save()}>
              {saving ? 'Guardando…' : 'Guardar mi situación'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
                setResult(null);
                setStep(0);
              }}
            >
              Seguir más tarde
            </Button>
            <Button
              variant="ghost"
              onClick={() => setConfirmReset(true)}
            >
              Empezar de cero
            </Button>
          </div>
          <p className="text-xs text-faint">
            El progreso se guarda en este dispositivo: puede cerrar y continuar después.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap justify-between gap-2 pb-4">
        <Button variant="secondary" disabled={step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))}>
          Atrás
        </Button>
        <Button
          disabled={step === steps.length - 1}
          onClick={() => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
            setStep((current) => Math.min(steps.length - 1, current + 1));
          }}
        >
          Siguiente
        </Button>
      </div>

      <ConfirmDialog
        open={confirmReset}
        tone="danger"
        title="¿Empezar de cero?"
        confirmLabel="Borrar lo escrito"
        message="Se borrará lo que ha ido escribiendo en el asistente en este dispositivo. Nada de lo ya guardado en el servidor se toca."
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          localStorage.removeItem(STORAGE_KEY);
          setDraft(emptyDraft(statusQuery.data?.businessDate ?? draft?.asOfDate));
          setStep(0);
        }}
      />
    </div>
  );
}
