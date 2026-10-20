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
  Field,
  ListScreen,
  Money,
  Notice,
  ProgressBar,
  Sheet,
  Skeleton,
} from '../components/ui';
import { toast } from '../components/Toast';
import { IconChevronLeft, IconChevronRight, IconClose, IconPlus, IconSearch } from '../components/icons';
import {
  createListOffline,
  flushShoppingQueue,
  loadShoppingLists,
  type RemoteShoppingList,
} from '../lib/shopping-offline';
import { countShoppingPending, getLocalShoppingLists, removeLocalShoppingList } from '../lib/db';
import { todayBusinessDate } from '../lib/format';

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

export function ShoppingPage() {
  const { entities, preferences } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const entityId = params.get('entityId') ?? '';

  const [lists, setLists] = useState<RemoteShoppingList[]>([]);
  const [loading, setLoading] = useState(true);
  const [fromCache, setFromCache] = useState(false);
  const [filtro, setFiltro] = useState<Filtro>('ABIERTAS');
  const [busqueda, setBusqueda] = useState('');
  const [buscando, setBuscando] = useState(false);
  const [pending, setPending] = useState(0);
  // Modo tienda: trabajar sin esperar al servidor (la señal del súper va y viene).
  const [modoTienda, setModoTienda] = useState(() => modoTiendaActivo());

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEntityId, setNewEntityId] = useState(entityId || entities[0]?.id || '');
  const [newDate, setNewDate] = useState(todayBusinessDate(preferences?.timezone));
  const [newNotes, setNewNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const [toDelete, setToDelete] = useState<RemoteShoppingList | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const currency = preferences?.currency ?? 'DOP';

  const refresh = async () => {
    setLoading(true);
    const result = await loadShoppingLists({ entityId, search: busqueda });
    setLists(result.lists);
    setFromCache(result.fromCache);
    setPending(await countShoppingPending());
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, busqueda]);

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

  const duplicate = async (list: RemoteShoppingList) => {
    setBusyId(list.id);
    try {
      await api.post(`/shopping-lists/${list.id}/duplicate`, {});
      toast.success('Lista duplicada como borrador.');
      await refresh();
    } catch (error) {
      toast.error('No se pudo duplicar', error instanceof ApiError ? error.message : 'Requiere conexión.');
    } finally {
      setBusyId(null);
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
            Va de borde a borde (-mx-4) para que parezca la barra de la app y no
            una tarjeta más.
          */}
          <div className="-mx-4 border-b border-border-soft bg-bg/95 px-2 pb-1.5 pt-[calc(var(--safe-top)+0.3rem)] backdrop-blur-md">
          {buscando ? (
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
                  className="h-10 w-full rounded-full border border-border-soft bg-surface-2 pl-9 pr-9 text-sm text-ink outline-none transition placeholder:text-faint focus:border-brand"
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

          {fromCache ? (
            <Notice tone="warning" title="Mostrando lo guardado en este dispositivo">
              No hay conexión con el servidor. Puede consultar y preparar sus listas; los cambios quedarán
              <strong> pendientes de enviar</strong>.
            </Notice>
          ) : null}

          {pending > 0 ? (
            <Notice tone="info">
              {pending} lista(s) con cambios <strong>pendientes de enviar</strong>. Se enviarán solas cuando haya conexión.
            </Notice>
          ) : null}

          {/* Filtro: tres píldoras en una sola línea, sin caja alrededor. */}
          <div className="flex items-center gap-1.5" role="group" aria-label="Filtrar las listas">
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
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
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
              title="Trabajar sin esperar al servidor (la compra se guarda en el teléfono)"
              className={`ml-auto rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                modoTienda
                  ? 'bg-warning/20 text-ink ring-1 ring-warning/50'
                  : 'text-muted ring-1 ring-border-soft hover:text-ink'
              }`}
            >
              {modoTienda ? 'Modo tienda: sí' : 'Modo tienda'}
            </button>
          </div>
        </>
      }
    >

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : filtered.length === 0 ? (
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

                  <div className="flex items-baseline justify-between gap-2 text-[0.7rem]">
                    <span className="text-faint">
                      Estimado{' '}
                      <span className="font-semibold tabular-nums text-ink">
                        <Money value={list.totals.estimated} currency={currency} />
                      </span>
                    </span>
                    <span className="text-faint">
                      Pagado{' '}
                      <span className="font-semibold tabular-nums text-ink">
                        <Money
                          value={list.totals.actual}
                          currency={currency}
                          tone={list.totals.actual === '0.00' ? 'neutral' : 'negative'}
                        />
                      </span>
                    </span>
                    <span className="text-faint">
                      Falta{' '}
                      <span className="font-semibold tabular-nums text-ink">
                        <Money value={list.totals.pending} currency={currency} />
                      </span>
                    </span>
                  </div>
                </Link>

                <div className="flex flex-wrap items-center gap-1 border-t border-border-soft pt-2">
                  <Button variant="ghost" size="sm" disabled={busyId === list.id || isLocal} onClick={() => void duplicate(list)}>
                    Duplicar
                  </Button>
                  {list.status !== 'ARCHIVED' ? (
                    <Button variant="ghost" size="sm" disabled={busyId === list.id || isLocal} onClick={() => void archive(list)}>
                      Archivar
                    </Button>
                  ) : null}
                  {!list.expense.registered ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === list.id || isLocal}
                      onClick={() => setToDelete(list)}
                      className="ml-auto text-negative"
                    >
                      Borrar
                    </Button>
                  ) : null}
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

      {/* Espacio al final para que el botón flotante no tape la última tarjeta. */}
      <div className="h-20" aria-hidden="true" />

      {/* BOTÓN FLOTANTE PARA CREAR (estilo AppSheet)
          ------------------------------------------
          Antes vivía en la barra de arriba, compitiendo con el título. Flotando
          abajo a la derecha está siempre a mano del pulgar y no ocupa la barra. */}
      <button
        type="button"
        onClick={() => setCreating(true)}
        className="fixed bottom-[calc(var(--safe-bottom)+1.25rem)] right-4 z-30 flex h-14 items-center gap-1.5 rounded-full bg-brand pl-4 pr-5 text-sm font-semibold text-white shadow-elevated transition active:scale-95"
      >
        <IconPlus size={22} />
        Nueva
      </button>

      {/* Nueva lista */}
      <Sheet open={creating} onClose={() => setCreating(false)} title="Nueva lista de compras">
        <div className="space-y-3 pb-3">
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
