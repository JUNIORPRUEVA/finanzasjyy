import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Button, Card, EmptyState, Field, MoneyInput, Notice, SectionTitle, Select, Spinner, Tabs } from '../components/ui';
import { useAuth } from '../store/auth';
import { formatMoney, todayBusinessDate } from '../lib/format';

/**
 * REEMBOLSOS — «PAGUÉ ALGO DEL NEGOCIO CON MI DINERO»
 * ===================================================
 * El caso: el propietario paga el hosting de FULLTECH con su tarjeta personal.
 *
 * Lo que ve el usuario son CUATRO cosas y nada más: qué negocio, cuánto, de qué
 * cuenta suya salió y qué pagó. El sistema decide las cuentas contables.
 *
 * Lo que pasa por dentro (y esta pantalla lo dice, sin tecnicismos):
 *  · El gasto se apunta en el negocio, UNA sola vez.
 *  · En sus finanzas personales NO aparece como gasto: aparece como dinero que
 *    el negocio le debe. Su patrimonio no baja, cambia de forma.
 *  · Cuando el negocio le devuelve el dinero, eso NO es un gasto ni un ingreso:
 *    se cierra la deuda y aparece el dinero en su cuenta.
 *
 * Esto es justo lo que evita el error clásico de apuntar el gasto dos veces.
 */

type TabId = 'registrar' | 'pendientes';

interface AccountRow {
  id: string;
  entityId: string;
  name: string;
  type: string;
  currency: string;
  balance: string;
  isCreditCard: boolean;
  entity?: { id: string; name: string } | null;
}

interface Category {
  id: string;
  name: string;
  kind: 'INCOME' | 'EXPENSE';
}

interface ReimbursementRow {
  id: string;
  description: string;
  originalAmount: string;
  settledAmount: string;
  pending: string;
  currency: string;
  businessDate: string;
  status: 'OPEN' | 'PARTIAL' | 'SETTLED' | 'VOIDED';
  companyEntity: { id: string; name: string };
  ownerAccount: { id: string; name: string };
  category: { id: string; name: string } | null;
}

const ESTADO: Record<string, string> = {
  OPEN: 'pendiente',
  PARTIAL: 'devuelto en parte',
  SETTLED: 'devuelto',
  VOIDED: 'anulado',
};

/** `GET` puede responder la lista directamente o envuelta en `data`. */
function comoLista<T>(valor: unknown): T[] {
  if (Array.isArray(valor)) {
    return valor as T[];
  }
  if (valor && typeof valor === 'object' && Array.isArray((valor as { data?: unknown }).data)) {
    return (valor as { data: T[] }).data;
  }
  return [];
}

