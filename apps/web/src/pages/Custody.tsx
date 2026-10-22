import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, newOperationId } from '../lib/api';
import { useAuth } from '../store/auth';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Kpi,
  Money,
  MoneyInput,
  Notice,
  SectionTitle,
  SegmentedControl,
  Select,
  Spinner,
  Tabs,
} from '../components/ui';
import { formatMoney, todayBusinessDate } from '../lib/format';

/**
 * FONDOS EN CUSTODIA — DINERO DE LA EMPRESA EN CUENTAS PERSONALES
 * ==============================================================
 * El caso real: el propietario cobra para FULLTECH o APPYRA y ese dinero cae en
 * su BHD o su Banreservas personal. El banco tiene ese dinero de verdad, pero NO
 * es suyo: es de la empresa.
 *
 * Esta pantalla contesta tres preguntas, en este orden:
 *
 *   1. ¿Cuánto hay realmente en cada cuenta?      → saldo real (el del extracto)
 *   2. ¿Cuánto de eso es de cada empresa?         → fondos bajo custodia
 *   3. ¿Cuánto es mío de verdad?                  → disponible personal neto
 *
 * Y permite hacer las tres cosas que hacen falta:
 *   · Registrar un dinero que YA estaba ahí antes de usar FINANZA (apertura: NO
 *     es una venta nueva y NO vuelve a cobrar facturas ya pagadas).
 *   · Registrar un cobro nuevo de la empresa que entra en la cuenta personal.
 *   · Liquidar (total, parcial o agrupada) hacia el banco de la empresa.
 *
 * Ojo: esto NO es un «procesador de pagos» (una pasarela que cobra con tarjeta).
 * Aquí el dinero ya está en una cuenta de banco real y sólo se aclara de quién es.
 */

type TabId = 'resumen' | 'registrar' | 'liquidar' | 'historial';
type ModoRegistro = 'APERTURA' | 'COBRO' | 'FACTURA' | 'GASTO';

interface CuentaResumen {
  accountId: string;
  accountName: string;
  entityId: string;
  entityName: string;
  ledgerCode: string;
  currency: string;
  realBalance: string;
  custody: string;
  personalNet: string;
  custodyByBeneficiary: Array<{ entityId: string; entityName: string; pending: string; funds: number }>;
}

interface ResumenCustodia {
  generatedAt: string;
  totals: { realBalance: string; custody: string; personalNet: string };
  byBeneficiary: Array<{ entityId: string; entityName: string; pending: string }>;
  accounts: CuentaResumen[];
}

interface FilaPendiente {
  beneficiaryEntityId: string;
  beneficiaryEntityName: string;
  holdingAccountId: string;
  holdingAccountName: string;
  holdingEntityName: string;
  currency: string;
  pending: string;
  funds: Array<{ id: string; businessDate: string; description: string; originalAmount: string; appliedAmount: string; remaining: string; status: string }>;
}

interface CuentaBancaria {
  id: string;
  entityId: string;
  name: string;
  type: string;
  currency: string;
  balance: string;
  isCreditCard: boolean;
  entity?: { id: string; name: string };
}

interface FondoHistorial {
  id: string;
  kind: string;
  beneficiaryEntityId: string;
  beneficiaryEntityName: string;
  holdingAccountName: string;
  holdingEntityName: string;
  businessDate: string;
  description: string;
  originalAmount: string;
  appliedAmount: string;
  remaining: string;
  status: string;
}

interface MovimientoHistorial {
  id: string;
  type: 'SETTLEMENT' | 'EXPENSE';
  status: string;
  beneficiaryEntityName: string;
  holdingAccountName: string;
  holdingEntityName: string;
  targetAccountName: string | null;
  amount: string;
  businessDate: string;
  description: string;
  fundsCovered: number;
  voidReason: string | null;
}

interface CategoriaOpcion {
  id: string;
  name: string;
  kind: 'INCOME' | 'EXPENSE';
}

interface CuentaPorCobrar {
  id: string;
  description: string;
  pendingAmount: string;
  status: string;
}

const ETIQUETA_ESTADO: Record<string, string> = {
  OPEN: 'sin liquidar',
  PARTIAL: 'liquidado en parte',
  SETTLED: 'liquidado',
  VOIDED: 'anulado',
  POSTED: 'confirmado',
};

