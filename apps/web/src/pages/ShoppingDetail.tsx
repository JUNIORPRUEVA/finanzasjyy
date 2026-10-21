import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, desactivarModoTienda, modoTiendaActivo } from '../lib/api';
import { useAuth } from '../store/auth';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  ListScreen,
  Money,
  MoneyInput,
  Notice,
  Panel,
  ProgressBar,
  SectionTitle,
  Select,
  Sheet,
  Skeleton,
} from '../components/ui';
import { toast } from '../components/Toast';
import { BotonNuevaCategoria, NuevaCategoriaSheet } from '../components/NuevaCategoriaSheet';
import { IconArrowDown, IconCheck, IconChevronLeft, IconClose, IconFile, IconPlus, IconSearch, IconShare } from '../components/icons';
import {
  flushShoppingQueue,
  isServerList,
  loadShoppingList,
  updateLocalList,
  type RemoteShoppingItem,
  type RemoteShoppingList,
} from '../lib/shopping-offline';
import { countShoppingPending } from '../lib/db';
import { formatMoney, todayBusinessDate } from '../lib/format';
import { groupItems, fold, listToPlainText, nutritionAdvice } from '../lib/shopping-assistant';
import { PLANTILLAS, productosNuevos, type Plantilla } from '../lib/shopping-templates';
import { repartirCompra, textoDeParte, type ParteCompra } from '../lib/shopping-split';

/**
 * DETALLE DE UNA LISTA DE COMPRAS
 * ===============================
 * Aquí se prepara la compra y, al terminar, se decide si se registra el gasto en
 * FINANZA. Lo importante:
 *  · Marcar un producto como comprado NO es un gasto: sólo apunta que ya lo tiene.
 *  · El gasto se registra con `Registrar gasto en FINANZA`, indicando de qué
 *    cuenta sale el dinero. Entonces sí hay movimiento y asiento contable.
 *  · Una vez registrado, la lista queda vinculada al movimiento y no se puede
 *    volver a registrar (el servidor lo impide con un identificador único).
 *  · Sin conexión se puede preparar y editar la lista, pero el gasto necesita
 *    servidor: se dice claramente en vez de fingir que se guardó.
 */
