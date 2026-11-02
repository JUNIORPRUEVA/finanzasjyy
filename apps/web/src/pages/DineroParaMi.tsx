import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Button, Card, EmptyState, Field, MoneyInput, Notice, SectionTitle, Select, Spinner } from '../components/ui';
import { useAuth } from '../store/auth';
import { formatMoney, todayBusinessDate } from '../lib/format';

/**
 * «DINERO PARA MÍ» — DE LA EMPRESA A MI CUENTA
 * --------------------------------------------
 * Antes había un agujero: el retiro bajaba el banco de la empresa, pero el
 * dinero no entraba en ninguna cuenta personal; se quedaba «en el aire». Y
 * moverlo con un traspaso estaba bloqueado, con razón, porque cruzar de una
 * persona jurídica a otra es retirada, préstamo, reembolso o nómina, y hay que
 * saber cuál.
 *
 * Esta pantalla pide lo único que falta para poder contabilizarlo bien:
 *
 *   ¿Qué es este dinero?
 *     · Es mi dinero (me lo llevo)          → no es ingreso en ningún lado
 *     · La empresa me lo presta (lo devolveré) → nace una deuda, exige contrato
 *
 * Con eso el servidor escribe dos asientos: uno en la empresa y otro en las
 * finanzas personales. Las dos cuentas bancarias cuadran con el extracto y no
 * aparece ningún ingreso ni gasto inventado.
 */

interface AccountRow {
  id: string;
  entityId: string;
  name: string;
  currency: string;
  balance: string;
  isCreditCard: boolean;
  entity?: { id: string; name: string } | null;
}

interface TransferRow {
  id: string;
  amount: string;
  currency: string;
  businessDate: string;
  description: string;
  fromAccount?: { id: string; name: string } | null;
  toAccount?: { id: string; name: string } | null;
}

type Naturaleza = 'WITHDRAWAL' | 'LOAN';

function comoLista<T>(valor: unknown): T[] {
  if (Array.isArray(valor)) {
    return valor as T[];
  }
  if (valor && typeof valor === 'object' && Array.isArray((valor as { data?: unknown }).data)) {
    return (valor as { data: T[] }).data;
  }
  return [];
}

const OPCIONES: { valor: Naturaleza; titulo: string; detalle: string }[] = [
  {
    valor: 'WITHDRAWAL',
    titulo: 'Es mi dinero, me lo llevo',
    detalle: 'No es un ingreso suyo ni un gasto de la empresa: es su dinero saliendo de la empresa.',
  },
  {
    valor: 'LOAN',
    titulo: 'La empresa me lo presta y lo devolveré',
    detalle: 'Queda una deuda suya con la empresa. Necesita la referencia del contrato o del acuerdo.',
  },
];