const ETIQUETA_ORIGEN: Record<string, string> = {
  CUSTODY_OPENING: 'Ya estaba depositado',
  INCOME: 'Cobro nuevo',
  RECEIVABLE_SETTLEMENT: 'Cobro de factura',
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

export function CustodyPage() {
  const [params] = useSearchParams();
  const { entities, preferences } = useAuth();
  const queryClient = useQueryClient();
  const moneda = preferences?.currency ?? 'DOP';

  const [tab, setTab] = useState<TabId>('resumen');
  const [modo, setModo] = useState<ModoRegistro>('APERTURA');
  const [cuentaFiltro, setCuentaFiltro] = useState(params.get('cuenta') ?? '');
  const [empresaId, setEmpresaId] = useState('');
  const [cuentaId, setCuentaId] = useState(params.get('cuenta') ?? '');
  const [importe, setImporte] = useState('');
  const [fecha, setFecha] = useState(todayBusinessDate(preferences?.timezone));
  const [concepto, setConcepto] = useState('');
  const [categoriaId, setCategoriaId] = useState('');
  const [facturaId, setFacturaId] = useState('');
  const [mensaje, setMensaje] = useState<{ tono: 'positive' | 'negative' | 'warning'; texto: string } | null>(null);
  const [anulando, setAnulando] = useState<{ id: string; motivo: string } | null>(null);

  const resumenQuery = useQuery<ResumenCustodia>({
    queryKey: ['custodia-resumen', cuentaFiltro],
    queryFn: () => api.get<ResumenCustodia>(`/custody/summary${cuentaFiltro ? `?holdingAccountId=${cuentaFiltro}` : ''}`),
  });

  const pendienteQuery = useQuery<{ rows: FilaPendiente[]; total: string }>({
    queryKey: ['custodia-pendiente'],
    queryFn: () => api.get<{ rows: FilaPendiente[]; total: string }>('/custody/pending'),
  });

  const historialQuery = useQuery<{ funds: FondoHistorial[]; movements: MovimientoHistorial[] }>({
    queryKey: ['custodia-historial', cuentaFiltro],
    queryFn: () =>
      api.get<{ funds: FondoHistorial[]; movements: MovimientoHistorial[] }>(
        `/custody/movements?limit=40${cuentaFiltro ? `&holdingAccountId=${cuentaFiltro}` : ''}`,
      ),
  });

  const cuentasQuery = useQuery<unknown>({
    queryKey: ['cuentas-custodia'],
    queryFn: () => api.get<unknown>('/accounts?includeClosed=false'),
  });

  const categoriasQuery = useQuery<CategoriaOpcion[]>({
    queryKey: ['categorias-custodia', empresaId],
    queryFn: () => api.get<CategoriaOpcion[]>(`/categories${empresaId ? `?entityId=${empresaId}` : ''}`),
  });

  const facturasQuery = useQuery<CuentaPorCobrar[]>({
    queryKey: ['facturas-custodia', empresaId],
    enabled: modo === 'FACTURA' && empresaId !== '',
    queryFn: async () => {
      const respuesta = await api.get<unknown>(`/obligations/receivables?entityId=${empresaId}&limit=100`);
      return comoLista<CuentaPorCobrar>(respuesta).filter((fila) => Number(fila.pendingAmount) > 0);
    },
  });

  const cuentas = useMemo(() => comoLista<CuentaBancaria>(cuentasQuery.data), [cuentasQuery.data]);
  // Una tarjeta de crédito no puede custodiar dinero: no entra en la lista.
  const cuentasReales = useMemo(
    () => cuentas.filter((cuenta) => !cuenta.isCreditCard && cuenta.type !== 'CREDIT_CARD'),
    [cuentas],
  );

  const gruposCuentas = useMemo(() => {
    const porUnidad = new Map<string, CuentaBancaria[]>();
    for (const cuenta of cuentasReales) {
      porUnidad.set(cuenta.entityId, [...(porUnidad.get(cuenta.entityId) ?? []), cuenta]);
    }
    return [...porUnidad.entries()].map(([entityId, filas]) => ({
      label: entities.find((entity) => entity.id === entityId)?.name ?? filas[0]?.entity?.name ?? 'Unidad',
      options: filas.map((fila) => ({ value: fila.id, label: `${fila.name} (${formatMoney(fila.balance, fila.currency)})` })),
    }));
  }, [cuentasReales, entities]);

  const cuentaElegida = cuentasReales.find((cuenta) => cuenta.id === cuentaId);
  const mismaUnidad = Boolean(cuentaElegida && empresaId && cuentaElegida.entityId === empresaId);

  /** Empresas que pueden tener dinero en la cuenta elegida (siempre otra unidad). */
  const empresasPosibles = useMemo(
    () => entities.filter((entity) => !cuentaElegida || entity.id !== cuentaElegida.entityId),
    [entities, cuentaElegida],
  );

  const categoriasFiltradas = useMemo(() => {
    const lista = categoriasQuery.data ?? [];
    const tipo = modo === 'GASTO' ? 'EXPENSE' : 'INCOME';
    return lista.filter((categoria) => categoria.kind === tipo).map((categoria) => ({ value: categoria.id, label: categoria.name }));
  }, [categoriasQuery.data, modo]);

  const filasPendientes = pendienteQuery.data?.rows ?? [];
  const totalPendiente = pendienteQuery.data?.total ?? '0.00';

  const invalidar = async () => {
    await queryClient.invalidateQueries({ queryKey: ['custodia-resumen'] });
    await queryClient.invalidateQueries({ queryKey: ['custodia-pendiente'] });
    await queryClient.invalidateQueries({ queryKey: ['custodia-historial'] });
    await queryClient.invalidateQueries({ queryKey: ['cuentas-custodia'] });
    await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    await queryClient.invalidateQueries({ queryKey: ['accounts-all'] });
  };

  const registrar = useMutation({
    mutationFn: async () => {
      const base = {
        beneficiaryEntityId: empresaId,
        holdingAccountId: cuentaId,
        amount: importe,
        businessDate: fecha,
        description: concepto.trim(),
        clientOperationId: newOperationId(modo === 'APERTURA' ? 'cusap' : modo === 'GASTO' ? 'cusgas' : 'cus'),
      };

      if (modo === 'APERTURA') {
        return api.post('/custody/opening', base);
      }
      if (modo === 'GASTO') {
        return api.post('/custody/expense', { ...base, categoryId: categoriaId });
      }      if (modo === 'FACTURA') {
        return api.post('/custody/collect', { ...base, kind: 'RECEIVABLE_SETTLEMENT', receivableId: facturaId });
      }
      return api.post('/custody/collect', { ...base, kind: 'INCOME', ...(categoriaId ? { categoryId: categoriaId } : {}) });
    },
    onSuccess: async (datos) => {
      const duplicado = Boolean((datos as { duplicate?: boolean }).duplicate);
      setMensaje({
        tono: duplicado ? 'warning' : 'positive',
        texto: duplicado
          ? 'Esa operación ya estaba registrada: no se ha duplicado nada.'
          : modo === 'APERTURA'
            ? 'Fondos registrados. El saldo del banco NO cambia: sólo se aclara de quién es ese dinero.'
            : modo === 'GASTO'
              ? 'Gasto de la empresa pagado con el dinero en custodia. No cuenta como gasto suyo.'
              : 'Cobro registrado: sube el banco y la empresa reconoce el ingreso una sola vez.',
      });
      setImporte('');
      setConcepto('');
      setFacturaId('');
      await invalidar();
    },
    onError: (error) => {
      setMensaje({
        tono: 'negative',
        texto: error instanceof ApiError ? error.message : 'No se pudo registrar la operación.',
      });
    },
  });

  const [cuentaDestinoId, setCuentaDestinoId] = useState('');
  const [liquidarEmpresaId, setLiquidarEmpresaId] = useState('');
  const [liquidarCuentaOrigenId, setLiquidarCuentaOrigenId] = useState('');
  const [importeLiquidar, setImporteLiquidar] = useState('');

  const filaSeleccionada = filasPendientes.find(
    (fila) => fila.beneficiaryEntityId === liquidarEmpresaId && fila.holdingAccountId === liquidarCuentaOrigenId,
  );

  const cuentasDestino = useMemo(
    () =>
      cuentasReales
        .filter((cuenta) => cuenta.entityId === liquidarEmpresaId)
        .map((cuenta) => ({ value: cuenta.id, label: `${cuenta.name} (${formatMoney(cuenta.balance, cuenta.currency)})` })),
    [cuentasReales, liquidarEmpresaId],
  );

  const liquidar = useMutation({
    mutationFn: () =>
      api.post('/custody/settle', {
        beneficiaryEntityId: liquidarEmpresaId,
        holdingAccountId: liquidarCuentaOrigenId,
        targetAccountId: cuentaDestinoId,
        amount: importeLiquidar,
        businessDate: fecha,
        description: concepto.trim() || `Liquidación de fondos en custodia`,
        clientOperationId: newOperationId('cusliq'),
      }),
    onSuccess: async () => {
      setMensaje({
        tono: 'positive',
        texto:
          'Liquidación registrada. El dinero sale de la cuenta personal y entra en la de la empresa: no hay ingreso ni gasto nuevo.',
      });
      setImporteLiquidar('');
      setConcepto('');
      setCuentaDestinoId('');
      await invalidar();
    },
    onError: (error) => {
      setMensaje({ tono: 'negative', texto: error instanceof ApiError ? error.message : 'No se pudo liquidar.' });
    },
  });

  const anular = useMutation({
    mutationFn: (datos: { id: string; motivo: string }) =>
      api.post(`/custody/movements/${datos.id}/void`, { reason: datos.motivo }),
    onSuccess: async () => {
      setMensaje({ tono: 'positive', texto: 'Operación anulada con su reversa. El histórico se conserva.' });
      setAnulando(null);
      await invalidar();
    },
    onError: (error) => {
      setMensaje({ tono: 'negative', texto: error instanceof ApiError ? error.message : 'No se pudo anular.' });
    },
  });

  const puedeRegistrar =
    empresaId !== '' &&
    cuentaId !== '' &&
    !mismaUnidad &&
    importe !== '' &&
    Number(importe) > 0 &&
    concepto.trim().length >= 3 &&
    (modo !== 'GASTO' || categoriaId !== '') &&
    (modo !== 'FACTURA' || facturaId !== '') &&
    !registrar.isPending;

  if (resumenQuery.isLoading) {
    return <Spinner label="Calculando cuánto dinero hay y de quién es…" />;
  }

  if (resumenQuery.isError && !resumenQuery.data) {
    return (
      <EmptyState
        title="No se pudo consultar el dinero en custodia"
        hint="Hace falta conexión: los saldos de los bancos se calculan en el servidor y no se copian en el teléfono."
        action={
          <Button variant="secondary" onClick={() => void resumenQuery.refetch()}>
            Reintentar
          </Button>
        }
      />
    );
  }

  const resumen = resumenQuery.data!;

  return (
    <div className="space-y-4">
      <Card className="space-y-2">
        <SectionTitle
          title="Fondos en custodia"
          hint="Dinero de sus empresas que está en sus cuentas personales (BHD, Banreservas…)"
        />
        <p className="text-xs leading-snug text-muted">
          No es un procesador de pagos: aquí el dinero <strong>ya está</strong> en su banco. Lo que se aclara es de
          quién es, para que los saldos coincidan con el extracto y los ingresos no se cuenten dos veces.
        </p>
      </Card>

      <Tabs
        tabs={[
          { id: 'resumen' as TabId, label: 'De quién es' },
          { id: 'registrar' as TabId, label: 'Registrar' },
          { id: 'liquidar' as TabId, label: 'Liquidar' },
          { id: 'historial' as TabId, label: 'Historial' },
        ]}
        active={tab}
        onChange={(id) => {
          setTab(id);
          setMensaje(null);
        }}
      />

      {mensaje ? <Notice tone={mensaje.tono}>{mensaje.texto}</Notice> : null}

      {/* ------------------------------------------------------------------ */}
      {/* 1. De quién es el dinero                                            */}
      {/* ------------------------------------------------------------------ */}
      {tab === 'resumen' ? (
        <>
          <Card>
            <SectionTitle title="Totales" hint="Suma de todas sus cuentas reales (sin tarjetas de crédito)" />
            <div className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-3">
              <Kpi label="Saldo real" value={resumen.totals.realBalance} currency={moneda} hint="Lo que dice el banco" />
              <Kpi
                label="De empresas"
                value={resumen.totals.custody}
                tone="warning"
                currency={moneda}
                hint="Bajo custodia, pendiente de liquidar"
              />
              <Kpi
                label="Suyo de verdad"
                value={resumen.totals.personalNet}
                tone={Number(resumen.totals.personalNet) < 0 ? 'negative' : 'positive'}
                currency={moneda}
                hint="Saldo real − dinero de empresas"
              />
            </div>

            {resumen.byBeneficiary.length > 0 ? (
              <div className="mt-3 space-y-1 border-t border-border-soft pt-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">Por empresa</p>
                {resumen.byBeneficiary.map((fila) => (
                  <div key={fila.entityId} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate text-ink">{fila.entityName}</span>
                    <Money value={fila.pending} currency={moneda} tone="warning" />
                  </div>
                ))}
              </div>
            ) : null}
          </Card>

          <Card>
            <SectionTitle
              title="Cuenta por cuenta"
              hint="El saldo real siempre coincide con el extracto del banco"
              right={
                resumen.accounts.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCuentaFiltro(cuentaFiltro === '' ? resumen.accounts[0]?.accountId ?? '' : '')}
                  >
                    {cuentaFiltro === '' ? 'Ver una' : 'Ver todas'}
                  </Button>
                ) : undefined
              }
            />

            {resumen.accounts.length === 0 ? (
              <EmptyState
                title="Todavía no hay cuentas reales"
                hint="Cree sus cuentas (BHD, Banreservas…) en Cuentas y bancos con el saldo que figura hoy en el banco."
              />
            ) : null}

            <div className="space-y-3">
              {resumen.accounts.map((cuenta) => (
                <div key={cuenta.accountId} className="rounded-lg border border-border-soft p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{cuenta.accountName}</p>
                      <p className="truncate text-xs text-faint">{cuenta.entityName}</p>
                    </div>
                    <div className="text-right">
                      <Money value={cuenta.realBalance} currency={cuenta.currency} />
                      <p className="text-[0.7rem] text-faint">saldo real</p>
                    </div>
                  </div>

                  {cuenta.custodyByBeneficiary.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {cuenta.custodyByBeneficiary.map((fila) => (
                        <div key={fila.entityId} className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate text-muted">
                            Es de <strong className="text-ink">{fila.entityName}</strong>
                            {fila.funds > 1 ? ` (${fila.funds} fondos)` : ''}
                          </span>
                          <Money value={fila.pending} currency={cuenta.currency} tone="warning" />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-faint">Sin dinero de empresas: todo es suyo.</p>
                  )}

                  <div className="mt-2 flex items-center justify-between gap-2 border-t border-border-soft pt-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted">Suyo de verdad</span>
                    <Money
                      value={cuenta.personalNet}
                      currency={cuenta.currency}
                      tone={Number(cuenta.personalNet) < 0 ? 'negative' : 'positive'}
                      className="font-semibold"
                    />
                  </div>

                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2 w-full"
                    onClick={() => {
                      setCuentaId(cuenta.accountId);
                      setEmpresaId('');
                      setCuentaFiltro(cuenta.accountId);
                      setTab('registrar');
                      setMensaje(null);
                    }}
                  >
                    Registrar dinero de una empresa en esta cuenta
                  </Button>
                </div>
              ))}
            </div>
          </Card>
        </>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* 2. Registrar                                                        */}
      {/* ------------------------------------------------------------------ */}
      {tab === 'registrar' ? (
        <Card className="space-y-3">
          <SectionTitle title="Registrar dinero de una empresa" hint="Elija de quién es el dinero y en qué cuenta suya está" />

          <SegmentedControl<ModoRegistro>
            options={[
              { value: 'APERTURA', label: 'Ya estaba ahí' },
              { value: 'COBRO', label: 'Cobro nuevo' },
              { value: 'FACTURA', label: 'Cobro de factura' },
              { value: 'GASTO', label: 'Gasto de la empresa' },
            ]}
            value={modo}
            onChange={(valor) => {
              setModo(valor);
              setMensaje(null);
            }}
          />

          {modo === 'APERTURA' ? (
            <Notice tone="info" title="Dinero que ya estaba en el banco antes de FINANZA">
              No se registra nada como venta nueva ni se vuelve a cobrar una factura ya pagada. Sólo se aclara qué parte
              del saldo que ya tiene en el banco pertenece a la empresa. El saldo del banco no cambia.
            </Notice>
          ) : null}
          {modo === 'COBRO' ? (
            <Notice tone="info" title="Cobro nuevo para la empresa">
              La empresa reconoce el ingreso una sola vez y su banco personal sube el importe real que entró.
            </Notice>
          ) : null}
          {modo === 'FACTURA' ? (
            <Notice tone="info" title="Cobro de una factura que ya estaba registrada">
              Baja la cuenta por cobrar de la empresa. No se reconoce un ingreso nuevo, porque ya se reconoció al emitir
              la factura.
            </Notice>
          ) : null}
          {modo === 'GASTO' ? (
            <Notice tone="info" title="Gasto de la empresa pagado con dinero en custodia">
              El gasto es de la empresa (no suyo) y descuenta ese dinero de lo que hay pendiente de liquidar.
            </Notice>
          ) : null}

          <Select
            label="¿De qué empresa es el dinero?"
            value={empresaId}
            onChange={setEmpresaId}
            options={empresasPosibles.map((entity) => ({ value: entity.id, label: entity.name }))}
            placeholder="— Elija la empresa dueña del dinero —"
          />

          <Select
            label="¿En qué cuenta suya está?"
            value={cuentaId}
            onChange={setCuentaId}
            groups={gruposCuentas}
            placeholder="— Elija su cuenta (BHD, Banreservas…) —"
            hint="Sólo cuentas reales: una tarjeta de crédito no puede custodiar dinero."
          />

          {mismaUnidad ? (
            <Notice tone="negative">
              Esa cuenta pertenece a la misma empresa. Si el dinero ya es suyo, regístrelo como ingreso normal en
              Movimientos: no es custodia.
            </Notice>
          ) : null}

          {cuentaElegida ? (
            <p className="text-xs text-muted">
              Saldo real de {cuentaElegida.name}:{' '}
              <strong className="text-ink">{formatMoney(cuentaElegida.balance, cuentaElegida.currency)}</strong>
            </p>
          ) : null}

          {modo === 'FACTURA' ? (
            <Select
              label="¿Qué factura se cobró?"
              value={facturaId}
              onChange={setFacturaId}
              options={(facturasQuery.data ?? []).map((factura) => ({
                value: factura.id,
                label: `${factura.description} — pendiente ${formatMoney(factura.pendingAmount, moneda)}`,
              }))}
              placeholder={empresaId ? '— Elija la factura —' : '— Primero elija la empresa —'}
              hint={facturasQuery.isLoading ? 'Buscando facturas pendientes…' : undefined}
            />
          ) : null}

          {modo === 'COBRO' || modo === 'GASTO' ? (
            <Select
              label={modo === 'GASTO' ? 'Categoría del gasto de la empresa' : 'Categoría del ingreso (opcional)'}
              value={categoriaId}
              onChange={setCategoriaId}
              options={categoriasFiltradas}
              placeholder={modo === 'GASTO' ? '— Elija la categoría —' : '— Sin categoría concreta —'}
            />
          ) : null}

          <MoneyInput label="Importe" value={importe} onChange={setImporte} />
          <Field
            label="Concepto"
            value={concepto}
            onChange={setConcepto}
            placeholder="Ej.: cobros de FULLTECH ya depositados / venta de equipos"
          />
          <Field label="Fecha" value={fecha} onChange={setFecha} type="date" />

          <Button fullWidth disabled={!puedeRegistrar} onClick={() => registrar.mutate()}>
            {registrar.isPending ? 'Registrando…' : 'Guardar registro'}
          </Button>
        </Card>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* 3. Liquidar                                                         */}
      {/* ------------------------------------------------------------------ */}
      {tab === 'liquidar' ? (
        <Card className="space-y-3">
          <SectionTitle
            title="Liquidar hacia la empresa"
            hint="Traspasa el dinero de su cuenta personal a la cuenta de la empresa"
          />

          {pendienteQuery.isLoading ? <Spinner label="Buscando fondos pendientes…" /> : null}

          {filasPendientes.length === 0 && !pendienteQuery.isLoading ? (
            <EmptyState
              title="No hay dinero de empresas pendiente de liquidar"
              hint="Cuando registre un cobro o un dinero que ya estaba depositado, aparecerá aquí para liquidarlo."
            />
          ) : null}

          {filasPendientes.length > 0 ? (
            <>
              <p className="text-xs text-muted">
                Pendiente total: <strong className="text-warning">{formatMoney(totalPendiente, moneda)}</strong>
              </p>

              <div className="space-y-2">
                {filasPendientes.map((fila) => {
                  const activa =
                    fila.beneficiaryEntityId === liquidarEmpresaId && fila.holdingAccountId === liquidarCuentaOrigenId;
                  return (
                    <button
                      key={`${fila.beneficiaryEntityId}-${fila.holdingAccountId}`}
                      type="button"
                      onClick={() => {
                        setLiquidarEmpresaId(fila.beneficiaryEntityId);
                        setLiquidarCuentaOrigenId(fila.holdingAccountId);
                        setImporteLiquidar(fila.pending);
                        setCuentaDestinoId('');
                      }}
                      className={`flex w-full items-start justify-between gap-2 rounded-lg border p-3 text-left transition ${
                        activa ? 'border-brand bg-brand/5' : 'border-border-soft hover:bg-surface-2'
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink">{fila.beneficiaryEntityName}</p>
                        <p className="truncate text-xs text-faint">
                          en {fila.holdingAccountName} · {fila.funds.length} fondo(s)
                        </p>
                      </div>
                      <Money value={fila.pending} currency={fila.currency} tone="warning" />
                    </button>
                  );
                })}
              </div>

              {filaSeleccionada ? (
                <>
                  <div className="space-y-1 rounded-lg border border-border-soft p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted">Fondos que se liquidan</p>
                    <p className="text-[0.7rem] text-faint">
                      Se pagan del más antiguo al más nuevo; puede liquidar todo o una parte.
                    </p>
                    {filaSeleccionada.funds.map((fondo) => (
                      <div key={fondo.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate text-muted">
                          {fondo.businessDate} · {fondo.description}
                        </span>
                        <Money value={fondo.remaining} currency={filaSeleccionada.currency} />
                      </div>
                    ))}
                  </div>

                  <Select
                    label={`¿A qué cuenta de ${filaSeleccionada.beneficiaryEntityName} entra?`}
                    value={cuentaDestinoId}
                    onChange={setCuentaDestinoId}
                    options={cuentasDestino}
                    placeholder={
                      cuentasDestino.length === 0 ? '— Esa empresa no tiene ninguna cuenta: cree una —' : '— Elija la cuenta destino —'
                    }
                  />

                  <MoneyInput
                    label="Importe a liquidar"
                    value={importeLiquidar}
                    onChange={setImporteLiquidar}
                    hint={`Pendiente: ${formatMoney(filaSeleccionada.pending, filaSeleccionada.currency)}. Puede liquidar una parte.`}
                  />

                  {Number(importeLiquidar) > Number(filaSeleccionada.pending) ? (
                    <Notice tone="warning" title="Es más de lo pendiente">
                      Sólo hay {formatMoney(filaSeleccionada.pending, filaSeleccionada.currency)} pendientes. Si el dinero
                      entró de verdad, registre primero el cobro que falta.
                    </Notice>
                  ) : null}

                  <Field label="Concepto (opcional)" value={concepto} onChange={setConcepto} placeholder="Ej.: transferencia a la cuenta de la empresa" />
                  <Field label="Fecha" value={fecha} onChange={setFecha} type="date" />

                  <Button
                    fullWidth
                    disabled={
                      cuentaDestinoId === '' ||
                      importeLiquidar === '' ||
                      Number(importeLiquidar) <= 0 ||
                      Number(importeLiquidar) > Number(filaSeleccionada.pending) ||
                      liquidar.isPending
                    }
                    onClick={() => liquidar.mutate()}
                  >
                    {liquidar.isPending ? 'Liquidando…' : 'Confirmar liquidación'}
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
        </Card>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* 4. Historial                                                        */}
      {/* ------------------------------------------------------------------ */}
      {tab === 'historial' ? (
        <>
          <Card>
            <SectionTitle title="Liquidaciones y gastos" hint="Se pueden anular: la anulación deja su rastro, no borra" />
            {historialQuery.isLoading ? <Spinner /> : null}
            {historialQuery.data && historialQuery.data.movements.length === 0 ? (
              <EmptyState title="Todavía no hay liquidaciones ni gastos" />
            ) : null}
            <div className="space-y-2">
              {(historialQuery.data?.movements ?? []).map((movimiento) => (
                <div key={movimiento.id} className="rounded-lg border border-border-soft p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                        {movimiento.type === 'SETTLEMENT' ? 'Liquidación' : 'Gasto de la empresa'}
                        <Badge tone={movimiento.status === 'VOIDED' ? 'neutral' : 'positive'}>
                          {ETIQUETA_ESTADO[movimiento.status] ?? movimiento.status}
                        </Badge>
                      </p>
                      <p className="truncate text-xs text-faint">
                        {movimiento.businessDate} · {movimiento.beneficiaryEntityName} · desde {movimiento.holdingAccountName}
                        {movimiento.targetAccountName ? ` → ${movimiento.targetAccountName}` : ''}
                      </p>
                      <p className="truncate text-xs text-muted">{movimiento.description}</p>
                    </div>
                    <Money value={movimiento.amount} currency={moneda} tone="neutral" className="font-semibold" />
                  </div>

                  {movimiento.voidReason ? (
                    <p className="mt-1 text-xs text-faint">Anulado: {movimiento.voidReason}</p>
                  ) : null}

                  {movimiento.status === 'POSTED' ? (
                    anulando?.id === movimiento.id ? (
                      <div className="mt-2 space-y-2">
                        <Field
                          label="Motivo de la anulación"
                          value={anulando.motivo}
                          onChange={(valor) => setAnulando({ id: movimiento.id, motivo: valor })}
                          hint="Queda en la auditoría. No se borra ningún movimiento: se hace su reversa."
                        />
                        <div className="flex gap-2">
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={anulando.motivo.trim().length < 5 || anular.isPending}
                            onClick={() => anular.mutate({ id: movimiento.id, motivo: anulando.motivo.trim() })}
                          >
                            {anular.isPending ? 'Anulando…' : 'Confirmar anulación'}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setAnulando(null)}>
                            Cancelar
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAnulando({ id: movimiento.id, motivo: '' })}>
                        Anular
                      </Button>
                    )
                  ) : null}
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <SectionTitle title="Cobros y fondos que ya estaban" hint="Cada peso, con lo que ya se liquidó" />
            {historialQuery.data && historialQuery.data.funds.length === 0 ? (
              <EmptyState title="Todavía no hay fondos de empresas registrados" />
            ) : null}
            <div className="space-y-2">
              {(historialQuery.data?.funds ?? []).map((fondo) => (
                <div key={fondo.id} className="rounded-lg border border-border-soft p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                        {fondo.beneficiaryEntityName}
                        <Badge tone="info">{ETIQUETA_ORIGEN[fondo.kind] ?? fondo.kind}</Badge>
                        {fondo.status !== 'SETTLED' ? (
                          <Badge tone="warning">{ETIQUETA_ESTADO[fondo.status] ?? fondo.status}</Badge>
                        ) : null}
                      </p>
                      <p className="truncate text-xs text-faint">
                        {fondo.businessDate} · {fondo.holdingAccountName} ({fondo.holdingEntityName})
                      </p>
                      <p className="truncate text-xs text-muted">{fondo.description}</p>
                    </div>
                    <div className="text-right">
                      <Money value={fondo.originalAmount} currency={moneda} />
                      <p className="text-[0.7rem] text-faint">
                        queda {formatMoney(fondo.remaining, moneda)}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
