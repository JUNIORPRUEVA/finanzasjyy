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

// ============================================================================
// ESTRUCTURA JURÍDICA
// ============================================================================

interface UnidadEstructura {
  id: string;
  code: string;
  name: string;
  type: string;
  isActive: boolean;
  parentEntityId: string | null;
}

interface PersonaJuridica {
  id: string;
  code: string;
  name: string;
  kind: 'COMPANY' | 'INDIVIDUAL';
  entities: UnidadEstructura[];
}

interface EstructuraResponse {
  legalEntities: PersonaJuridica[];
  unconfirmed: UnidadEstructura[];
  explanation: string;
}

/**
 * UNA FILA = UNA UNIDAD
 * ---------------------
 * Se enseña la persona jurídica y de qué unidad depende, con su estado. Si algo
 * está sin confirmar se dice claramente y se puede resolver aquí mismo.
 *
 * Lo que esta pantalla NO hace: asignar sola. Una unidad sin confirmar se queda
 * sin confirmar hasta que alguien lo decida, porque de esa relación dependen los
 * asientos de todos sus movimientos.
 */
function FilaEstructura({
  unidad,
  personas,
  unidades,
  onGuardar,
  guardando,
}: {
  unidad: UnidadEstructura;
  personas: PersonaJuridica[];
  unidades: UnidadEstructura[];
  onGuardar: (datos: { id: string; legalEntityId: string | null; parentEntityId: string | null }) => void;
  guardando: boolean;
}) {
  const personaActual = personas.find((persona) => persona.entities.some((fila) => fila.id === unidad.id));
  const [legalEntityId, setLegalEntityId] = useState(personaActual?.id ?? '');
  const [parentEntityId, setParentEntityId] = useState(unidad.parentEntityId ?? '');

  const opcionesPersona = personas.map((persona) => ({
    value: persona.id,
    label: `${persona.name}${persona.kind === 'INDIVIDUAL' ? ' (persona física)' : ''}`,
  }));
  const opcionesPadre = unidades
    .filter((fila) => fila.id !== unidad.id && fila.type !== 'PERSONAL')
    .map((fila) => ({ value: fila.id, label: fila.name }));

  const confirmada = Boolean(personaActual);

  return (
    <section aria-label={unidad.name} className="rounded-lg border border-border-soft p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{unidad.name}</p>
          <p className="truncate text-xs text-faint">
            {unidad.code} · {TYPES.find((fila) => fila.value === unidad.type)?.label ?? unidad.type}
          </p>
        </div>
        <Badge tone={confirmada ? 'positive' : 'warning'}>{confirmada ? 'confirmada' : 'sin confirmar'}</Badge>
      </div>

      <div className="mt-2 space-y-2">
        <Select
          label="Persona jurídica"
          value={legalEntityId}
          onChange={setLegalEntityId}
          options={opcionesPersona}
          placeholder="— Sin confirmar —"
        />
        <Select
          label="Depende de (opcional)"
          value={parentEntityId}
          onChange={setParentEntityId}
          options={opcionesPadre}
          placeholder="— No depende de otra —"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={guardando}
          onClick={() =>
            onGuardar({
              id: unidad.id,
              legalEntityId: legalEntityId === '' ? null : legalEntityId,
              parentEntityId: parentEntityId === '' ? null : parentEntityId,
            })
          }
        >
          {guardando ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>
    </section>
  );
}

export function EntitiesPage() {
  const { reload } = useAuth();
  const queryClient = useQueryClient();

  const entitiesQuery = useQuery<unknown>({ queryKey: ['entities'], queryFn: () => api.get('/entities') });
  const statusQuery = useQuery<SetupStatus>({ queryKey: ['setup-status'], queryFn: () => api.get<SetupStatus>('/setup/status') });

  const entities = useMemo(() => asArray<EntityRow>(entitiesQuery.data), [entitiesQuery.data]);

  const [message, setMessage] = useState<{ tone: 'positive' | 'warning' | 'negative'; text: string } | null>(null);

  // ---------------------------------------------------------------------
  // Estructura jurídica
  // ---------------------------------------------------------------------
  const estructuraQuery = useQuery<EstructuraResponse>({
    queryKey: ['estructura-juridica'],
    queryFn: () => api.get<EstructuraResponse>('/entities/legal-entities'),
  });

  const estructura = estructuraQuery.data;

  /** Todas las unidades, confirmadas o no, para poder elegir de quién depende cada una. */
  const todasLasUnidades = useMemo(() => {
    if (!estructura) {
      return [] as UnidadEstructura[];
    }
    const porId = new Map<string, UnidadEstructura>();
    for (const persona of estructura.legalEntities) {
      for (const unidad of persona.entities) {
        porId.set(unidad.id, unidad);
      }
    }
    for (const unidad of estructura.unconfirmed) {
      porId.set(unidad.id, unidad);
    }
    return [...porId.values()];
  }, [estructura]);

  const [guardandoEstructura, setGuardandoEstructura] = useState('');

  const guardarEstructura = async (datos: {
    id: string;
    legalEntityId: string | null;
    parentEntityId: string | null;
  }) => {
    setGuardandoEstructura(datos.id);
    setMessage(null);
    try {
      await api.patch(`/entities/${datos.id}/structure`, {
        legalEntityId: datos.legalEntityId,
        parentEntityId: datos.parentEntityId,
      });
      setMessage({ tone: 'positive', text: 'Relación jurídica guardada. Queda registrada en la auditoría.' });
      await queryClient.invalidateQueries({ queryKey: ['estructura-juridica'] });
    } catch (error) {
      setMessage({
        tone: 'negative',
        text: error instanceof ApiError ? error.message : 'No se pudo guardar la relación jurídica.',
      });
    } finally {
      setGuardandoEstructura('');
    }
  };

  const [nombrePersona, setNombrePersona] = useState('');
  const [tipoPersona, setTipoPersona] = useState<'COMPANY' | 'INDIVIDUAL'>('COMPANY');

  const crearPersona = async () => {
    setMessage(null);
    try {
      await api.post('/entities/legal-entities', { name: nombrePersona.trim(), kind: tipoPersona });
      setNombrePersona('');
      setMessage({ tone: 'positive', text: 'Persona jurídica creada.' });
      await queryClient.invalidateQueries({ queryKey: ['estructura-juridica'] });
    } catch (error) {
      setMessage({
        tone: 'negative',
        text: error instanceof ApiError ? error.message : 'No se pudo crear la persona jurídica.',
      });
    }
  };

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [type, setType] = useState('BUSINESS');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

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

      {/* ESTRUCTURA JURÍDICA: de quién es cada unidad. De esto depende que un
          traspaso sea un movimiento interno o una operación que hay que
          clasificar, así que tiene que verse y poder confirmarse. */}
      <Card className="space-y-3">
        <SectionTitle
          title="Personas jurídicas"
          hint="Quién es el dueño legal de cada unidad"
        />
        <p className="text-xs leading-snug text-muted">
          Una unidad sin confirmar <strong>no se asigna sola</strong>: hasta que usted lo diga, la aplicación no permite
          mover dinero hacia o desde ella.
        </p>

        {estructuraQuery.isLoading ? <Spinner label="Leyendo la estructura…" /> : null}

        {estructura ? (
          <>
            <div className="space-y-1">
              {estructura.legalEntities.map((persona) => (
                <div key={persona.id} className="rounded-lg border border-border-soft p-2">
                  <p className="text-sm font-medium text-ink">
                    {persona.name}
                    {persona.kind === 'INDIVIDUAL' ? (
                      <span className="ml-1 text-xs font-normal text-muted">persona física</span>
                    ) : null}
                  </p>
                  <p className="text-xs text-faint">
                    {persona.entities.length === 0
                      ? 'Sin unidades asignadas'
                      : persona.entities.map((unidad) => unidad.name).join(' · ')}
                  </p>
                </div>
              ))}
            </div>

            <div className="space-y-2 border-t border-border-soft pt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                {todasLasUnidades.length} unidad(es) · {estructura.unconfirmed.length} sin confirmar
              </p>
              {todasLasUnidades.map((unidad) => (
                <FilaEstructura
                  key={unidad.id}
                  unidad={unidad}
                  personas={estructura.legalEntities}
                  unidades={todasLasUnidades}
                  onGuardar={(datos) => void guardarEstructura(datos)}
                  guardando={guardandoEstructura === unidad.id}
                />
              ))}
            </div>

            <div className="space-y-2 border-t border-border-soft pt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Nueva persona jurídica</p>
              <Field
                label="Nombre de la persona jurídica"
                value={nombrePersona}
                onChange={setNombrePersona}
                placeholder="Ej.: Otra S.R.L."
              />
              <Select
                label="Tipo de persona jurídica"
                value={tipoPersona}
                onChange={(valor) => setTipoPersona(valor as 'COMPANY' | 'INDIVIDUAL')}
                options={[
                  { value: 'COMPANY', label: 'Sociedad' },
                  { value: 'INDIVIDUAL', label: 'Persona física' },
                ]}
              />
              <Button size="sm" disabled={nombrePersona.trim().length < 2} onClick={() => void crearPersona()}>
                Crear
              </Button>
            </div>
          </>
        ) : null}
      </Card>

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
        Después de crearla, dé de alta sus cuentas en «Cuentas y bancos» con el dinero que tenga hoy.
      </p>
    </div>
  );
}