export function DineroParaMiPage() {
  const { entities, preferences } = useAuth();
  const queryClient = useQueryClient();
  const moneda = preferences?.currency ?? 'DOP';

  const cuentasQuery = useQuery<unknown>({
    queryKey: ['cuentas-dinero-para-mi'],
    queryFn: () => api.get<unknown>('/accounts?includeClosed=false'),
  });
  const historialQuery = useQuery<unknown>({
    queryKey: ['traspasos-dinero-para-mi'],
    queryFn: () => api.get<unknown>('/transfers?limit=20'),
  });

  const [empresaId, setEmpresaId] = useState('');
  const [cuentaEmpresaId, setCuentaEmpresaId] = useState('');
  const [cuentaPersonalId, setCuentaPersonalId] = useState('');
  const [importe, setImporte] = useState('');
  const [naturaleza, setNaturaleza] = useState<Naturaleza>('WITHDRAWAL');
  const [documento, setDocumento] = useState('');
  const [concepto, setConcepto] = useState('');
  const [fecha, setFecha] = useState(todayBusinessDate());
  const [busy, setBusy] = useState(false);
  const [mensaje, setMensaje] = useState<{ tono: 'positive' | 'negative' | 'warning'; texto: string } | null>(null);

  const cuentas = useMemo(() => comoLista<AccountRow>(cuentasQuery.data), [cuentasQuery.data]);

  /** Unidades que NO son sus finanzas personales: de donde puede salir el dinero. */
  const negocios = useMemo(
    () =>
      entities
        .filter((entity) => entity.type !== 'PERSONAL')
        .map((entity) => ({ value: entity.id, label: entity.name })),
    [entities],
  );

  const personales = useMemo(
    () => entities.filter((entity) => entity.type === 'PERSONAL'),
    [entities],
  );

  const cuentasDelNegocio = useMemo(
    () =>
      cuentas
        .filter((cuenta) => cuenta.entityId === empresaId && !cuenta.isCreditCard)
        .map((cuenta) => ({
          value: cuenta.id,
          label: `${cuenta.name} (${formatMoney(cuenta.balance, cuenta.currency)})`,
        })),
    [cuentas, empresaId],
  );

  const cuentasPersonales = useMemo(
    () =>
      cuentas
        .filter((cuenta) => personales.some((entity) => entity.id === cuenta.entityId) && !cuenta.isCreditCard)
        .map((cuenta) => ({
          value: cuenta.id,
          label: `${cuenta.name} (${formatMoney(cuenta.balance, cuenta.currency)})`,
        })),
    [cuentas, personales],
  );

  const cuentaEmpresa = cuentas.find((cuenta) => cuenta.id === cuentaEmpresaId);
  const cuentaPersonal = cuentas.find((cuenta) => cuenta.id === cuentaPersonalId);

  const excedeSaldo =
    cuentaEmpresa !== undefined && importe !== '' && Number(importe) > Number(cuentaEmpresa.balance);

  const faltaDocumento = naturaleza === 'LOAN' && documento.trim() === '';

  const puedeGuardar =
    cuentaEmpresaId !== '' &&
    cuentaPersonalId !== '' &&
    importe !== '' &&
    Number(importe) > 0 &&
    !faltaDocumento &&
    !busy;

  const descripcion =
    concepto.trim() ||
    (cuentaEmpresa && cuentaPersonal ? `De ${cuentaEmpresa.name} a ${cuentaPersonal.name}` : 'Dinero para mí');

  const guardar = async () => {
    setMensaje(null);
    setBusy(true);
    try {
      await api.post('/transfers', {
        fromAccountId: cuentaEmpresaId,
        toAccountId: cuentaPersonalId,
        amount: importe,
        businessDate: fecha,
        description: descripcion,
        nature: naturaleza,
        documentRef: naturaleza === 'LOAN' ? documento.trim() : undefined,
      });

      setMensaje({
        tono: 'positive',
        texto:
          naturaleza === 'WITHDRAWAL'
            ? 'Listo: el dinero ya está en su cuenta personal. Salió de la empresa y no cuenta como ingreso en ninguna de las dos.'
            : 'Listo: el dinero ya está en su cuenta personal y quedó anotada la deuda con la empresa.',
      });
      setImporte('');
      setConcepto('');
      setDocumento('');
      await queryClient.invalidateQueries();
    } catch (caught) {
      setMensaje({
        tono: 'negative',
        texto: caught instanceof ApiError ? caught.message : 'No se pudo registrar el movimiento.',
      });
    } finally {
      setBusy(false);
    }
  };

  const historial = useMemo(() => {
    const filas = comoLista<TransferRow>(historialQuery.data);
    // Sólo lo que va de un negocio a las finanzas personales.
    const idsPersonales = new Set(personales.map((entity) => entity.id));
    const idsCuentasPersonales = new Set(cuentas.filter((c) => idsPersonales.has(c.entityId)).map((c) => c.id));
    return filas.filter((fila) => fila.toAccount && idsCuentasPersonales.has(fila.toAccount.id)).slice(0, 8);
  }, [historialQuery.data, cuentas, personales]);

  const sinCuentasPersonales = !cuentasQuery.isLoading && cuentasPersonales.length === 0;

  return (
    <div className="space-y-4">
      <Card className="space-y-2">
        <SectionTitle
          title="Dinero para mí"
          hint="Sacar dinero de un negocio a su cuenta personal"
        />
        <p className="text-xs leading-snug text-muted">
          El dinero sale de la cuenta del negocio y <strong>entra en la suya</strong>. No es un ingreso: no aumenta lo
          que gana, sólo cambia de sitio. Díganos qué es para anotarlo bien.
        </p>
      </Card>

      {cuentasQuery.isLoading ? <Spinner label="Cargando cuentas…" /> : null}

      {cuentasQuery.isError ? (
        <EmptyState
          title="No se pudieron consultar las cuentas"
          hint="Este movimiento necesita los saldos reales del servidor. Conéctese para hacerlo."
        />
      ) : null}

      {sinCuentasPersonales ? (
        <EmptyState
          title="No tiene cuentas personales"
          hint="Cree una cuenta en sus finanzas personales (por ejemplo «Banco personal») para poder recibir el dinero."
        />
      ) : null}

      {cuentas.length > 0 && !sinCuentasPersonales ? (
        <Card className="space-y-3">
          <Select
            label="¿De qué negocio sale el dinero?"
            value={empresaId}
            onChange={(valor) => {
              setEmpresaId(valor);
              setCuentaEmpresaId('');
            }}
            options={negocios}
            placeholder="— Elija el negocio —"
          />

          <Select
            label="¿De qué cuenta del negocio?"
            value={cuentaEmpresaId}
            onChange={setCuentaEmpresaId}
            options={cuentasDelNegocio}
            placeholder={empresaId === '' ? '— Primero elija el negocio —' : '— Elija la cuenta —'}
          />

          <Select
            label="¿A qué cuenta suya llega?"
            value={cuentaPersonalId}
            onChange={setCuentaPersonalId}
            options={cuentasPersonales}
            placeholder="— Elija su cuenta personal —"
          />

          <MoneyInput
            label="¿Cuánto?"
            value={importe}
            onChange={setImporte}
            hint={
              cuentaEmpresa
                ? `Saldo disponible en la cuenta del negocio: ${formatMoney(cuentaEmpresa.balance, cuentaEmpresa.currency)}.`
                : undefined
            }
          />

          {excedeSaldo ? (
            <Notice tone="warning" title="Más que el saldo de la cuenta">
              La cuenta del negocio quedaría en negativo. Si es correcto (un descubierto acordado), puede continuar;
              quedará registrado.
            </Notice>
          ) : null}

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-muted">¿Qué es este dinero?</legend>
            {OPCIONES.map((opcion) => (
              <label
                key={opcion.valor}
                className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition ${
                  naturaleza === opcion.valor ? 'border-ink/30 bg-surface-2' : 'border-border-soft'
                }`}
              >
                <input
                  type="radio"
                  name="naturaleza-dinero"
                  value={opcion.valor}
                  checked={naturaleza === opcion.valor}
                  onChange={() => {
                    setNaturaleza(opcion.valor);
                    setMensaje(null);
                  }}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-ink">{opcion.titulo}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted">{opcion.detalle}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {naturaleza === 'LOAN' ? (
            <Field
              label="Referencia del contrato o acuerdo"
              value={documento}
              onChange={setDocumento}
              placeholder="Ej.: CONTRATO-2026-01"
              hint="Un préstamo tiene que estar documentado; sin referencia no se registra."
            />
          ) : null}

          <Field
            label="Concepto (opcional)"
            value={concepto}
            onChange={setConcepto}
            placeholder="Ej.: retiro mensual"
            hint={concepto.trim() === '' ? `Si lo deja vacío se guardará como «${descripcion}».` : undefined}
          />

          <Field label="Fecha" value={fecha} onChange={setFecha} type="date" />

          {mensaje ? <Notice tone={mensaje.tono}>{mensaje.texto}</Notice> : null}

          <Button fullWidth disabled={!puedeGuardar} onClick={() => void guardar()}>
            {busy ? 'Registrando…' : 'Pasar el dinero a mi cuenta'}
          </Button>
        </Card>
      ) : null}

      {historial.length > 0 ? (
        <Card>
          <SectionTitle title="Últimos movimientos a mi cuenta" hint="Salida del negocio y entrada en la suya" />
          <div className="space-y-2">
            {historial.map((fila) => (
              <div key={fila.id} className="flex items-start justify-between gap-2 rounded-lg border border-border-soft p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{fila.description}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {fila.fromAccount?.name ?? 'negocio'} → {fila.toAccount?.name ?? 'personal'}
                  </p>
                </div>
                <span className="shrink-0 text-sm text-ink">{formatMoney(fila.amount, fila.currency || moneda)}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <p className="pb-4 text-center text-xs text-faint">
        Sacar dinero de la empresa nunca es un ingreso suyo: o es su dinero, o es una deuda que queda anotada.
      </p>
    </div>
  );
}
