import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Button, Card, EmptyState, Field, Notice, SectionTitle, Select, Spinner } from '../components/ui';
import { useAuth } from '../store/auth';
import { formatMoney, todayBusinessDate } from '../lib/format';

/**
 * CONCILIACIÓN CON EL BANCO
 * =========================
 * «El banco dice X y FINANZA dice Y». Esta pantalla compara, explica la
 * diferencia y —sólo si el usuario lo confirma, con un motivo— deja que se
 * corrija **con un asiento**, nunca escribiendo un saldo a mano.
 *
 * Tres cosas que la pantalla NO hace, a propósito:
 *  · No ajusta nada al comparar.
 *  · No inventa un ingreso para cuadrar.
 *  · No obliga a ajustar: una diferencia puede ser un movimiento que aún no ha
 *    llegado, y entonces basta con dejarla anotada.
 */

interface AccountRow {
  id: string;
  entityId: string;
  name: string;
  currency: string;
  isCreditCard: boolean;
  isLiability: boolean;
  balance: string;
  custody?: string;
  available?: string | null;
  entity?: { id: string; name: string } | null;
}

interface CausaOpcion {
  value: string;
  label: string;
  hint: string;
  allowsAdjustment: boolean;
}

interface VistaConciliacion {
  account: { id: string; name: string; currency: string; isCreditCard: boolean; isLiability: boolean };
  asOf: string;
  ledgerBalance: string;
  informedBalance: string;
  custody: string;
  available: string;
  difference: string;
  direction: 'MATCH' | 'SHORTAGE' | 'OVERAGE' | 'MORE_DEBT' | 'LESS_DEBT';
  matches: boolean;
  explanations: string[];
  causes: CausaOpcion[];
  proposal: { amount: string; ledgerName: string; summary: string; affectsResult: boolean } | null;
}

interface HistorialFila {
  id: string;
  asOf: string;
  informedBalance: string;
  ledgerBalance: string;
  difference: string;
  status: 'DRAFT' | 'CONFIRMED' | 'DISMISSED';
  cause: string | null;
  changedBalances: boolean;
  notes: string | null;
}

const CAUSA_CORTA: Record<string, string> = {
  UNRECORDED_MOVEMENT: 'falta un movimiento',
  PENDING_TRANSFER: 'traspaso pendiente',
  OPENING_BALANCE_ERROR: 'saldo inicial erróneo',
  DUPLICATE_MOVEMENT: 'movimiento duplicado',
  UNIDENTIFIED: 'sin identificar',
  AUTHORIZED_CASH_DIFFERENCE: 'diferencia autorizada',
};

const ESTADO: Record<string, string> = {
  DRAFT: 'vista',
  CONFIRMED: 'confirmada',
  DISMISSED: 'sin ajustar',
};

function comoLista<T>(valor: unknown): T[] {
  if (Array.isArray(valor)) {
    return valor as T[];
  }
  if (valor && typeof valor === 'object' && Array.isArray((valor as { data?: unknown }).data)) {
    return (valor as { data: T[] }).data;
  }
  return [];
}

/** Sólo dígitos, un separador decimal y un signo menos delante. */
function limpiarImporte(raw: string): string {
  const limpio = raw.replace(/[^\d.,-]/g, '').replace(/,/g, '.');
  const negativo = limpio.startsWith('-');
  const [entero, ...resto] = limpio.replace(/-/g, '').split('.');
  const decimales = resto.join('').slice(0, 2);
  const cuerpo = resto.length > 0 ? `${entero}.${decimales}` : entero;
  return `${negativo ? '-' : ''}${cuerpo}`;
}