export function ReimbursementsPage() {
  const { entities, preferences } = useAuth();
  const queryClient = useQueryClient();
  const moneda = preferences?.currency ?? 'DOP';

  const [tab, setTab] = useState<TabId>('registrar');
  const [empresaId, setEmpresaId] = useState('');
  const [cuentaPersonalId, setCuentaPersonalId] = useState('');
  const [importe, setImporte] = useState('');
  const [concepto, setConcepto] = useState('');
  const [categoriaId, setCategoriaId] = useState('');
  const [mensaje, setMensaje] = useState<{ tono: 'positive' | 'negative' | 'warning'; texto: string } | null>(null);
  const [pagando, setPagando] = useState<{ id: string; empresaId: string; cuentaId: string; monto: string } | null>(null);

  const cuentasQuery = useQuery<unknown>({
    queryKey: ['cuentas-reembolso'],
    queryFn: () => api.get<unknown>('/accounts?includeClosed=false'),
  });
  const categoriasQuery = useQuery<Category[]>({
    queryKey: ['categorias-reembolso', empresaId],
    queryFn: () => api.get<Category[]>(`/categories${empresaId ? `?entityId=${empresaId}&kind=EXPENSE` : '?kind=EXPENSE'}`),
  });
  const listaQuery = useQuery<{ data: ReimbursementRow[]; meta: { pendingTotal: string } } | {
    data: ReimbursementRow[];
    meta: { pendingTotal: string };
  }>({
    queryKey: ['reembolsos'],
    queryFn: () => api.get<{ data: ReimbursementRow[]; meta: { pendingTotal: string } }>('/reimbursements?limit=50'),
  });

  const cuentas = useMemo(() => comoLista<AccountRow>(cuentasQuery.data), [cuentasQuery.data]);

  /**
   * Sólo cuentas de finanzas personales: el dinero que se adelanta sale del
   * bolsillo del propietario, no de otro negocio.
   */
  const cuentasPersonales = useMemo(
    () =>
      cuentas
        .filter((cuenta) => {
          const unidad = entities.find((entity) => entity.id === cuenta.entityId);
          return unidad?.type === 'PERSONAL' && cuenta.type !== 'CREDIT_CARD';
        })
        .map((cuenta) => ({ value: cuenta.id, label: `${cuenta.name} (${formatMoney(cuenta.balance, cuenta.currency)})` })),
    [cuentas, entities],
  );

  /** Negocios: cualquier unidad que no sea de finanzas personales. */
  const negocios = useMemo(
    () => entities.filter((entity) => entity.type !== 'PERSONAL').map((entity) => ({ value: entity.id, label: entity.name })),
    [entities],
  );

  const cuentasDeLaEmpresa = useMemo(
    () =>
      cuentas
        .filter((cuenta) => cuenta.entityId === (pagando?.empresaId ?? '') && !cuenta.isCreditCard)
        .map((cuenta) => ({ value: cuenta.id, label: `${cuenta.name} (${formatMoney(cuenta.balance, cuenta.currency)})` })),
    [cuentas, pagando?.empresaId],
  );

  const invalidar = async () => {
    await queryClient.invalidateQueries({ queryKey: ['reembolsos'] });
    await queryClient.invalidateQueries({ queryKey: ['cuentas-reembolso'] });
    await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    await queryClient.invalidateQueries({ queryKey: ['accounts-all'] });
    await queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    await queryClient.invalidateQueries({ queryKey: ['transactions'] });
  };

  const registrar = useMutation({
    mutationFn: () =>
      api.post('/reimbursements', {
        companyEntityId: empresaId,
        ownerAccountId: cuentaPersonalId,
        categoryId: categoriaId || undefined,
        amount: importe,
        description: concepto.trim() || 'Gasto del negocio pagado con mi dinero',
        businessDate: todayBusinessDate(preferences?.timezone),
      }),
    onSuccess: async () => {
      setMensaje({
        tono: 'positive',
        texto:
          'Registrado. El gasto queda en el negocio y en sus finanzas aparece como dinero que le deben: no se cuenta dos veces.',
      });
      setImporte('');
      setConcepto('');
      setCategoriaId('');
      await invalidar();
      setTab('pendientes');
    },
    onError: (error) => {
      setMensaje({ tono: 'negative', texto: error instanceof ApiError ? error.message : 'No se pudo registrar.' });
    },
  });

  const pagar = useMutation({
    mutationFn: (datos: { id: string; cuentaId: string }) =>
      api.post(`/reimbursements/${datos.id}/pay`, {
        companyAccountId: datos.cuentaId,
        businessDate: todayBusinessDate(preferences?.timezone),
      }),
    onSuccess: async () => {
      setMensaje({
        tono: 'positive',
        texto: 'Devuelto. El dinero entra en su cuenta y la deuda queda cerrada: no es un gasto ni un ingreso nuevo.',
      });
      setPagando(null);
      await invalidar();
    },
    onError: (error) => {
      setMensaje({ tono: 'negative', texto: error instanceof ApiError ? error.message : 'No se pudo devolver.' });
    },
  });

  const puedeRegistrar =
    empresaId !== '' && cuentaPersonalId !== '' && importe !== '' && Number(importe) > 0 && !registrar.isPending;

  const filas = listaQuery.data?.data ?? [];
  const pendientes = filas.filter((fila) => fila.status === 'OPEN' || fila.status === 'PARTIAL');

  return (
    <div className="space-y-4">
      <Card className="space-y-2">
        <SectionTitle
          title="Pagué algo del negocio con mi dinero"
          hint="El gasto es del negocio; el dinero salió de su bolsillo"
        />
        <p className="text-xs leading-snug text-muted">
          El gasto se apunta <strong>una sola vez</strong>, en el negocio. En sus finanzas no hay gasto: aparece el
          dinero que el negocio le debe. Cuando se lo devuelvan, sólo se cierra esa deuda.
        </p>
      </Card>

      <Tabs
        tabs={[
          { id: 'registrar' as TabId, label: 'Registrar' },
          { id: 'pendientes' as TabId, label: 'Me deben' },
        ]}
        active={tab}
        onChange={(id) => {
          setTab(id);
          setMensaje(null);
        }}
      />

      {mensaje ? <Notice tone={mensaje.tono}>{mensaje.texto}</Notice> : null}

      {tab === 'registrar' ? (
        <Card className="space-y-3">
          <Select
            label="¿De qué negocio era el gasto?"
            value={empresaId}
            onChange={(valor) => {
              setEmpresaId(valor);
              setCategoriaId('');
            }}
            options={negocios}
            placeholder="— Elija el negocio —"
          />
          <Select
            label="¿De qué cuenta suya salió el dinero?"
            value={cuentaPersonalId}
            onChange={setCuentaPersonalId}
            options={cuentasPersonales}
            placeholder="— Elija su cuenta personal —"
          />
          <MoneyInput label="¿Cuánto pagó?" value={importe} onChange={setImporte} />
          <Select
            label="Categoría del gasto"
            value={categoriaId}
            onChange={setCategoriaId}
            options={(categoriasQuery.data ?? [])
              .filter((categoria) => categoria.kind === 'EXPENSE')
              .map((categoria) => ({ value: categoria.id, label: categoria.name }))}
            placeholder="Sin categoría (otros gastos)"
          />
          <Field
            label="¿Qué pagó? (opcional)"
            value={concepto}
            onChange={setConcepto}
            placeholder="Ej.: hosting del servidor"
          />
          <Button fullWidth disabled={!puedeRegistrar} onClick={() => registrar.mutate()}>
            {registrar.isPending ? 'Registrando…' : 'Registrar'}
          </Button>
        </Card>
      ) : null}

      {tab === 'pendientes' ? (
        <Card className="space-y-3">
          <SectionTitle
            title="Dinero que los negocios le deben"
            hint={
              listaQuery.data?.meta?.pendingTotal
                ? `Total pendiente: ${formatMoney(listaQuery.data.meta.pendingTotal, moneda)}`
                : 'Adelantos suyos pendientes de devolución'
            }
          />

          {listaQuery.isLoading ? <Spinner label="Buscando…" /> : null}

          {!listaQuery.isLoading && pendientes.length === 0 ? (
            <EmptyState
              title="Ningún negocio le debe dinero"
              hint="Cuando pague algo de un negocio con su dinero, aparecerá aquí para que se lo devuelvan."
            />
          ) : null}

          <div className="space-y-2">
            {pendientes.map((fila) => (
              <div key={fila.id} className="rounded-lg border border-border-soft p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{fila.description}</p>
                    <p className="truncate text-xs text-faint">
                      {fila.companyEntity.name} · {fila.businessDate} · {ESTADO[fila.status]}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="money text-sm font-semibold text-ink">{formatMoney(fila.pending, fila.currency)}</p>
                    <p className="text-[0.7rem] text-faint">le deben</p>
                  </div>
                </div>

                {pagando?.id === fila.id ? (
                  <div className="mt-2 space-y-2 border-t border-border-soft pt-2">
                    <Select
                      label={`¿De qué cuenta de ${fila.companyEntity.name} sale?`}
                      value={pagando.cuentaId}
                      onChange={(valor) => setPagando({ ...pagando, cuentaId: valor })}
                      options={cuentasDeLaEmpresa}
                      placeholder="— Elija la cuenta del negocio —"
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={pagando.cuentaId === '' || pagar.isPending}
                        onClick={() => pagar.mutate({ id: fila.id, cuentaId: pagando.cuentaId })}
                      >
                        {pagar.isPending ? 'Devolviendo…' : `Devolver ${formatMoney(fila.pending, fila.currency)}`}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setPagando(null)}>
                        Cancelar
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2 w-full"
                    onClick={() => setPagando({ id: fila.id, empresaId: fila.companyEntity.id, cuentaId: '', monto: fila.pending })}
                  >
                    Que me lo devuelvan
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
