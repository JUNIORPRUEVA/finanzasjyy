import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
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
  SearchBox,
  SegmentedControl,
  Sheet,
  Skeleton,
} from '../components/ui';
import { toast } from '../components/Toast';
import { IconPlus } from '../components/icons';
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
  const [pending, setPending] = useState(0);

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
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight text-ink">Compras</h1>
              <p className="text-xs leading-snug text-muted">
                Prepare lo que necesita; el gasto se registra aparte, cuando usted lo decide.
              </p>
            </div>
            <Button onClick={() => setCreating(true)} className="shrink-0" size="sm">
              <IconPlus size={18} /> Nueva
            </Button>
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

          <SearchBox
            value={busqueda}
            onChange={setBusqueda}
            label="Buscar en las listas"
            placeholder="Buscar lista o producto…"
          />

          <SegmentedControl
            options={[
              { value: 'ABIERTAS' as Filtro, label: 'Abiertas' },
              { value: 'FINALIZADAS' as Filtro, label: 'Finalizadas' },
              { value: 'TODAS' as Filtro, label: 'Todas' },
            ]}
            value={filtro}
            onChange={setFiltro}
          />
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
              <Card key={list.id} className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link to={`/compras/${list.id}`} className="block">
                      <p className="truncate text-base font-semibold text-ink">{list.name}</p>
                    </Link>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      {list.entityName ? <span className="truncate">{list.entityName}</span> : null}
                      {list.plannedDate ? <span>· prevista {list.plannedDate}</span> : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {list.status === 'COMPLETED' ? (
                      <Badge tone="positive">registrada</Badge>
                    ) : list.status === 'ARCHIVED' ? (
                      <Badge tone="neutral">archivada</Badge>
                    ) : (
                      <Badge tone="info">{comprados}/{total || 0} comprados</Badge>
                    )}
                    {isLocal ? <Badge tone="warning">pendiente de enviar</Badge> : null}
                  </div>
                </div>

                <ProgressBar percent={percent} tone={percent >= 100 ? 'positive' : 'neutral'} />

                <div className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-2 text-sm">
                  <div>
                    <p className="text-[0.7rem] uppercase tracking-wide text-faint">Estimado</p>
                    <p className="mt-0.5 font-semibold">
                      <Money value={list.totals.estimated} currency={currency} />
                    </p>
                  </div>
                  <div>
                    <p className="text-[0.7rem] uppercase tracking-wide text-faint">Pagado</p>
                    <p className="mt-0.5 font-semibold">
                      <Money value={list.totals.actual} currency={currency} tone={list.totals.actual === '0.00' ? 'neutral' : 'negative'} />
                    </p>
                  </div>
                  <div>
                    <p className="text-[0.7rem] uppercase tracking-wide text-faint">Falta por comprar</p>
                    <p className="mt-0.5 font-semibold">
                      <Money value={list.totals.pending} currency={currency} />
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 border-t border-border-soft pt-3">
                  <Link to={`/compras/${list.id}`}>
                    <Button variant="secondary" size="sm">
                      Abrir
                    </Button>
                  </Link>
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
                      className="text-negative"
                    >
                      Borrar
                    </Button>
                  ) : null}
                </div>

                {list.expense.registered ? (
                  <p className="text-[0.7rem] leading-snug text-faint">
                    Esta compra ya está registrada como gasto en FINANZA, por eso no se puede borrar: forma parte del
                    rastro de un movimiento real. Puede archivarla para quitarla de la vista.
                  </p>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

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