export function ReconciliationPage() {
  const [params] = useSearchParams();
  const { entities, preferences } = useAuth();
  const queryClient = useQueryClient();
  const moneda = preferences?.currency ?? 'DOP';

  const [cuentaId, setCuentaId] = useState(params.get('cuenta') ?? '');
  const [informado, setInformado] = useState('');
  const [motivo, setMotivo] = useState('');
  const [nota, setNota] = useState('');
  const [causa, setCausa] = useState('');
  const [autorizo, setAutorizo] = useState(false);
  const [mensaje, setMensaje] = useState<{ tono: 'positive' | 'negative' | 'warning'; texto: string } | null>(null);
  const [vista, setVista] = useState<VistaConciliacion | null>(null);

  const cuentasQuery = useQuery<unknown>({
    queryKey: ['cuentas-conciliacion'],
    queryFn: () => api.get<unknown>('/accounts?includeClosed=false'),
  });

  const cuentas = useMemo(() => comoLista<AccountRow>(cuentasQuery.data), [cuentasQuery.data]);
  const grupos = useMemo(() => {
    const porUnidad = new Map<string, AccountRow[]>();
    for (const cuenta of cuentas) {
      porUnidad.set(cuenta.entityId, [...(porUnidad.get(cuenta.entityId) ?? []), cuenta]);
    }
    return [...porUnidad.entries()].map(([entityId, filas]) => ({
      label: entities.find((entity) => entity.id === entityId)?.name ?? filas[0]?.entity?.name ?? 'Unidad',
      options: filas.map((fila) => ({ value: fila.id, label: `${fila.name} (${formatMoney(fila.balance, fila.currency)})` })),
    }));
  }, [cuentas, entities]);

  const cuenta = cuentas.find((fila) => fila.id === cuentaId);

  const historialQuery = useQuery<{ data: HistorialFila[] }>({
    queryKey: ['conciliacion', cuentaId],
    queryFn: () => api.get<{ data: HistorialFila[] }>(`/accounts/${cuentaId}/reconciliation?limit=8`),
    enabled: cuentaId !== '',
  });

  const comparar = useMutation({
    mutationFn: () =>
      api.post<VistaConciliacion>(`/accounts/${cuentaId}/reconciliation/preview`, {
        informedBalance: informado,
        asOf: todayBusinessDate(preferences?.timezone),
      }),
    onSuccess: (datos) => {
      setVista(datos);
      setCausa('');
      setAutorizo(false);
      setMensaje(null);
    },
    onError: (error) => {
      setVista(null);
      setMensaje({ tono: 'negative', texto: error instanceof ApiError ? error.message : 'No se pudo comparar.' });
    },
  });

  const confirmar = useMutation({
    mutationFn: () =>
      api.post<{ adjusted: boolean; message: string }>(`/accounts/${cuentaId}/reconciliation/confirm`, {
        informedBalance: informado,
        asOf: todayBusinessDate(preferences?.timezone),
        cause: causa || undefined,
        authorized: autorizo,
        reason: motivo.trim(),
        notes: nota.trim() || undefined,
      }),
    onSuccess: async (datos) => {
      setMensaje({ tono: 'positive', texto: datos.message });
      setMotivo('');
      setNota('');
      setCausa('');
      setAutorizo(false);
      setVista(null);
      setInformado('');
      await queryClient.invalidateQueries();
    },
    onError: (error) => {
      setMensaje({ tono: 'negative', texto: error instanceof ApiError ? error.message : 'No se pudo conciliar.' });
    },
  });

  const descartar = useMutation({
    mutationFn: () =>
      api.post(`/accounts/${cuentaId}/reconciliation/dismiss`, {
        informedBalance: informado,
        asOf: todayBusinessDate(preferences?.timezone),
        cause: causa || 'UNIDENTIFIED',
        notes: nota.trim(),
      }),
    onSuccess: async () => {
      setMensaje({
        tono: 'warning',
        texto: 'Diferencia anotada sin tocar ningún saldo. Vuelva a conciliar cuando aparezca el movimiento que falta.',
      });
      setNota('');
      setVista(null);
      await queryClient.invalidateQueries({ queryKey: ['conciliacion', cuentaId] });
    },
    onError: (error) => {
      setMensaje({ tono: 'negative', texto: error instanceof ApiError ? error.message : 'No se pudo anotar.' });
    },
  });

  const puedeComparar = cuentaId !== '' && informado.trim() !== '' && !comparar.isPending;
  const causaElegida = vista?.causes.find((fila) => fila.value === causa);
  /**
   * AJUSTAR EXIGE TODO ESTO, no sólo un clic:
   *  · una causa que realmente se arregle con un asiento,
   *  · la autorización explícita,
   *  · y el motivo escrito.
   * El servidor lo vuelve a comprobar: la interfaz no es la que decide.
   */
  const puedeAjustar =
    puedeComparar &&
    causaElegida?.allowsAdjustment === true &&
    autorizo &&
    motivo.trim().length >= 10 &&
    !confirmar.isPending;
  const puedeAnotar = puedeComparar && causa !== '' && nota.trim().length >= 5 && !descartar.isPending;

  return (
    <div className="space-y-4">
      <Card className="space-y-2">
        <SectionTitle title="Conciliar con el banco" hint="Compare lo que dice el banco con lo que dice FINANZA" />
        <p className="text-xs leading-snug text-muted">
          Comparar <strong>no cambia nada</strong>. Si hay diferencia, usted decide: corregirla con un asiento (con su
          motivo) o dejarla anotada y esperar al movimiento que falta.
        </p>
      </Card>

      {mensaje ? <Notice tone={mensaje.tono}>{mensaje.texto}</Notice> : null}

      {cuentasQuery.isLoading ? <Spinner label="Cargando cuentas…" /> : null}

      {!cuentasQuery.isLoading && cuentas.length === 0 ? (
        <EmptyState title="Todavía no hay cuentas" hint="Cree una cuenta en Cuentas y bancos para poder conciliarla." />
      ) : null}

      {cuentas.length > 0 ? (
        <Card className="space-y-3">
          <Select
            label="¿Qué cuenta va a conciliar?"
            value={cuentaId}
            onChange={(valor) => {
              setCuentaId(valor);
              setVista(null);
              setMensaje(null);
            }}
            groups={grupos}
            placeholder="— Elija la cuenta —"
          />

          <Field
            label="¿Cuánto dice el banco?"
            value={informado}
            onChange={(valor) => {
              setInformado(limpiarImporte(valor));
              setVista(null);
            }}
            inputMode="decimal"
            placeholder="Ej.: 12500.00 (admite negativo)"
            hint={cuenta ? `Saldo en FINANZA hoy: ${formatMoney(cuenta.balance, cuenta.currency)}` : undefined}
          />

          <Button fullWidth disabled={!puedeComparar} onClick={() => comparar.mutate()}>
            {comparar.isPending ? 'Comparando…' : 'Comparar'}
          </Button>
        </Card>
      ) : null}

      {vista ? (
        <Card className="space-y-3">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-3">
            <div>
              <p className="text-[0.68rem] uppercase tracking-wide text-muted">Dice el banco</p>
              <p className="money text-sm font-semibold text-ink">{formatMoney(vista.informedBalance, moneda)}</p>
            </div>
            <div>
              <p className="text-[0.68rem] uppercase tracking-wide text-muted">Dice FINANZA</p>
              <p className="money text-sm font-semibold text-ink">{formatMoney(vista.ledgerBalance, moneda)}</p>
            </div>
            <div>
              <p className="text-[0.68rem] uppercase tracking-wide text-muted">Diferencia</p>
              <p
                className={`money text-sm font-semibold ${
                  vista.matches ? 'text-positive' : 'text-negative'
                }`}
              >
                {formatMoney(vista.difference, moneda)}
              </p>
            </div>
          </div>

          {Number(vista.custody) > 0 ? (
            <p className="rounded-lg bg-warning/10 p-2 text-xs text-ink">
              De ese saldo, {formatMoney(vista.custody, moneda)} es de una empresa. Suyo de verdad:{' '}
              <strong>{formatMoney(vista.available, moneda)}</strong>.
            </p>
          ) : null}

          <ul className="space-y-1 text-xs leading-snug text-muted">
            {vista.explanations.map((linea) => (
              <li key={linea}>· {linea}</li>
            ))}
          </ul>

          {vista.matches ? (
            <Button
              fullWidth
              variant="secondary"
              disabled={confirmar.isPending}
              onClick={() => confirmar.mutate()}
            >
              {confirmar.isPending ? 'Guardando…' : 'Dejar constancia (cuadra)'}
            </Button>
          ) : (
            <div className="space-y-3 border-t border-border-soft pt-3">
              {/* LAS SEIS CAUSAS. Cinco de ellas no se arreglan con un asiento:
                  sacan al usuario del ajuste y le dicen dónde está el arreglo. */}
              <div>
                <p className="mb-1 text-sm font-medium text-ink">¿Por qué hay diferencia?</p>
                <div className="space-y-1">
                  {(vista.causes ?? []).map((opcion) => (
                    <label
                      key={opcion.value}
                      className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-xs ${
                        causa === opcion.value ? 'border-brand bg-brand-soft' : 'border-border-soft'
                      }`}
                    >
                      <input
                        type="radio"
                        name="causa-conciliacion"
                        value={opcion.value}
                        checked={causa === opcion.value}
                        onChange={() => {
                          setCausa(opcion.value);
                          setAutorizo(false);
                        }}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium text-ink">{opcion.label}</span>
                        <span className="block leading-snug text-muted">{opcion.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {causaElegida?.allowsAdjustment ? (
                <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/10 p-2">
                  <p className="text-xs font-medium text-ink">{vista.proposal?.summary}</p>
                  <Field
                    label="Motivo del ajuste (obligatorio)"
                    value={motivo}
                    onChange={setMotivo}
                    placeholder="Ej.: comisión del banco no registrada y ya verificada en el extracto"
                    hint="Va al asiento y a la auditoría. Mínimo 10 caracteres."
                  />
                  <label className="flex items-start gap-2 text-xs text-ink">
                    <input
                      type="checkbox"
                      checked={autorizo}
                      onChange={(evento) => setAutorizo(evento.target.checked)}
                      className="mt-0.5"
                    />
                    <span>Autorizo este ajuste y asumo la diferencia.</span>
                  </label>
                  <Button fullWidth disabled={!puedeAjustar} onClick={() => confirmar.mutate()}>
                    {confirmar.isPending ? 'Ajustando…' : 'Ajustar y cuadrar'}
                  </Button>
                </div>
              ) : (
                <p className="rounded-lg bg-surface-2 p-2 text-xs text-muted">
                  {causa === ''
                    ? 'Elija una causa. Sólo «diferencia real revisada» permite tocar el saldo.'
                    : 'Esta causa se corrige en su sitio (apuntar el movimiento, anular el duplicado…), no con un ajuste. Puede dejar la revisión anotada sin tocar ningún saldo.'}
                </p>
              )}

              <div className="rounded-lg border border-border-soft p-2">
                <p className="text-xs text-muted">
                  ¿Prefiere no tocar nada todavía? Anote lo que ha visto y vuelva cuando aparezca el movimiento.
                </p>
                <Field
                  label="¿Qué ha comprobado?"
                  value={nota}
                  onChange={setNota}
                  placeholder="Ej.: falta el pago de la tarjeta que sale mañana"
                  hint="Mínimo 5 caracteres."
                />
                <Button
                  fullWidth
                  variant="ghost"
                  className="mt-2"
                  disabled={!puedeAnotar}
                  onClick={() => descartar.mutate()}
                >
                  {descartar.isPending ? 'Anotando…' : 'Guardar sin ajustar'}
                </Button>
              </div>
            </div>
          )}
        </Card>
      ) : null}

      {cuentaId && (historialQuery.data?.data.length ?? 0) > 0 ? (
        <Card className="space-y-2">
          <SectionTitle title="Últimas conciliaciones" hint="Con o sin ajuste, queda el rastro" />
          <div className="space-y-2">
            {historialQuery.data!.data.map((fila) => (
              <div key={fila.id} className="rounded-lg border border-border-soft p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">
                      {String(fila.asOf).slice(0, 10)} · {ESTADO[fila.status] ?? fila.status}
                      {fila.cause ? ` · ${CAUSA_CORTA[fila.cause] ?? ''}` : ''}
                    </p>
                    {fila.notes ? <p className="truncate text-xs text-faint">{fila.notes}</p> : null}
                  </div>
                  <div className="text-right">
                    <p className="money text-sm text-ink">{formatMoney(fila.difference, moneda)}</p>
                    <p className="text-[0.7rem] text-faint">
                      {fila.changedBalances ? 'con asiento de ajuste' : 'sin tocar el saldo'}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
