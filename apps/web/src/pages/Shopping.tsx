import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  activarModoTienda,
  api,
  ApiError,
  desactivarModoTienda,
  modoTiendaActivo,
} from '../lib/api';
import { useAuth } from '../store/auth';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Fab,
  Field,
  ListScreen,
  Money,
  Notice,
  ProgressBar,
  Sheet,
  Skeleton,
  Spinner,
} from '../components/ui';
import { toast } from '../components/Toast';
import { IconBag, IconChart, IconChevronLeft, IconChevronRight, IconClose, IconFile, IconSearch } from '../components/icons';
import {
  createListOffline,
  flushShoppingQueue,
  loadShoppingLists,
  type RemoteShoppingList,
} from '../lib/shopping-offline';
import { countShoppingPending, getLocalShoppingLists, removeLocalShoppingList } from '../lib/db';
import { todayBusinessDate } from '../lib/format';
import { formatMoney } from '../lib/format';
import { fileToDataUrl, MAX_FACTURA_MB, prepareInvoiceFile } from '../lib/invoice-file';
import { FacturaLineasEditor, type FacturaLinea } from '../components/FacturaLineasEditor';

/**
 * COMPRAS PERSONALES — LISTAS
 * ===========================
 * Preparar la compra antes de gastar: qué hace falta, cuánto costará y cuánto se
 * gastó de verdad. Nada de esto mueve dinero: el gasto se registra aparte, desde
 * la lista, y por el camino financiero de siempre.
 *
 * Se puede montar la lista sin conexión (en el supermercado la cobertura falla).
 * Mientras haya cambios sin enviar, se dice claramente: «pendiente de enviar».
 */

type Filtro = 'ABIERTAS' | 'FINALIZADAS' | 'TODAS';

/** Análisis del historial que calcula el servidor (sin IA). */
interface Analisis {
  totals: { purchases: number; spent: number; averageTicket: number | null; since: string | null; until: string | null };
  tips: string[];
  topProducts: Array<{ name: string; times: number; lastPrice: number | null; changePct: number | null }>;
  priceIncreases: Array<{ name: string; from: number; to: number; changePct: number }>;
  balance: {
    groups: Array<{ group: string; label: string; products: number; share: number }>;
    ultraProcessedShare: number;
    score: number;
  };
  ai: { configured: boolean; model: string | null };
}

/** Tarjeta compacta: una línea con el gasto y el acceso al detalle. */
function SugerenciasCard({
  insights,
  currency,
  onAbrir,
}: {
  insights: Analisis | null;
  currency: string;
  onAbrir: () => void;
}) {
  if (!insights || insights.totals.purchases === 0) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={onAbrir}
      className="flex w-full items-center gap-2 border border-border-soft bg-surface p-2.5 text-left transition hover:border-brand/40"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-brand/10 text-brand">
        <IconChart size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">Sugerencias de compra</span>
        <span className="block truncate text-[0.7rem] text-muted">
          {insights.totals.purchases} compra(s) · {formatMoney(String(insights.totals.spent), currency)} en total
        </span>
      </span>
      <IconChevronRight size={18} className="shrink-0 text-faint" />
    </button>
  );
}