export function ShoppingDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { preferences, entities } = useAuth();
  const currency = preferences?.currency ?? 'DOP';

  const [list, setList] = useState<RemoteShoppingList | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);

  const [addName, setAddName] = useState('');
  const [addQuantity, setAddQuantity] = useState('1');
  const [addPrice, setAddPrice] = useState('');
  const [adding, setAdding] = useState(false);
  // Añadir vive en su propio diágolo, que abre el botón flotante: en la
  // pantalla sólo queda la lupa y la lista, que es lo que se mira en la tienda.
  const [addOpen, setAddOpen] = useState(false);

  const [editing, setEditing] = useState<RemoteShoppingItem | null>(null);
  const [editName, setEditName] = useState('');
  const [editQuantity, setEditQuantity] = useState('1');
  const [editUnit, setEditUnit] = useState('');
  const [editEstimated, setEditEstimated] = useState('');
  const [editActual, setEditActual] = useState('');

  const [toDeleteItem, setToDeleteItem] = useState<RemoteShoppingItem | null>(null);

  // Ordenar la compra por pasillos (encendido por defecto: en la tienda es lo
  // único que permite ir en línea recta en vez de dar vueltas al pasillo 4).
  const [porPasillo, setPorPasillo] = useState(true);

  // Buscar dentro de la lista: con 20 productos, encontrar «el papel» de un
  // tirón es lo que evita recorrer la lista entera en mitad del pasillo.
  const [buscarItem, setBuscarItem] = useState('');
  const [buscandoItem, setBuscandoItem] = useState(false);

  // Repartir la compra entre dos personas (por pasillos, sin partir ninguno).
  const [repartirOpen, setRepartirOpen] = useState(false);

  // Modo tienda: no se espera al servidor para las listas (la señal del súper va
  // y viene). Se activa desde la pantalla de Compras.
  const [modoTienda, setModoTienda] = useState(() => modoTiendaActivo());

  // Plantillas de compra (compra semanal, despensa, limpieza…).
  const [plantillasOpen, setPlantillasOpen] = useState(false);
  const [aplicando, setAplicando] = useState(false);

  const [paying, setPaying] = useState(false);
  const [payAccountId, setPayAccountId] = useState('');
  const [payCategoryId, setPayCategoryId] = useState('');
  const [nuevaCategoria, setNuevaCategoria] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState(todayBusinessDate(preferences?.timezone));
  const [payingBusy, setPayingBusy] = useState(false);

  const entity = useMemo(() => entities.find((row) => row.id === list?.entityId) ?? null, [entities, list?.entityId]);

  const accountsQuery = useQuery<Array<{ id: string; name: string; isCreditCard: boolean; balance: string }>>({
    queryKey: ['accounts', list?.entityId, 'shopping'],
    queryFn: () => api.get(`/accounts?entityId=${list!.entityId}`),
    enabled: Boolean(list?.entityId) && navigator.onLine,
  });

  const categoriesQuery = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['categories', list?.entityId, 'EXPENSE', 'shopping'],
    queryFn: () => api.get(`/categories?entityId=${list!.entityId}&kind=EXPENSE`),
    enabled: Boolean(list?.entityId) && navigator.onLine,
  });

  const refresh = async () => {
    setLoading(true);
    const result = await loadShoppingList(id);
    setList(result.list);
    setFromCache(result.fromCache);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /**
   * DOS PERSONAS EN LA MISMA LISTA
   * ------------------------------
   * Si dos teléfonos tienen la lista abierta (por ejemplo, dos personas en el
   * súper), lo que marca una tiene que verse en la otra sin recargar. Se vuelve
   * a leer cada pocos segundos, SÓLO con conexión, con la pantalla a la vista y
   * sin cambios propios pendientes de enviar (esos se envían primero, para no
   * pisarlos con la copia del servidor).
   *
   * No es una conexión directa entre los teléfonos: hace falta internet en los
   * dos. Sin red, cada uno sigue trabajando en su teléfono y se junta al volver.
   */
  useEffect(() => {
    const refrescarSiSePuede = async () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) {
        return;
      }
      if ((await countShoppingPending()) > 0) {
        return;
      }
      const resultado = await loadShoppingList(id);
      if (!resultado.fromCache && resultado.list) {
        setList(resultado.list);
      }
    };

    const intervalo = setInterval(() => void refrescarSiSePuede(), 7_000);
    document.addEventListener('visibilitychange', refrescarSiSePuede);
    return () => {
      clearInterval(intervalo);
      document.removeEventListener('visibilitychange', refrescarSiSePuede);
    };
  }, [id]);

  useEffect(() => {
    void (async () => setPending((await countShoppingPending()) > 0))();
  }, [list]);

  // Rellena el importe a pagar con lo que de verdad se ha apuntado.
  useEffect(() => {
    if (list && payAmount === '') {
      setPayAmount(list.totals.actual !== '0.00' ? list.totals.actual : list.totals.estimated);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list?.totals.actual]);

  const registered = list?.expense.registered === true;

  // Pasillos de esta compra y consejos para que la lista sea sensata.
  const itemsVisibles = useMemo(() => {
    const texto = fold(buscarItem.trim());
    if (!list) {
      return [];
    }
    return texto ? list.items.filter((item) => fold(item.name).includes(texto)) : list.items;
  }, [list, buscarItem]);
  const grupos = useMemo(() => groupItems(itemsVisibles), [itemsVisibles]);
  const consejos = useMemo(() => (list ? nutritionAdvice(list.items) : []), [list]);
  const pendientes = useMemo(() => (list ? list.items.filter((item) => !item.isPurchased).length : 0), [list]);
  const partes = useMemo(() => repartirCompra(list?.items ?? [], 2), [list]);

  /**
   * Compartir la lista tal cual, para marcarla en la tienda.
   *
   * Se usa la hoja del sistema (`navigator.share`): en Android incluye
   * Bluetooth, WhatsApp, correo… que es justo lo que se pide. Si el navegador no
   * la soporta (o el usuario cancela), se copia al portapapeles y, si tampoco,
   * se descarga un archivo de texto. Siempre hay una salida.
   */
  const compartir = async () => {
    if (!list) {
      return;
    }
    const texto = listToPlainText({
      name: list.name,
      entityName: entity?.name ?? null,
      plannedDate: list.plannedDate ?? null,
      items: list.items,
      total: list.totals.estimated,
      currency,
    });

    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await navigator.share({ title: list.name, text: texto });
        return;
      } catch {
        // Canceló o el sistema no pudo: se sigue con las alternativas.
      }
    }

    try {
      await navigator.clipboard.writeText(texto);
      toast.success('Lista copiada', 'Péguela en WhatsApp o en una nota del teléfono.');
      return;
    } catch {
      // Sin portapapeles: se descarga.
    }

    const blob = new Blob([texto], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = `${list.name.replace(/[^\w\s-]/g, '').trim() || 'lista-de-compras'}.txt`;
    enlace.click();
    URL.revokeObjectURL(url);
  };

  /** Salir del modo tienda: se envían de golpe los cambios guardados. */
  const salirDeModoTienda = async () => {
    desactivarModoTienda();
    setModoTienda(false);
    const resultado = await flushShoppingQueue();
    if (resultado.sent > 0) {
      toast.success(`${resultado.sent} cambio(s) enviados al servidor.`);
    }
    await refresh();
  };

  /** Imprimir o guardar como PDF con el diálogo del navegador (sin servidores). */
  const imprimir = () => window.print();

  /**
   * Enviar una parte de la compra a la otra persona (WhatsApp, Bluetooth, nota).
   * No hace falta que la otra persona tenga la app ni conexión: recibe el texto
   * con sus pasillos y sus productos.
   */
  const compartirParte = async (parte: ParteCompra<RemoteShoppingItem>) => {
    if (!list) {
      return;
    }
    const texto = textoDeParte(parte, list.name);

    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await navigator.share({ title: `${list.name} — ${parte.etiqueta}`, text: texto });
        return;
      } catch {
        // Canceló o el sistema no pudo: se sigue con las alternativas.
      }
    }

    try {
      await navigator.clipboard.writeText(texto);
      toast.success(`${parte.etiqueta} copiada`, 'Péguela en WhatsApp o en una nota del teléfono.');
      return;
    } catch {
      // Sin portapapeles: se descarga.
    }

    const blob = new Blob([texto], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = `${list.name.replace(/[^\w\s-]/g, '').trim() || 'compra'}-parte-${parte.numero}.txt`;
    enlace.click();
    URL.revokeObjectURL(url);
  };

  // Mientras esta pantalla está abierta se marca el <body>, para que al imprimir
  // se imprima SÓLO la hoja de la compra y no toda la aplicación.
  useEffect(() => {
    document.body.classList.add('con-hoja-imprimible');
    return () => document.body.classList.remove('con-hoja-imprimible');
  }, []);

  /**
   * Añade los productos de una plantilla saltándose los que ya están en la lista.
   * Con conexión se envía uno a uno al servidor (si algo falla, se sabe cuál);
   * sin conexión se guardan todos de golpe en el dispositivo.
   */
  const aplicarPlantilla = async (plantilla: Plantilla) => {
    if (!list) {
      return;
    }
    const { nuevos } = productosNuevos(plantilla, list.items);
    if (nuevos.length === 0) {
      toast.info('No hay nada que añadir', 'Esos productos ya están en la lista.');
      return;
    }

    setAplicando(true);
    try {
      if (navigator.onLine && isServerList(list)) {
        for (const item of nuevos) {
          await api.post(`/shopping-lists/${list.id}/items`, {
            name: item.name,
            quantity: item.quantity,
            unit: null,
            estimatedUnitPrice: null,
          });
        }
      } else {
        await updateLocalList(list.id, (snapshot) => ({
          ...snapshot,
          items: [
            ...snapshot.items,
            ...nuevos.map((item, index) => ({
              id: `${snapshot.id}_p${snapshot.items.length + index}_${Date.now().toString(36)}`,
              name: item.name,
              quantity: item.quantity,
              unit: null,
              estimatedUnitPrice: null,
              actualUnitPrice: null,
              isPurchased: false,
              categoryId: null,
            })),
          ],
        }));
      }
      setPlantillasOpen(false);
      await refresh();
      toast.success(`${nuevos.length} productos añadidos`, plantilla.label);
    } catch (error) {
      toast.error(
        'No se pudo añadir la plantilla',
        error instanceof ApiError ? error.message : 'Compruebe su conexión e inténtelo de nuevo.',
      );
    } finally {
      setAplicando(false);
    }
  };


  /** Todo cambio con conexión se envía; sin conexión se guarda y se marca. */
  const mutate = async (action: () => Promise<unknown>, successMessage?: string) => {
    try {
      await action();
      if (successMessage) {
        toast.success(successMessage);
      }
      await refresh();
    } catch (error) {
      if (error instanceof ApiError) {
        toast.error('No se pudo guardar', error.message);
      } else {
        toast.warning('Sin conexión', 'El cambio queda guardado en este dispositivo y se enviará solo.');
        await refresh();
      }
    }
  };

  const addItem = async () => {
    if (!list || addName.trim().length < 1) {
      return;
    }
    setAdding(true);
    const item = {
      name: addName.trim(),
      quantity: addQuantity || '1',
      unit: null,
      estimatedUnitPrice: addPrice === '' ? null : addPrice,
    };
    try {
      if (navigator.onLine && isServerList(list)) {
        await api.post(`/shopping-lists/${list.id}/items`, item);
        await refresh();
      } else {
        await updateLocalList(list.id, (snapshot) => ({
          ...snapshot,
          items: [
            ...snapshot.items,
            {
              id: `${snapshot.id}_${snapshot.items.length}_${Date.now().toString(36)}`,
              name: item.name,
              quantity: item.quantity,
              unit: null,
              estimatedUnitPrice: item.estimatedUnitPrice,
              actualUnitPrice: null,
              isPurchased: false,
              categoryId: null,
            },
          ],
        }));
        await refresh();
      }
      setAddName('');
      setAddQuantity('1');
      setAddPrice('');
      setAddOpen(false);
    } finally {
      setAdding(false);
    }
  };

  const togglePurchased = async (item: RemoteShoppingItem) => {
    if (!list || registered) {
      return;
    }
    const next = !item.isPurchased;
    const realPrice = next ? (item.estimatedUnitPrice ?? null) : null;

    if (navigator.onLine && isServerList(list)) {
      await mutate(() =>
        api.patch(`/shopping-lists/${list.id}/items/${item.id}`, {
          isPurchased: next,
          ...(realPrice === item.estimatedUnitPrice ? { actualUnitPrice: realPrice } : {}),
        }),
      );
      return;
    }

    await updateLocalList(list.id, (snapshot) => ({
      ...snapshot,
      items: snapshot.items.map((row) =>
        row.id === item.id ? { ...row, isPurchased: next, actualUnitPrice: next ? row.actualUnitPrice : null } : row,
      ),
    }));
    await refresh();
  };

  const saveEditedItem = async () => {
    if (!list || !editing) {
      return;
    }
    const payload = {
      name: editName.trim(),
      quantity: editQuantity || '1',
      unit: editUnit === '' ? null : editUnit,
      estimatedUnitPrice: editEstimated === '' ? null : editEstimated,
      actualUnitPrice: editActual === '' ? null : editActual,
    };

    if (navigator.onLine && isServerList(list)) {
      const itemId = editing.id;
      setEditing(null);
      await mutate(() => api.patch(`/shopping-lists/${list.id}/items/${itemId}`, payload), 'Producto actualizado.');
      return;
    }

    const itemId = editing.id;
    setEditing(null);
    await updateLocalList(list.id, (snapshot) => ({
      ...snapshot,
      items: snapshot.items.map((row) =>
        row.id === itemId
          ? {
              ...row,
              name: payload.name,
              quantity: payload.quantity,
              unit: payload.unit,
              estimatedUnitPrice: payload.estimatedUnitPrice,
              actualUnitPrice: payload.actualUnitPrice,
            }
          : row,
      ),
    }));
    await refresh();
  };

  const deleteItem = async () => {
    const target = toDeleteItem;
    setToDeleteItem(null);
    if (!list || !target) {
      return;
    }
    if (navigator.onLine && isServerList(list) && !target.id.includes('_')) {
      await mutate(() => api.delete(`/shopping-lists/${list.id}/items/${target.id}`), 'Producto borrado.');
      return;
    }
    await updateLocalList(list.id, (snapshot) => ({
      ...snapshot,
      items: snapshot.items.filter((row) => row.id !== target.id),
    }));
    await refresh();
  };

  const registerExpense = async () => {
    if (!list) {
      return;
    }
    if (!navigator.onLine) {
      toast.warning('Haga click cuando tenga conexión', 'Registrar un gasto mueve dinero real: necesita el servidor.');
      return;
    }
    if (!payAccountId) {
      toast.error('Falta la cuenta', 'Indique de qué cuenta sale el dinero.');
      return;
    }
    setPayingBusy(true);
    try {
      const result = await api.post<{ duplicate: boolean }>(`/shopping-lists/${list.id}/register-expense`, {
        accountId: payAccountId,
        categoryId: payCategoryId || null,
        amount: payAmount || undefined,
        businessDate: payDate,
      });
      toast.success(
        result.duplicate ? 'Este gasto ya estaba registrado' : 'Gasto registrado en FINANZA',
        result.duplicate ? 'No se ha duplicado nada.' : 'Puede verlo en Movimientos.',
      );
      setPaying(false);
      await refresh();
    } catch (error) {
      toast.error(
        'No se pudo registrar el gasto',
        error instanceof ApiError ? error.message : 'Compruebe su conexión e inténtelo de nuevo.',
      );
    } finally {
      setPayingBusy(false);
    }
  };

  const duplicate = async () => {
    if (!list) {
      return;
    }
    try {
      const created = await api.post<{ id: string }>(`/shopping-lists/${list.id}/duplicate`, {});
      toast.success('Lista duplicada como borrador.');
      navigate(`/compras/${created.id}`);
    } catch (error) {
      toast.error('No se pudo duplicar', error instanceof ApiError ? error.message : 'Requiere conexión.');
    }
  };

  const setStatus = async (status: 'ACTIVE' | 'COMPLETED' | 'ARCHIVED') => {
    if (!list) {
      return;
    }
    await mutate(() => api.patch(`/shopping-lists/${list.id}`, { status }), 'Lista actualizada.');
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-32" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (!list) {
    return (
      <EmptyState
        title="No se encontró la lista"
        hint="Puede que se haya borrado en otro dispositivo. Vuelva a Compras para ver las que tiene."
        action={
          <Link to="/compras">
            <Button>Ir a Compras</Button>
          </Link>
        }
      />
    );
  }

  const total = list.counts.items;
  const comprados = list.counts.purchased;
  const percent = total === 0 ? 0 : Math.round((comprados / total) * 100);
  const difference = Number(list.totals.difference);

  return (
    <ListScreen
      toolbar={
        <>
          {/*
            BARRA DE LA PANTALLA (appbar)
            ----------------------------
            Una sola barra: volver, nombre de la lista, lupa y las dos salidas
            (PDF y compartir). Antes había dos cabeceras apiladas (la de la app y
            la de la lista) y la lista perdía media pantalla.
          */}
          <div className="-mx-4 border-b border-border-soft bg-bg/95 px-2 pb-1.5 pt-[calc(var(--safe-top)+0.3rem)] backdrop-blur-md">
            {buscandoItem ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setBuscandoItem(false);
                    setBuscarItem('');
                  }}
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
                    value={buscarItem}
                    onChange={(event) => setBuscarItem(event.target.value)}
                    aria-label="Buscar producto en la lista"
                    placeholder="Buscar producto en la lista…"
                    autoComplete="off"
                    enterKeyHint="search"
                    className="h-10 w-full rounded-full border border-border-soft bg-surface-2 pl-9 pr-9 text-sm text-ink outline-none transition placeholder:text-faint focus:border-brand"
                  />
                  {buscarItem ? (
                    <button
                      type="button"
                      onClick={() => setBuscarItem('')}
                      aria-label="Borrar lo escrito"
                      className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-faint transition hover:text-ink"
                    >
                      <IconClose size={16} />
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-0.5">
                <Link
                  to="/compras"
                  aria-label="Volver a Compras"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink"
                >
                  <IconChevronLeft size={20} />
                </Link>
                <div className="min-w-0 flex-1">
                  <h1 className="truncate text-base font-semibold leading-tight tracking-tight text-ink">{list.name}</h1>
                  <p className="truncate text-[0.68rem] leading-snug text-muted">
                    {list.entityName ?? entity?.name ?? 'Unidad financiera'}
                    {list.createdByName ? ` · la abrió ${list.createdByName}` : ''}
                    {list.plannedDate ? ` · ${list.plannedDate}` : ''}
                    {registered ? ' · gasto registrado' : ''}
                    {fromCache ? ' · sin conexión' : ''}
                  </p>
                </div>
                {total > 0 ? (
                  <button
                    type="button"
                    onClick={() => setBuscandoItem(true)}
                    aria-label="Buscar producto en la lista"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink"
                  >
                    <IconSearch size={19} />
                  </button>
                ) : null}
                {total > 0 ? (
                  <button
                    type="button"
                    onClick={imprimir}
                    aria-label="Imprimir o guardar en PDF"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink"
                  >
                    <IconFile size={19} />
                  </button>
                ) : null}
                {total > 0 ? (
                  <button
                    type="button"
                    onClick={() => void compartir()}
                    aria-label="Compartir la lista"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink"
                  >
                    <IconShare size={19} />
                  </button>
                ) : null}
              </div>
            )}
          </div>

          {/* El añadir vive en el botón flotante; aquí sólo queda el resumen. */}

          {/* Resumen en una línea: cuánto llevo y cuánto suman. */}
          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-muted">
                {comprados} de {total || 0} productos comprados
                {grupos.length > 0 ? ` · ${grupos.length} pasillo(s)` : ''}
              </span>
              <span className="shrink-0 font-semibold tabular-nums text-ink">
                <Money value={list.totals.estimated} currency={currency} />
              </span>
            </div>
            <ProgressBar percent={percent} tone={percent >= 100 ? 'positive' : 'neutral'} />
            <div className="flex items-center justify-between gap-2 text-[0.7rem]">
              <span className="text-faint">
                Pagado <Money value={list.totals.actual} currency={currency} /> · falta{' '}
                <Money value={list.totals.pending} currency={currency} />
                {difference !== 0 ? (
                  <>
                    {' '}
                    · desvío{' '}
                    <Money
                      value={list.totals.difference}
                      currency={currency}
                      tone={difference > 0 ? 'negative' : 'positive'}
                    />
                  </>
                ) : null}
              </span>
              {total > 0 ? (
                <div className="flex shrink-0 items-center gap-1">
                  {pendientes > 0 && !registered ? (
                    <button
                      type="button"
                      onClick={() => setRepartirOpen(true)}
                      className="rounded-full border border-border-soft px-2.5 py-0.5 text-[0.7rem] text-muted transition hover:text-ink"
                    >
                      Repartir
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setPorPasillo((valor) => !valor)}
                    aria-pressed={porPasillo}
                    className={`rounded-full border px-2.5 py-0.5 text-[0.7rem] ${
                      porPasillo ? 'border-brand/60 bg-brand/15 text-brand' : 'border-border-soft text-muted'
                    }`}
                  >
                    {porPasillo ? 'Por pasillos' : 'En orden'}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </>
      }
    >
      {fromCache ? (
        <Notice tone="warning" title="Sin conexión con el servidor">
          Puede seguir preparando y editando la lista: los cambios se guardan en este dispositivo y se enviarán solos.
          Para <strong>registrar el gasto</strong> hace falta conexión, porque mueve dinero real.
        </Notice>
      ) : null}

      {modoTienda ? (
        <Notice tone="info" title="Modo tienda activo">
          La app no espera al servidor: lo que marque se guarda en este teléfono y se envía solo al desactivar el
          modo.{' '}
          <button
            type="button"
            onClick={() => void salirDeModoTienda()}
            className="font-semibold text-brand underline"
          >
            Salir del modo tienda
          </button>
        </Notice>
      ) : null}

      {registered ? (
        <Notice tone="positive" title="Esta compra ya está contabilizada">
          El gasto está registrado en FINANZA con su asiento. La lista queda como historial: no se puede volver a
          registrar ni modificar lo comprado.
        </Notice>
      ) : null}

      {total === 0 ? (
          <EmptyState
            title="Lista vacía"
            hint="Añada productos con su cantidad y el precio que espera pagar. Así sabrá cuánto va a gastar antes de salir."
            action={
              !registered ? (
                <Button variant="secondary" onClick={() => setPlantillasOpen(true)}>
                  Empezar con una plantilla
                </Button>
              ) : undefined
            }
          />
        ) : itemsVisibles.length === 0 ? (
        <EmptyState
          title="Ningún producto coincide"
          hint={`No hay nada en esta lista que se parezca a «${buscarItem.trim()}».`}
          action={<Button variant="secondary" onClick={() => setBuscarItem('')}>Quitar la búsqueda</Button>}
        />
      ) : porPasillo ? (
        <div className="space-y-3">
          {grupos.map((grupo) => (
            <section key={grupo.id}>
              {/* El pasillo, como etiqueta fina: separa sin llenar la pantalla de
                  franjas de color. */}
              <div className="flex items-baseline justify-between gap-2 px-1 pb-1">
                <p className="flex items-center gap-1.5 text-[0.64rem] font-semibold uppercase tracking-[0.08em] text-faint">
                  <span aria-hidden>{grupo.emoji}</span>
                  {grupo.label}
                </p>
                <span className="text-[0.64rem] tabular-nums text-faint">{grupo.items.length}</span>
              </div>
              <div className="divide-y divide-border-soft overflow-hidden rounded-2xl border border-border-soft bg-surface">
                {grupo.items.map((item) => (
                  <FilaProducto
                    key={item.id}
                    item={item}
                    currency={currency}
                    registered={registered}
                    onToggle={() => void togglePurchased(item)}
                    onEdit={() => {
                      setEditing(item);
                      setEditName(item.name);
                      setEditQuantity(item.quantity);
                      setEditUnit(item.unit ?? '');
                      setEditEstimated(item.estimatedUnitPrice ?? '');
                      setEditActual(item.actualUnitPrice ?? '');
                    }}
                    onDelete={() => setToDeleteItem(item)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="divide-y divide-border-soft">
            {itemsVisibles.map((item) => (
              <FilaProducto
                key={item.id}
                item={item}
                currency={currency}
                registered={registered}
                onToggle={() => void togglePurchased(item)}
                onEdit={() => {
                  setEditing(item);
                  setEditName(item.name);
                  setEditQuantity(item.quantity);
                  setEditUnit(item.unit ?? '');
                  setEditEstimated(item.estimatedUnitPrice ?? '');
                  setEditActual(item.actualUnitPrice ?? '');
                }}
                onDelete={() => setToDeleteItem(item)}
              />
            ))}
          </div>
        </Card>
      )}
      {/* Cómo va la compra: consejos calculados en el dispositivo */}
      {list.items.length > 0 ? (
        <Card className="sin-imprimir space-y-2">
          <SectionTitle
            title="Cómo va la compra"
            hint={`${grupos.length} pasillo(s) · calculado en este dispositivo`}
          />
          <ul className="space-y-1.5">
            {consejos.map((consejo) => (
              <li key={consejo} className="flex gap-2 text-xs leading-snug text-muted">
                <span aria-hidden className="text-brand">
                  •
                </span>
                <span>{consejo}</span>
              </li>
            ))}
          </ul>
          <p className="text-[0.7rem] leading-snug text-faint">
            Los pasillos se deducen del nombre de cada producto y no se envía nada fuera de su teléfono.
          </p>
        </Card>
      ) : null}

      {/* Acciones de la lista */}
      <Card className="space-y-3">
        <SectionTitle
          title="Terminar la compra"
          hint="Registrar el gasto es lo único que mueve dinero: se hace contra el servidor, con su asiento contable."
        />
        {registered ? (
          <Link to="/movimientos">
            <Button variant="secondary" fullWidth>
              Ver el movimiento en Movimientos
            </Button>
          </Link>
        ) : (
          <Button fullWidth onClick={() => setPaying(true)} disabled={fromCache}>
            <IconArrowDown size={18} /> Registrar gasto en FINANZA
          </Button>
        )}

        {!registered && fromCache ? (
          <p className="text-xs leading-snug text-faint">
            Sin conexión no se puede registrar el gasto (necesita el servidor para crear el asiento). Cuando vuelva la
            conexión, este botón se activará solo.
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2 border-t border-border-soft pt-3">
          {list.status === 'DRAFT' ? (
            <Button variant="secondary" size="sm" disabled={fromCache} onClick={() => void setStatus('ACTIVE')}>
              Marcar como en curso
            </Button>
          ) : null}
          {list.status === 'ACTIVE' ? (
            <Button variant="secondary" size="sm" disabled={fromCache} onClick={() => void setStatus('COMPLETED')}>
              Marcar como terminada
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" disabled={fromCache} onClick={() => void duplicate()}>
            Duplicar para la próxima vez
          </Button>
          {list.status !== 'ARCHIVED' ? (
            <Button variant="ghost" size="sm" disabled={fromCache} onClick={() => void setStatus('ARCHIVED')}>
              Archivar
            </Button>
          ) : null}
          {pending ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const result = await flushShoppingQueue();
                toast.info(`${result.sent} enviada(s) · ${result.pending} pendiente(s)`);
                await refresh();
              }}
            >
              Enviar cambios pendientes
            </Button>
          ) : null}
        </div>
      </Card>

      {/* Editar producto */}
      <Sheet open={editing !== null} onClose={() => setEditing(null)} title="Editar producto">
        <div className="space-y-3 pb-3">
          <Field label="Producto" value={editName} onChange={setEditName} autoComplete="off" />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cantidad" value={editQuantity} onChange={setEditQuantity} inputMode="decimal" />
            <Field label="Unidad (opcional)" value={editUnit} onChange={setEditUnit} placeholder="kg, litro…" autoComplete="off" />
          </div>
          <MoneyInput label="Precio estimado" value={editEstimated} onChange={setEditEstimated} size="md" />
          {editing?.isPurchased ? (
            <MoneyInput label="Precio real pagado" value={editActual} onChange={setEditActual} size="md" hint="Lo que costó de verdad." />
          ) : null}
          {editing?.isPurchased ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-negative"
              onClick={() => {
                setEditActual('');
                setEditing((current) => (current ? { ...current, actualUnitPrice: null } : current));
              }}
            >
              <IconClose size={16} /> Quitar el precio real
            </Button>
          ) : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button disabled={editName.trim().length < 1} onClick={() => void saveEditedItem()}>
              Guardar
            </Button>
          </div>
        </div>
      </Sheet>

      {/* Registrar el gasto: columna a todo el alto, con todas las opciones a la
          vista y las acciones fijas abajo (en una hoja, con el teclado abierto,
          la mitad de los campos quedaban tapados). */}
      <Panel
        open={paying}
        onClose={() => setPaying(false)}
        title="Registrar el gasto en FINANZA"
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setPaying(false)}>
              Cancelar
            </Button>
            <Button disabled={payingBusy || !payAccountId || !payAmount} onClick={() => void registerExpense()}>
              {payingBusy ? 'Registrando…' : 'Registrar gasto'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Notice tone="info">Se registrará <strong>un movimiento de gasto</strong>. No se duplica si vuelve a pulsar.</Notice>

          <div className="rounded-xl border border-border-soft bg-surface p-3">
            <p className="text-[0.7rem] uppercase tracking-wide text-faint">Esta compra</p>
            <p className="mt-0.5 truncate text-sm font-semibold text-ink">{list.name}</p>
            <p className="mt-1 text-xs text-muted">
              {comprados} de {total || 0} productos marcados · estimado{' '}
              <Money value={list.totals.estimated} currency={currency} />
            </p>
          </div>

          <Select
            label="¿De qué cuenta sale el dinero?"
            value={payAccountId}
            onChange={setPayAccountId}
            options={(accountsQuery.data ?? []).map((account) => ({
              value: account.id,
              label: `${account.name}${account.isCreditCard ? ' (tarjeta)' : ''} · ${account.balance}`,
            }))}
            placeholder="Elija la cuenta"
          />
          <Select
            label="Categoría (opcional)"
            value={payCategoryId}
            onChange={setPayCategoryId}
            options={(categoriesQuery.data ?? []).map((category) => ({ value: category.id, label: category.name }))}
            placeholder="Sin categoría"
            action={<BotonNuevaCategoria onClick={() => setNuevaCategoria(true)} />}
          />
          <MoneyInput label="Importe pagado" value={payAmount} onChange={setPayAmount} />
          <Field label="Fecha del gasto" value={payDate} onChange={setPayDate} type="date" />
        </div>
      </Panel>

      {/* La categoría que falta se crea aquí mismo y queda seleccionada. */}
      <NuevaCategoriaSheet
        abierto={nuevaCategoria}
        kind="EXPENSE"
        entityId={list.entityId}
        onCerrar={() => setNuevaCategoria(false)}
        onCreada={(creada) => {
          setPayCategoryId(creada.id);
          setNuevaCategoria(false);
        }}
      />

      <ConfirmDialog
        open={toDeleteItem !== null}
        tone="danger"
        title="¿Borrar este producto?"
        confirmLabel="Sí, borrar"
        message={
          <>
            <p className="font-medium text-ink">{toDeleteItem?.name}</p>
            <p className="mt-1">Se quitará de la lista. No afecta a ningún gasto.</p>
          </>
        }
        onCancel={() => setToDeleteItem(null)}
        onConfirm={() => void deleteItem()}
      />

      {/* Espacio al final para que el botón flotante no tape el último producto. */}
      <div className="h-20" aria-hidden="true" />

      {/* BOTÓN FLOTANTE PARA AÑADIR (estilo AppSheet)
          ------------------------------------------
          La pantalla se queda con la lista y la lupa; añadir producto —con su
          cantidad, su precio y las plantillas— vive en este botón, que abre el
          formulario en una hoja. Así la lista ocupa casi toda la pantalla, que
          es lo que se mira en la tienda. */}
      {!registered ? (
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          aria-label="Añadir producto a la lista"
          className="fixed bottom-[calc(var(--safe-bottom)+1.25rem)] right-4 z-30 flex h-14 items-center gap-1.5 rounded-full bg-brand pl-4 pr-5 text-sm font-semibold text-white shadow-elevated transition active:scale-95"
        >
          <IconPlus size={22} />
          Añadir
        </button>
      ) : null}

      {/* Añadir a la lista: todo en el mismo sitio (nombre, cantidad y precio). */}
      <Sheet open={addOpen} onClose={() => setAddOpen(false)} title="Añadir a la lista">
        <form
          className="space-y-3 pb-3"
          onSubmit={(event) => {
            event.preventDefault();
            void addItem();
          }}
        >
          <Field
            label="¿Qué necesita?"
            value={addName}
            onChange={setAddName}
            placeholder="Ej.: arroz, plátano, detergente…"
            autoComplete="off"
            enterKeyHint="done"
          />
          <div className="flex items-end gap-2">
            <div className="w-24 shrink-0">
              <Field label="Cantidad" value={addQuantity} onChange={setAddQuantity} inputMode="decimal" />
            </div>
            <div className="min-w-0 flex-1">
              <Field
                label="Precio estimado"
                value={addPrice}
                onChange={setAddPrice}
                inputMode="decimal"
                placeholder="opcional"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => setPlantillasOpen(true)}
            className="w-full text-center text-[0.7rem] font-medium text-brand underline decoration-dotted underline-offset-2"
          >
            Empezar con una plantilla…
          </button>
          <Button type="submit" fullWidth size="lg" disabled={adding || addName.trim().length < 1} aria-label="Añadir a la lista">
            {adding ? 'Añadiendo…' : 'Añadir a la lista'}
          </Button>
        </form>
      </Sheet>

      {/* REPARTIR LA COMPRA ENTRE DOS
          ----------------------------
          Se reparte lo que FALTA por pasillos: cada persona coge una parte y no
          se pisan. No cambia nada de la lista ni necesita conexión; la parte 2 se
          puede enviar por WhatsApp o Bluetooth para que la lleve la otra persona
          en su teléfono (no hace falta que tenga la app). */}
      <Sheet open={repartirOpen} onClose={() => setRepartirOpen(false)} title="Repartir la compra">
        <div className="space-y-3 pb-2">
          <p className="text-xs leading-snug text-muted">
            Se reparte lo que falta por comprar <strong>por pasillos</strong>: cada uno coge una parte y no se pisan
            dentro del súper.
          </p>
          {partes.map((parte) => (
            <div key={parte.numero} className="rounded-xl border border-border-soft p-3">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-ink">{parte.etiqueta}</p>
                <span className="shrink-0 text-xs tabular-nums text-muted">
                  {parte.items.length} producto(s)
                </span>
              </div>
              <p className="mt-1 text-[0.7rem] leading-snug text-muted">
                {parte.grupos.length > 0
                  ? parte.grupos.map((grupo) => `${grupo.emoji} ${grupo.label}`).join(' · ')
                  : 'Sin productos pendientes'}
              </p>
              {parte.items.length > 0 ? (
                <button
                  type="button"
                  onClick={() => void compartirParte(parte)}
                  className="mt-2 text-xs font-semibold text-brand underline decoration-dotted underline-offset-2"
                >
                  Compartir esta parte
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </Sheet>

      {/* Plantillas: lo que se compra igual cada semana o cada mes. */}
      <Sheet open={plantillasOpen} onClose={() => setPlantillasOpen(false)} title="Empezar con una plantilla">
        <div className="space-y-2 pb-2">
          {PLANTILLAS.map((plantilla) => {
            const { nuevos, repetidos } = productosNuevos(plantilla, list.items);
            const sinNadaNuevo = nuevos.length === 0;
            return (
              <button
                key={plantilla.id}
                type="button"
                disabled={aplicando || sinNadaNuevo}
                onClick={() => void aplicarPlantilla(plantilla)}
                className="flex w-full items-start gap-3 rounded-xl border border-border-soft p-3 text-left transition hover:bg-surface-2 active:bg-surface-3 disabled:opacity-50"
              >
                <span aria-hidden className="text-xl leading-none">
                  {plantilla.emoji}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{plantilla.label}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted">{plantilla.description}</span>
                  <span className="mt-1 block text-[0.68rem] text-faint">
                    {sinNadaNuevo
                      ? 'Ya están todos en la lista'
                      : `${nuevos.length} producto(s)` +
                        (repetidos > 0 ? ` · ${repetidos} ya en la lista` : '')}
                  </span>
                </span>
              </button>
            );
          })}

          <p className="pt-1 text-[0.7rem] leading-snug text-faint">
            {aplicando
              ? 'Añadiendo los productos…'
              : 'Los precios no vienen rellenos a propósito: se ponen al comprar, o se dejan vacíos.'}
          </p>
        </div>
      </Sheet>

      {/*
        HOJA PARA IMPRIMIR O GUARDAR EN PDF
        ----------------------------------
        Se genera aquí mismo, sin servidores ni librerías: al pulsar «Imprimir /
        PDF» el navegador abre su diálogo y ahí se elige la impresora o «Guardar
        como PDF». La hoja lleva casillas para ir marcando en la tienda.
        Se monta fuera de la aplicación (en <body>) para que la impresión salga
        limpia: sólo esta hoja, sin menús ni botones.
      */}
      {createPortal(
        <div id="hoja-compra" aria-hidden="true" className="hidden">
        <h1 className="text-xl font-bold">{list.name}</h1>
        <p className="mt-0.5 text-sm">
          {entity?.name ?? ''}
          {list.plannedDate ? ` · para el ${list.plannedDate}` : ''}
        </p>

        <table className="mt-4 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-black text-left">
              <th className="w-6" />
              <th className="py-1">Producto</th>
              <th className="py-1 text-center">Cant.</th>
              <th className="py-1 text-right">Precio</th>
              <th className="py-1 text-right">Importe</th>
            </tr>
          </thead>
          <tbody>
            {grupos.map((grupo) => (
              <Fragment key={grupo.id}>
                <tr>
                  <td colSpan={5} className="pt-3 text-[0.7rem] font-bold uppercase tracking-wide">
                    {grupo.label}
                  </td>
                </tr>
                {grupo.items.map((item) => (
                  <tr key={item.id} className="border-b border-gray-300">
                    <td className="py-1">☐</td>
                    <td className="py-1">{item.name}</td>
                    <td className="py-1 text-center">
                      {item.quantity}
                      {item.unit ? ` ${item.unit}` : ''}
                    </td>
                    <td className="py-1 text-right">
                      {item.estimatedUnitPrice ? formatMoney(item.estimatedUnitPrice, currency) : '—'}
                    </td>
                    <td className="py-1 text-right">
                      {item.estimatedTotal !== '0.00' ? formatMoney(item.estimatedTotal, currency) : '—'}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>

        <p className="mt-4 text-right text-base font-bold">
          Total estimado: {formatMoney(list.totals.estimated, currency)}
        </p>
        {list.totals.actual !== '0.00' ? (
          <p className="text-right text-sm">Pagado de verdad: {formatMoney(list.totals.actual, currency)}</p>
        ) : null}
        <p className="mt-6 text-xs">Generado con FINANZA · {new Date().toLocaleDateString('es-DO')}</p>
        </div>,
        document.body,
      )}
    </ListScreen>
  );
}

/**
 * Una fila de producto. Vive fuera de la página porque se usa en las dos vistas
 * (por pasillos y en el orden en que se añadieron) y así no hay dos copias del
 * mismo marcado que puedan desincronizarse.
 */
function FilaProducto({
  item,
  currency,
  registered,
  onToggle,
  onEdit,
  onDelete,
}: {
  item: RemoteShoppingItem;
  currency: string;
  registered: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  /**
   * DESLIZAR LA FILA (en la tienda, con una mano)
   * ---------------------------------------------
   * Deslizar hacia la izquierda marca el producto como comprado; hacia la
   * derecha lo desmarca. Es el gesto natural mientras se empuja el carrito y se
   * lleva el teléfono en la otra mano.
   *
   * Sólo se actúa si el movimiento es claramente horizontal (70 px y menos de
   * 50 px en vertical): así no se marca nada sin querer al desplazar la lista.
   */
  const inicio = useRef<{ x: number; y: number } | null>(null);

  return (
    <div
      className="flex items-start gap-3 px-3 py-2.5 transition"
      onTouchStart={(event) => {
        const punto = event.touches[0];
        inicio.current = { x: punto.clientX, y: punto.clientY };
      }}
      onTouchEnd={(event) => {
        const desde = inicio.current;
        inicio.current = null;
        if (!desde || registered) {
          return;
        }
        const punto = event.changedTouches[0];
        const dx = punto.clientX - desde.x;
        const dy = punto.clientY - desde.y;
        if (Math.abs(dx) < 70 || Math.abs(dy) > 50) {
          return;
        }
        // Izquierda: marcar. Derecha: desmarcar.
        if ((dx < 0 && !item.isPurchased) || (dx > 0 && item.isPurchased)) {
          onToggle();
        }
      }}
    >
      <button
        type="button"
        disabled={registered}
        onClick={onToggle}
        aria-label={item.isPurchased ? `Desmarcar ${item.name}` : `Marcar ${item.name} como comprado`}
        className={`mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition ${
          item.isPurchased
            ? 'border-positive bg-positive/15 text-positive'
            : 'border-border-strong text-faint hover:text-ink'
        } ${registered ? 'opacity-60' : ''}`}
      >
        {item.isPurchased ? <IconCheck size={18} /> : <span className="h-4 w-4 rounded-full border border-current" />}
      </button>

      <div className="min-w-0 flex-1">
        <p
          className={`truncate text-[0.9rem] font-medium leading-snug ${
            item.isPurchased ? 'text-muted line-through' : 'text-ink'
          }`}
        >
          {item.name}
        </p>
        <p className="mt-0.5 text-[0.7rem] tabular-nums text-muted">
          {item.quantity}
          {item.unit ? ` ${item.unit}` : ''}
          {item.estimatedUnitPrice ? ` × ${formatMoney(item.estimatedUnitPrice, currency)}` : ''}
          {item.isPurchased && item.actualUnitPrice ? ` · pagado ${formatMoney(item.actualUnitPrice, currency)}` : ''}
        </p>
      </div>

      <div className="shrink-0 text-right">
        <p className="text-[0.85rem] font-semibold tabular-nums">
          <Money
            value={item.isPurchased ? item.actualTotal : item.estimatedTotal}
            currency={currency}
            tone={item.isPurchased ? 'negative' : 'neutral'}
          />
        </p>
        {!registered ? (
          <div className="mt-0.5 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onEdit}
              className="text-[0.66rem] text-faint transition hover:text-ink"
            >
              Editar
            </button>
            {!item.isPurchased ? (
              <button
                type="button"
                onClick={onDelete}
                aria-label={`Borrar ${item.name}`}
                className="text-[0.66rem] text-faint transition hover:text-negative"
              >
                Borrar
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
