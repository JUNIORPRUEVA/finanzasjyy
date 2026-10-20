import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Badge, Button, Card, EmptyState, Field, Notice, SectionTitle, Select, Spinner } from '../components/ui';
import { useAuth } from '../store/auth';

/**
 * UNIDADES FINANCIERAS
 * --------------------
 * Cada negocio, alquiler o ingreso futuro es una unidad independiente:
 * sus cuentas, sus deudas, sus presupuestos y sus cierres. Se pueden crear
 * tantas como haga falta y verlas consolidadas sin mezclar operaciones.
 */

interface EntityRow {
  id: string;
  code: string;
  name: string;
  type: string;
  description: string | null;
  currency: string;
  isActive: boolean;
  members?: Array<{ id: string; role: string; user?: { id: string; name: string; email: string } | null }>;
}

interface SetupStatus {
  entities: Array<{
    id: string;
    name: string;
    accounts: number;
    openingBalancePosted: boolean;
    loans: number;
    receivables: number;
    payables: number;
    recurrings: number;
    closings: number;
  }>;
}

const TYPES = [
  { value: 'BUSINESS', label: 'Negocio' },
  { value: 'PERSONAL', label: 'Finanzas personales' },
  { value: 'RENTAL', label: 'Alquiler' },
  { value: 'SERVICE', label: 'Servicios' },
  { value: 'INVESTMENT', label: 'Inversiones' },
  { value: 'OTHER', label: 'Otro' },
];

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: T[] }).data;
  }
  return [];
}

export function EntitiesPage() {
  const { reload } = useAuth();
  const queryClient = useQueryClient();

  const entitiesQuery = useQuery<unknown>({ queryKey: ['entities'], queryFn: () => api.get('/entities') });
  const statusQuery = useQuery<SetupStatus>({ queryKey: ['setup-status'], queryFn: () => api.get<SetupStatus>('/setup/status') });

  const entities = useMemo(() => asArray<EntityRow>(entitiesQuery.data), [entitiesQuery.data]);

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [type, setType] = useState('BUSINESS');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'positive' | 'warning' | 'negative'; text: string } | null>(null);

  const create = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const created = await api.post<EntityRow>('/entities', {
        name: name.trim(),
        ...(code.trim() ? { code: code.trim().toUpperCase() } : {}),
        type,
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setMessage({
        tone: 'positive',
        text: `Unidad «${created.name}» creada. Sus cuentas, movimientos y cierres son independientes del resto; podrá verlos consolidados cuando quiera.`,
      });
      setName('');
      setCode('');
      setDescription('');
      await reload();
      await queryClient.invalidateQueries();
    } catch (caught) {
      setMessage({ tone: 'negative', text: caught instanceof ApiError ? caught.message : 'No se pudo crear la unidad.' });
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (entity: EntityRow) => {
    setBusy(true);
    try {
      await api.patch(`/entities/${entity.id}`, { isActive: !entity.isActive });
      await reload();
      await queryClient.invalidateQueries();
    } catch (caught) {
      setMessage({ tone: 'negative', text: caught instanceof ApiError ? caught.message : 'No se pudo cambiar el estado.' });
    } finally {
      setBusy(false);
    }
  };

  const statusById = new Map((statusQuery.data?.entities ?? []).map((row) => [row.id, row]));

  return (
    <div className="space-y-4">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <Card>
        <SectionTitle
          title="Mis unidades financieras"
          hint="Cada una con sus propias cuentas, deudas, presupuestos y cierres"
        />
        {entitiesQuery.isLoading ? <Spinner /> : null}
        {entitiesQuery.isError && !entitiesQuery.data ? (
          <EmptyState
            title="No se pudieron consultar las unidades"
            hint="Hace falta conexión la primera vez. Las unidades que ya tiene se guardan en el dispositivo para consultarlas sin internet."
            action={
              <Button variant="secondary" onClick={() => void entitiesQuery.refetch()}>
                Reintentar
              </Button>
            }
          />
        ) : null}
        {entities.length === 0 && !entitiesQuery.isLoading && !entitiesQuery.isError ? (
          <EmptyState title="No hay unidades" />
        ) : null}

        <div className="space-y-2">
          {entities.map((entity) => {
            const status = statusById.get(entity.id);
            return (
              <div key={entity.id} className="rounded-lg border border-border-soft p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{entity.name}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {entity.code} · {TYPES.find((row) => row.value === entity.type)?.label ?? entity.type} · {entity.currency}
                    </p>
                    {entity.description ? <p className="mt-1 text-xs text-faint">{entity.description}</p> : null}
                  </div>
                  <div className="shrink-0 text-right">
                    <Badge tone={entity.isActive ? 'positive' : 'neutral'}>{entity.isActive ? 'Activa' : 'Inactiva'}</Badge>
                  </div>
                </div>

                {status ? (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    <Badge tone={status.accounts > 0 ? 'neutral' : 'warning'}>{status.accounts} cuenta(s)</Badge>
                    <Badge tone={status.openingBalancePosted ? 'positive' : 'warning'}>
                      {status.openingBalancePosted ? 'Con saldos iniciales' : 'Sin saldos iniciales'}
                    </Badge>
                    <Badge tone="neutral">{status.loans} deuda(s)</Badge>
                    <Badge tone="neutral">{status.closings} cierre(s)</Badge>
                    {status.accounts === 0 ? (
                      <a href={`/organizar`} className="text-warning underline">
                        Registrar su dinero
                      </a>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-2 flex flex-wrap gap-2">
                  <a
                    href={`/?entityId=${entity.id}`}
                    className="rounded-lg bg-surface-3 px-3 py-1.5 text-xs text-ink hover:bg-surface-3"
                  >
                    Ver su panel
                  </a>
                  <button type="button" className="text-xs text-muted underline" onClick={() => void toggleActive(entity)}>
                    {entity.isActive ? 'Desactivar' : 'Activar'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="space-y-3">
        <SectionTitle
          title="Nueva fuente de ingresos"
          hint="Un negocio nuevo, alquileres, servicios, inversiones o trabajo independiente"
        />
        <Field label="Nombre" value={name} onChange={setName} hint="Por ejemplo: Alquiler del local 2, Servicios de diseño" />
        <Field
          label="Código (opcional)"
          value={code}
          onChange={setCode}
          hint="Se usa para identificarla en informes. Si lo deja vacío, se genera del nombre."
        />
        <Select label="Tipo" value={type} onChange={setType} options={TYPES} />
        <Field label="Descripción (opcional)" value={description} onChange={setDescription} />
        <Notice tone="neutral" title="Independencia garantizada">
          Una unidad nueva <strong>no comparte</strong> cuentas, movimientos ni presupuestos con las demás: no se mezclan
          operaciones ni permisos. Lo que sí puede hacer es verlas juntas en el informe consolidado.
        </Notice>
        <Button disabled={busy || name.trim().length < 2} onClick={() => void create()}>
          {busy ? 'Creando…' : 'Crear unidad financiera'}
        </Button>
      </Card>

      <p className="pb-4 text-center text-xs text-faint">
        Después de crearla, registre su dinero en «Organizar mi dinero» para que la unidad deje de estar a ciegas.
      </p>
    </div>
  );
}