export function ShoppingPage() {
  const { entities, preferences } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const entityId = params.get('entityId') ?? '';

  const [lists, setLists] = useState<RemoteShoppingList[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtro, setFiltro] = useState<Filtro>('ABIERTAS');
  const [busqueda, setBusqueda] = useState('');
  const [buscando, setBuscando] = useState(false);
  const [pending, setPending] = useState(0);
  // Modo tienda: trabajar sin esperar al servidor (la señal del súper va y viene).
  const [modoTienda, setModoTienda] = useState(() => modoTiendaActivo());

  const [creating, setCreating] = useState(false);
  // Sugerencias calculadas con el historial real de compras.
  const [insights, setInsights] = useState<Analisis | null>(null);
  const [sugerenciasOpen, setSugerenciasOpen] = useState(false);
  const [consejoIA, setConsejoIA] = useState<{ title: string; tips: string[]; suggestedList: Array<{ name: string; reason: string }> } | null>(null);
  const [consejoCargando, setConsejoCargando] = useState(false);
  const [consejoError, setConsejoError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newEntityId, setNewEntityId] = useState(entityId || entities[0]?.id || '');
  const [newDate, setNewDate] = useState(todayBusinessDate(preferences?.timezone));
  const [newNotes, setNewNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const [toDelete, setToDelete] = useState<RemoteShoppingList | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /*
   * COMPRA DESDE UNA FACTURA
   * -----------------------
   * El mismo lector que hay dentro de una compra, pero antes de crearla: se hace
   * la foto, la IA escribe los productos con su precio y la compra nace ya con
   * todo lo comprado. Así no hay que teclear nada en el supermercado.
   */
  const [facturaOpen, setFacturaOpen] = useState(false);
  const [facturaCargando, setFacturaCargando] = useState(false);
  const [facturaGuardando, setFacturaGuardando] = useState(false);
  const [facturaError, setFacturaError] = useState<string | null>(null);
  const [facturaAvisos, setFacturaAvisos] = useState<string[]>([]);
  const [facturaLineas, setFacturaLineas] = useState<FacturaLinea[]>([]);
  const [facturaResumen, setFacturaResumen] = useState<{
    supplier: string | null;
    date: string | null;
    total: string | null;
  } | null>(null);

  const currency = preferences?.currency ?? 'DOP';

  const refresh = async () => {
    setLoading(true);
    const result = await loadShoppingLists({ entityId, search: busqueda });
    setLists(result.lists);
    setPending(await countShoppingPending());
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, busqueda]);

  // El análisis no bloquea la pantalla: si falla, Compras sigue funcionando.
  useEffect(() => {
    let cancelado = false;
    void (async () => {
      try {
        const data = await api.get<Analisis>(`/shopping-lists/insights${entityId ? `?entityId=${entityId}` : ''}`);
        if (!cancelado) {
          setInsights(data);
        }
      } catch {
        if (!cancelado) {
          setInsights(null);
        }
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [entityId, lists.length]);

  // Reintento automático de los envíos pendientes cuando vuelve la conexión.
  useEffect(() => {
    const intentar = async () => {
      if (pending === 0 || !navigator.onLine) {
        return;
      }
      const result = await flushShoppingQueue();
      if (result.sent > 0) {
        toast.success(`${result.sent} lista(s) enviadas al servidor.`);
        await refresh();
      }
    };
    void intentar();
    const interval = setInterval(intentar, 20_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  const filtered = useMemo(() => {
    if (filtro === 'ABIERTAS') {
      return lists.filter((list) => list.status === 'DRAFT' || list.status === 'ACTIVE');
    }
    if (filtro === 'FINALIZADAS') {
      return lists.filter((list) => list.status === 'COMPLETED' || list.status === 'ARCHIVED');
    }
    return lists;
  }, [lists, filtro]);

  /** Salir de la búsqueda deja la barra como estaba y la lista completa. */
  const cerrarBusqueda = () => {
    setBuscando(false);
    setBusqueda('');
  };

  /**
   * Modo tienda: se activa antes de entrar al súper para que la app no espere al
   * servidor (la señal allí va y viene). Al desactivarlo se envían de golpe los
   * cambios que quedaron guardados.
   */
  const alternarModoTienda = async () => {
    if (modoTienda) {
      desactivarModoTienda();
      setModoTienda(false);
      const resultado = await flushShoppingQueue();
      if (resultado.sent > 0) {
        toast.success(`${resultado.sent} cambio(s) enviados al servidor.`);
      }
      await refresh();
      return;
    }
    activarModoTienda();
    setModoTienda(true);
    toast.info('Modo tienda activado', 'Los cambios se guardan en el teléfono y se envían al desactivarlo.');
  };

  const create = async () => {
    const name = newName.trim();
    if (name.length < 2 || !newEntityId) {
      return;
    }
    setSaving(true);
    try {
      if (!navigator.onLine) {
        await createListOffline({ entityId: newEntityId, name, plannedDate: newDate || null, notes: newNotes || null });
        toast.warning('Lista guardada en este dispositivo. Se enviará sola cuando haya conexión.');
        setCreating(false);
        setNewName('');
        await refresh();
        return;
      }
      const created = await api.post<RemoteShoppingList>('/shopping-lists', {
        entityId: newEntityId,
        name,
        plannedDate: newDate || null,
        notes: newNotes || null,
      });
      toast.success('Lista creada. Añada los productos que necesita.');
      setCreating(false);
      setNewName('');
      setNewNotes('');
      navigate(`/compras/${created.id}`);
    } catch (error) {
      if (error instanceof ApiError) {
        toast.error('No se pudo crear la lista', error.message);
      } else {
        // Sin red a mitad: se guarda localmente para no perder lo escrito.
        await createListOffline({ entityId: newEntityId, name, plannedDate: newDate || null, notes: newNotes || null });
        toast.warning('Sin conexión: la lista quedó guardada en el dispositivo.');
        setCreating(false);
        await refresh();
      }
    } finally {
      setSaving(false);
    }
  };

  const reiniciarFactura = () => {
    setFacturaLineas([]);
    setFacturaResumen(null);
    setFacturaAvisos([]);
    setFacturaError(null);
  };

  /**
   * Pide a la IA que lea la foto o el PDF. La imagen se reduce en el teléfono
   * antes de salir (una foto de móvil pesa varios MB y hacía fallar la subida).
   */
  const leerFactura = async (file: File) => {
    reiniciarFactura();

    if (file.size > MAX_FACTURA_MB * 1024 * 1024) {
      setFacturaError(`El archivo pesa demasiado. El máximo es ${MAX_FACTURA_MB} MB.`);
      return;
    }

    setFacturaCargando(true);
    try {
      const preparado = await prepareInvoiceFile(file);
      const contentBase64 = await fileToDataUrl(preparado);

      const result = await api.post<{
        invoice: {
          supplier: string | null;
          date: string | null;
          total: string | null;
          warnings: string[];
          lines: Array<{
            name: string;
            quantity: string;
            unit: string | null;
            unitPrice: string | null;
            total: string | null;
          }>;
        };
      }>('/shopping-lists/invoice-scan', {
        entityId: newEntityId,
        filename: preparado.name,
        mimeType: preparado.type || 'image/jpeg',
        contentBase64,
      });

      setFacturaLineas(
        result.invoice.lines.map((line) => ({
          name: line.name,
          quantity: line.quantity || '1',
          unit: line.unit,
          unitPrice: line.unitPrice ?? line.total ?? '',
          include: true,
        })),
      );
      setFacturaResumen({ supplier: result.invoice.supplier, date: result.invoice.date, total: result.invoice.total });
      setFacturaAvisos(result.invoice.warnings ?? []);
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) {
        setFacturaError(
          'La lectura de facturas con IA no está activada en este servidor. Puede crear la lista y añadir los productos a mano.',
        );
      } else {
        setFacturaError(
          error instanceof ApiError ? error.message : 'No se pudo leer la factura. Inténtelo con una foto más clara.',
        );
      }
    } finally {
      setFacturaCargando(false);
    }
  };

  /** Crea la compra ya con los productos revisados, comprados y con su precio. */
  const crearCompraDesdeFactura = async () => {
    const elegidas = facturaLineas.filter((line) => line.include && line.name.trim().length > 0);
    if (elegidas.length === 0) {
      setFacturaError('Marque al menos un producto para crear la compra.');
      return;
    }
    if (!newEntityId) {
      setFacturaError('Elija la unidad financiera de la compra.');
      return;
    }

    setFacturaGuardando(true);
    setFacturaError(null);
    try {
      const fechaFactura = facturaResumen?.date ?? null;
      const nombre =
        (facturaResumen?.supplier ?? '').trim() ||
        `Compra del ${fechaFactura ?? (newDate || todayBusinessDate(preferences?.timezone))}`;

      const created = await api.post<RemoteShoppingList>('/shopping-lists', {
        entityId: newEntityId,
        name: nombre.slice(0, 80),
        plannedDate: fechaFactura ?? (newDate || null),
        notes: 'Creada desde una factura',
        items: elegidas.map((line) => {
          const price = line.unitPrice.trim();
          return {
            name: line.name.trim(),
            quantity: line.quantity || '1',
            unit: line.unit,
            estimatedUnitPrice: price === '' ? null : price,
            actualUnitPrice: price === '' ? null : price,
            isPurchased: true,
          };
        }),
      });

      // El catálogo aprende los precios; si falla, la compra ya está hecha.
      try {
        await api.post('/shopping-lists/catalog/ingest', {
          entityId: newEntityId,
          supplier: facturaResumen?.supplier ?? null,
          lines: elegidas.map((line) => ({
            name: line.name.trim(),
            unit: line.unit,
            unitPrice: line.unitPrice.trim() === '' ? null : line.unitPrice.trim(),
            quantity: line.quantity || '1',
          })),
        });
      } catch {
        // Es una ayuda, no un requisito para guardar la compra.
      }

      setFacturaOpen(false);
      reiniciarFactura();
      await refresh();
      toast.success(
        `${elegidas.length} productos en la compra`,
        'Revise la lista y registre el gasto con la cuenta de donde salió el dinero.',
      );
      navigate(`/compras/${created.id}`);
    } catch (error) {
      setFacturaError(error instanceof ApiError ? error.message : 'No se pudo crear la compra.');
    } finally {
      setFacturaGuardando(false);
    }
  };

  const archive = async (list: RemoteShoppingList) => {
    setBusyId(list.id);
    try {
      await api.patch(`/shopping-lists/${list.id}`, { status: 'ARCHIVED' });
      toast.info('Lista archivada. No se borra nada.');
      await refresh();
    } catch (error) {
      toast.error('No se pudo archivar', error instanceof ApiError ? error.message : 'Requiere conexión.');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    const target = toDelete;
    setToDelete(null);
    if (!target) {
      return;
    }
    setBusyId(target.id);
    try {
      await api.delete(`/shopping-lists/${target.id}`);
      await removeLocalShoppingList(target.id);
      toast.info('Lista borrada.');
      await refresh();
    } catch (error) {
      toast.error(
        'No se pudo borrar',
        error instanceof ApiError ? error.message : 'Puede que ya tenga el gasto registrado: archívela en su lugar.',
      );
    } finally {
      setBusyId(null);
    }
  };

  // Listas que sólo existen en este dispositivo (creadas sin conexión).
  const [localOnly, setLocalOnly] = useState<string[]>([]);
  useEffect(() => {
    void (async () => {
      const local = await getLocalShoppingLists();
      setLocalOnly(local.filter((row) => row.pendingSync).map((row) => row.id));
    })();
  }, [lists, pending]);

  const pedirConsejoIA = async () => {
    setConsejoCargando(true);
    setConsejoError(null);
    try {
      const data = await api.post<{
        title: string;
        tips: string[];
        suggestedList: Array<{ name: string; reason: string }>;
      }>('/shopping-lists/advice', entityId ? { entityId } : {});
      setConsejoIA(data);
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) {
        setConsejoError('Los consejos con IA no están activados en este servidor.');
      } else {
        setConsejoError(
          error instanceof ApiError ? error.message : 'No se pudo pedir el consejo. Inténtelo de nuevo en un momento.',
        );
      }
    } finally {
      setConsejoCargando(false);
    }
  };

  return (
    <ListScreen
      toolbar={
        <>
          {/*
            BARRA DE LA PANTALLA (appbar)
            ----------------------------
            Volver a la izquierda, el nombre de la pantalla y la lupa. Al pulsar
            la lupa, la barra ENTERA se convierte en el buscador: no se apila un
            campo debajo del título, se sustituye. Se sale con la flecha o con ✕.
            Va de borde a borde (-mx-2, igual que el margen de la columna) para
            que parezca la barra de la app y no una tarjeta más.
          */}
          <div className="-mx-2 border-b border-border-soft bg-bg/95 px-2 pb-1.5 pt-[calc(var(--safe-top)+0.3rem)] backdrop-blur-md">          {buscando ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={cerrarBusqueda}
                aria-label="Cerrar la búsqueda"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink"
              >
                <IconChevronLeft size={20} />
              </button>
              <div className="relative min-w-0 flex-1">
                <IconSearch
                  size={16}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
                />
                <input
                  autoFocus
                  value={busqueda}
                  onChange={(event) => setBusqueda(event.target.value)}
                  aria-label="Buscar en las listas"
                  placeholder="Buscar lista o producto…"
                  autoComplete="off"
                  enterKeyHint="search"
                  className="h-10 w-full border border-border-soft bg-surface-2 pl-9 pr-9 text-sm text-ink outline-none transition placeholder:text-faint focus:border-brand"
                />
                {busqueda ? (
                  <button
                    type="button"
                    onClick={() => setBusqueda('')}
                    aria-label="Borrar lo escrito"
                    className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-faint transition hover:text-ink"
                  >
                    <IconClose size={16} />
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Link
                to="/"
                aria-label="Volver al inicio"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink"
              >
                <IconChevronLeft size={20} />
              </Link>
              <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight text-ink">Compras</h1>
              <button
                type="button"
                onClick={() => setBuscando(true)}
                aria-label="Buscar en las listas"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink"
              >
                <IconSearch size={19} />
              </button>
            </div>
          )}
          </div>

          {!buscando ? (
            <p className="px-1 pt-1 text-[0.72rem] leading-snug text-muted">
              Listas de lo que va a comprar. Marcar un producto no es un gasto: al terminar, el gasto se registra aparte.
            </p>
          ) : null}

          {/* El aviso de «sin conexión» ya lo da la barra superior de la app: aquí
              sólo se muestra lo que se puede ACCIONAR (envíos pendientes). */}
          {pending > 0 ? (
            <Notice tone="info">
              {pending} lista(s) con cambios <strong>pendientes de enviar</strong>. Se enviarán solas cuando haya conexión.
            </Notice>
          ) : null}

          {/* Filtro: tres píldoras en una sola línea, sin caja alrededor. */}
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtrar las listas">
            {(
              [
                { value: 'ABIERTAS', label: 'Abiertas' },
                { value: 'FINALIZADAS', label: 'Finalizadas' },
                { value: 'TODAS', label: 'Todas' },
              ] as Array<{ value: Filtro; label: string }>
            ).map((opcion) => (
              <button
                key={opcion.value}
                type="button"
                onClick={() => setFiltro(opcion.value)}
                aria-pressed={filtro === opcion.value}
                className={`px-3 py-1.5 text-xs font-semibold transition ${
                  filtro === opcion.value
                    ? 'bg-brand text-white shadow-card'
                    : 'bg-surface-2 text-muted hover:text-ink'
                }`}
              >
                {opcion.label}
              </button>
            ))}

            {/* En el súper la señal va y viene. Con esto la app deja de esperar al
                servidor para las listas y trabaja contra el teléfono al instante. */}
            <button
              type="button"
              onClick={() => void alternarModoTienda()}
              aria-pressed={modoTienda}
              aria-label="Modo tienda: trabajar sin esperar al servidor"
              title="Trabajar sin esperar al servidor (la compra se guarda en el teléfono)"
              className={`px-2.5 py-1.5 text-xs font-semibold transition ${
                modoTienda ? 'bg-brand/10 text-brand' : 'text-muted hover:text-ink'
              }`}
            >
              Modo tienda
            </button>

            {/*
              COMPRA DESDE UNA FOTO: antes de crear nada. La IA escribe los
              productos con su precio y la compra nace ya completa.
            */}
            <button
              type="button"
              onClick={() => {
                reiniciarFactura();
                setFacturaOpen(true);
              }}
              title="Crear la compra a partir de la foto de una factura"
              className="flex items-center gap-1 px-2 py-1.5 text-xs font-semibold text-muted transition hover:text-ink"
            >
              <IconFile size={16} />
              Desde factura
            </button>

            {/* Catálogo de productos con su último precio: lo que se compra y cuánto cuesta. */}
            <Link
              to="/compras/catalogo"
              title="Productos con su último precio"
              className="flex items-center gap-1 px-2 py-1.5 text-xs font-semibold text-muted transition hover:text-ink"
            >
              <IconBag size={16} />
              Catálogo
            </Link>
          </div>
        </>
      }
    >

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : (
        <>
          <SugerenciasCard insights={insights} currency={currency} onAbrir={() => setSugerenciasOpen(true)} />

          {filtered.length === 0 ? (
        <EmptyState
          title={busqueda ? 'Ninguna lista coincide' : 'Todavía no hay listas de compras'}
          hint={
            busqueda
              ? 'Pruebe con otra palabra: se busca en el nombre de la lista y en los productos.'
              : 'Cree una lista (supermercado, farmacia, combustible…) y añada lo que necesita. Después podrá comparar lo que pensaba gastar con lo que gastó de verdad.'
          }
          action={<Button onClick={() => setCreating(true)}>Crear la primera lista</Button>}
        />
          ) : (
        <div className="space-y-3">
          {filtered.map((list) => {
            const total = Number(list.counts.items);
            const comprados = Number(list.counts.purchased);
            const percent = total === 0 ? 0 : Math.round((comprados / total) * 100);
            const isLocal = localOnly.includes(list.id);

            return (
              <Card key={list.id} className="space-y-2.5 py-3">
                {/* La tarjeta entera abre la lista: el nombre grande es el
                    enlace, no hace falta buscar un botón «Abrir». */}
                <Link to={`/compras/${list.id}`} className="block space-y-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[0.95rem] font-semibold leading-tight tracking-tight text-ink">
                        {list.name}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1 truncate text-[0.7rem] text-muted">
                        <span className="tabular-nums">
                          {comprados} de {total || 0}
                        </span>
                        {list.plannedDate ? <span>· {list.plannedDate}</span> : null}
                        {list.entityName ? <span className="truncate">· {list.entityName}</span> : null}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {isLocal ? (
                        <Badge tone="warning">pendiente de enviar</Badge>
                      ) : list.status === 'COMPLETED' ? (
                        <Badge tone="positive">registrada</Badge>
                      ) : list.status === 'ARCHIVED' ? (
                        <Badge tone="neutral">archivada</Badge>
                      ) : null}
                      <IconChevronRight size={16} className="mt-0.5 shrink-0 text-faint" />
                    </div>
                  </div>

                  <ProgressBar percent={percent} tone={percent >= 100 ? 'positive' : 'neutral'} />
                </Link>

                {/* Una sola línea de cifras y las acciones como texto: antes había
                    tres bloques con etiquetas y tres botones con caja en cada tarjeta. */}
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-border-soft pt-2 text-[0.7rem] text-muted">
                  <span className="min-w-0 truncate">
                    Estimado{' '}
                    <span className="font-semibold tabular-nums text-ink">
                      <Money value={list.totals.estimated} currency={currency} />
                    </span>
                    {Number(list.totals.actual) > 0 ? (
                      <>
                        {' · '}Pagado{' '}
                        <span className="font-semibold tabular-nums text-ink">
                          <Money value={list.totals.actual} currency={currency} />
                        </span>
                      </>
                    ) : null}
                    {' · '}Falta{' '}
                    <span className="font-semibold tabular-nums text-ink">
                      <Money value={list.totals.pending} currency={currency} />
                    </span>
                  </span>

                  <span className="flex shrink-0 items-center gap-3">
                    {list.status !== 'ARCHIVED' ? (
                      <button
                        type="button"
                        disabled={busyId === list.id || isLocal}
                        onClick={() => void archive(list)}
                        className="text-muted underline decoration-dotted underline-offset-2 transition hover:text-ink disabled:opacity-50"
                      >
                        Archivar
                      </button>
                    ) : null}
                    {!list.expense.registered ? (
                      <button
                        type="button"
                        disabled={busyId === list.id || isLocal}
                        onClick={() => setToDelete(list)}
                        className="text-negative underline decoration-dotted underline-offset-2 transition hover:opacity-80 disabled:opacity-50"
                      >
                        Borrar
                      </button>
                    ) : null}
                  </span>
                </div>

                {list.expense.registered ? (
                  <p className="text-[0.68rem] leading-snug text-faint">
                    Ya está registrada como gasto: no se puede borrar, pero sí archivar.
                  </p>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
        </>
      )}

      {/* BOTÓN FLOTANTE PARA CREAR (estilo AppSheet)
          ------------------------------------------
          Antes vivía en la barra de arriba, compitiendo con el título. Flotando
          abajo a la derecha está siempre a mano del pulgar y no ocupa la barra. */}
      <Fab label="Nueva" onClick={() => setCreating(true)} sobreBarra={false} />

      {/* Nueva lista */}
      <Sheet open={creating} onClose={() => setCreating(false)} title="Nueva lista de compras">
        <div className="space-y-3 pb-3">
          {/* Atajo: si la compra ya está hecha, la factura la escribe sola. */}
          <button
            type="button"
            onClick={() => {
              setCreating(false);
              reiniciarFactura();
              setFacturaOpen(true);
            }}
            className="flex w-full items-center gap-2 border border-brand/40 bg-brand/5 p-2.5 text-left text-xs font-semibold text-brand transition active:scale-[0.99]"
          >
            <IconFile size={18} />
            <span className="min-w-0 flex-1">
              ¿Ya tiene la factura?
              <span className="mt-0.5 block text-[0.7rem] font-normal text-muted">
                Haga una foto y la IA añade los productos con sus precios.
              </span>
            </span>
            <IconChevronRight size={16} className="shrink-0" />
          </button>

          <Field
            label="Nombre de la lista"
            value={newName}
            onChange={setNewName}
            placeholder="Ej.: Supermercado del sábado"
            autoComplete="off"
            hint="Un nombre que reconozca después."
          />
          <div className="block">
            <label htmlFor="entity-nueva-lista" className="mb-1 block text-sm font-medium text-ink">
              Unidad financiera
            </label>
            <select
              id="entity-nueva-lista"
              value={newEntityId}
              onChange={(event) => setNewEntityId(event.target.value)}
              className="w-full rounded-xl border border-border-soft bg-surface-2 px-3 py-2.5 text-ink outline-none transition focus:border-brand"
            >
              {entities.map((entity) => (
                <option key={entity.id} value={entity.id}>
                  {entity.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-faint">
              De qué bolsillo saldrá el dinero cuando registre el gasto. Podrá confirmarlo entonces.
            </p>
          </div>
          <Field
            label="Fecha prevista (opcional)"
            value={newDate}
            onChange={setNewDate}
            type="date"
            inputMode="text"
          />
          <Field
            label="Notas (opcional)"
            value={newNotes}
            onChange={setNewNotes}
            placeholder="Ej.: semana del 20, para la casa"
            autoComplete="off"
          />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Cancelar
            </Button>
            <Button disabled={saving || newName.trim().length < 2 || !newEntityId} onClick={() => void create()}>
              {saving ? 'Creando…' : 'Crear lista'}
            </Button>
          </div>
        </div>
      </Sheet>

      {/* COMPRA DESDE UNA FACTURA
          ------------------------
          La IA lee la foto o el PDF y PROPONE las líneas con sus precios. La
          compra no se crea hasta que el usuario revisa y pulsa el botón: un dato
          mal leído nunca se convierte en un gasto equivocado. */}
      <Sheet
        open={facturaOpen}
        onClose={() => {
          setFacturaOpen(false);
          reiniciarFactura();
        }}
        title="Compra desde una factura"
      >
        <div className="space-y-3 pb-3">
          {facturaLineas.length === 0 ? (
            <>
              <p className="text-xs leading-snug text-muted">
                Haga una foto de la factura (o suba el PDF). La IA escribe los productos, las cantidades y los precios;
                usted los revisa y la compra queda creada ya con todo comprado.
              </p>

              <div className="block">
                <label htmlFor="factura-unidad" className="mb-1 block text-sm font-medium text-ink">
                  Unidad financiera
                </label>
                <select
                  id="factura-unidad"
                  value={newEntityId}
                  onChange={(event) => setNewEntityId(event.target.value)}
                  className="w-full border border-border-soft bg-surface-2 px-3 py-2.5 text-ink outline-none transition focus:border-brand"
                >
                  {entities.map((entity) => (
                    <option key={entity.id} value={entity.id}>
                      {entity.name}
                    </option>
                  ))}
                </select>
              </div>

              <label
                className={`flex h-12 w-full cursor-pointer items-center justify-center gap-2 bg-brand px-4 text-sm font-semibold text-white transition active:scale-[0.99] ${
                  facturaCargando ? 'pointer-events-none opacity-60' : ''
                }`}
              >
                <IconFile size={18} />
                {facturaCargando ? 'Leyendo la factura…' : 'Hacer foto o elegir archivo'}
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  capture="environment"
                  disabled={facturaCargando}
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) {
                      void leerFactura(file);
                    }
                  }}
                />
              </label>

              {facturaCargando ? <Skeleton className="h-16 w-full" /> : null}
              {facturaError ? <Notice tone="warning">{facturaError}</Notice> : null}

              <p className="text-[0.7rem] leading-snug text-faint">
                La imagen se reduce en el teléfono antes de enviarse y sólo se usa para leerla: no se guarda en ninguna
                carpeta pública.
              </p>
            </>
          ) : (
            <>
              <div className="border border-border-soft bg-surface-2 p-2 text-xs text-muted">
                {facturaResumen?.supplier ? <span className="font-semibold text-ink">{facturaResumen.supplier}</span> : null}
                {facturaResumen?.date ? ` · ${facturaResumen.date}` : ''}
                {facturaResumen?.total ? ` · total ${facturaResumen.total}` : ''}
                <span className="mt-1 block text-[0.7rem] text-faint">
                  {facturaLineas.filter((line) => line.include).length} de {facturaLineas.length} productos seleccionados
                </span>
              </div>

              {facturaAvisos.length > 0 ? (
                <Notice tone="warning" title="Revise esto antes de crear la compra">
                  <ul className="list-disc space-y-1 pl-4">
                    {facturaAvisos.slice(0, 4).map((aviso) => (
                      <li key={aviso}>{aviso}</li>
                    ))}
                  </ul>
                </Notice>
              ) : null}

              <FacturaLineasEditor lineas={facturaLineas} onChange={setFacturaLineas} />

              {facturaError ? <Notice tone="warning">{facturaError}</Notice> : null}

              <div className="flex items-baseline justify-between gap-3 border-t border-border-soft pt-2 text-sm">
                <span className="text-muted">Total seleccionado</span>
                <span className="font-semibold text-ink">
                  {facturaLineas
                    .filter((line) => line.include)
                    .reduce((acc, line) => acc + (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0), 0)
                    .toFixed(2)}
                </span>
              </div>

              <div className="flex flex-col gap-2">
                <Button fullWidth size="lg" disabled={facturaGuardando} onClick={() => void crearCompraDesdeFactura()}>
                  {facturaGuardando
                    ? 'Creando la compra…'
                    : `Crear la compra (${facturaLineas.filter((line) => line.include).length})`}
                </Button>
                <Button variant="ghost" onClick={reiniciarFactura}>
                  Leer otra factura
                </Button>
              </div>
            </>
          )}
        </div>
      </Sheet>

      {/* SUGERENCIAS: análisis del historial y consejos.
          Los datos salen del servidor con reglas propias (no hace falta IA). La
          IA, si está configurada, añade una redacción más natural y una lista
          concreta; si falla, los consejos por reglas siguen ahí. */}
      <Sheet open={sugerenciasOpen} onClose={() => setSugerenciasOpen(false)} title="Sugerencias de compra">
        <div className="space-y-3 pb-3">
          {insights ? (
            <>
              <div className="divide-y divide-border-soft border border-border-soft text-sm">
                <div className="flex items-baseline justify-between gap-3 p-2">
                  <span className="text-muted">Compras registradas</span>
                  <span className="font-semibold text-ink">{insights.totals.purchases}</span>
                </div>
                <div className="flex items-baseline justify-between gap-3 p-2">
                  <span className="text-muted">Gastado en total</span>
                  <Money value={String(insights.totals.spent)} currency={currency} />
                </div>
                <div className="flex items-baseline justify-between gap-3 p-2">
                  <span className="text-muted">Ticket medio</span>
                  <span className="font-semibold text-ink">
                    {insights.totals.averageTicket === null ? '—' : <Money value={String(insights.totals.averageTicket)} currency={currency} />}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-3 p-2">
                  <span className="text-muted">Equilibrio de la compra</span>
                  <span className="font-semibold text-ink">{insights.balance.score}/100</span>
                </div>
              </div>

              {insights.balance.groups.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {insights.balance.groups
                    .filter((row) => row.share > 0)
                    .map((row) => (
                      <Badge key={row.group} tone={row.group === 'procesados' ? 'warning' : 'neutral'}>
                        {row.label} {row.share}%
                      </Badge>
                    ))}
                </div>
              ) : null}

              {insights.priceIncreases.length > 0 ? (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Precios que subieron</p>
                  <ul className="space-y-1 text-sm text-ink">
                    {insights.priceIncreases.map((row) => (
                      <li key={row.name} className="flex items-baseline justify-between gap-2">
                        <span className="truncate">{row.name}</span>
                        <span className="shrink-0 text-negative">
                          {Number(row.from).toFixed(2)} → {Number(row.to).toFixed(2)} (+{Math.round(row.changePct)}%)
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Qué mejorar</p>
                <ul className="list-disc space-y-1 pl-4 text-sm leading-snug text-ink">
                  {insights.tips.map((tip) => (
                    <li key={tip}>{tip}</li>
                  ))}
                </ul>
              </div>

              {insights.ai.configured ? (
                <div className="space-y-2 border-t border-border-soft pt-3">
                  {consejoIA ? (
                    <>
                      <p className="text-sm font-semibold text-ink">{consejoIA.title}</p>
                      <ul className="list-disc space-y-1 pl-4 text-sm leading-snug text-ink">
                        {consejoIA.tips.map((tip) => (
                          <li key={tip}>{tip}</li>
                        ))}
                      </ul>
                      {consejoIA.suggestedList.length > 0 ? (
                        <div>
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Para la próxima lista</p>
                          <ul className="space-y-1 text-sm text-ink">
                            {consejoIA.suggestedList.map((row) => (
                              <li key={row.name}>
                                <span className="font-medium">{row.name}</span>
                                {row.reason ? <span className="text-muted"> — {row.reason}</span> : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  {consejoError ? <Notice tone="warning">{consejoError}</Notice> : null}
                  <Button variant="secondary" fullWidth disabled={consejoCargando} onClick={() => void pedirConsejoIA()}>
                    {consejoCargando ? 'Pensando…' : consejoIA ? 'Volver a pedir consejo a la IA' : 'Pedir consejo a la IA'}
                  </Button>
                  <p className="text-[0.7rem] leading-snug text-faint">
                    Se envían sólo los datos de sus compras (productos, precios y grupos). No se envía nada más.
                  </p>
                </div>
              ) : (
                <p className="border-t border-border-soft pt-3 text-[0.7rem] leading-snug text-faint">
                  Estos consejos se calculan en el servidor con sus propias compras. Los consejos redactados con IA no
                  están activados en este servidor.
                </p>
              )}
            </>
          ) : (
            <Spinner label="Leyendo sus compras…" />
          )}
        </div>
      </Sheet>

      <ConfirmDialog
        open={toDelete !== null}
        tone="danger"
        title="¿Borrar la lista?"
        confirmLabel="Sí, borrar"
        message={
          <>
            <p className="font-medium text-ink">{toDelete?.name}</p>
            <p className="mt-1">
              Se borrarán la lista y sus productos. <strong>No afecta a ningún gasto</strong> porque esta lista todavía no
              ha registrado ninguno. Si prefiere conservarla, archívela.
            </p>
          </>
        }
        onCancel={() => setToDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </ListScreen>
  );
}
