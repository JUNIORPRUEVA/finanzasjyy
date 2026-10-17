import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../store/auth';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Money,
  MoneyInput,
  Notice,
  ProgressBar,
  SectionTitle,
  Select,
  Sheet,
  Skeleton,
} from '../components/ui';
import { toast } from '../components/Toast';
import { IconArrowDown, IconCheck, IconChevronLeft, IconClose, IconPlus } from '../components/icons';
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

  const [editing, setEditing] = useState<RemoteShoppingItem | null>(null);
  const [editName, setEditName] = useState('');
  const [editQuantity, setEditQuantity] = useState('1');
  const [editUnit, setEditUnit] = useState('');
  const [editEstimated, setEditEstimated] = useState('');
  const [editActual, setEditActual] = useState('');

  const [toDeleteItem, setToDeleteItem] = useState<RemoteShoppingItem | null>(null);

  const [paying, setPaying] = useState(false);
  const [payAccountId, setPayAccountId] = useState('');
  const [payCategoryId, setPayCategoryId] = useState('');
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
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <Link
          to="/compras"
          aria-label="Volver a Compras"
          className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink"
        >
          <IconChevronLeft size={20} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-tight text-ink">{list.name}</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {list.entityName ?? entity?.name ?? 'Unidad financiera'}
            {list.plannedDate ? <span>· prevista {list.plannedDate}</span> : null}
            {registered ? <Badge tone="positive">gasto registrado</Badge> : null}
            {fromCache ? <Badge tone="warning">sin conexión</Badge> : null}
          </p>
        </div>
      </div>

      {fromCache ? (
        <Notice tone="warning" title="Sin conexión con el servidor">
          Puede seguir preparando y editando la lista: los cambios se guardan en este dispositivo y se enviarán solos.
          Para <strong>registrar el gasto</strong> hace falta conexión, porque mueve dinero real.
        </Notice>
      ) : null}

      {registered ? (
        <Notice tone="positive" title="Esta compra ya está contabilizada">
          El gasto está registrado en FINANZA con su asiento. La lista queda como historial: no se puede volver a
          registrar ni modificar lo comprado.
        </Notice>
      ) : null}

      <Card className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <SectionTitle title="Resumen de la compra" hint={`${comprados} de ${total || 0} productos comprados`} />
          <span className="text-sm font-semibold text-ink">{percent}%</span>
        </div>
        <ProgressBar percent={percent} tone={percent >= 100 ? 'positive' : 'neutral'} />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-3 border-t border-border-soft pt-3">
          <div>
            <p className="text-[0.7rem] uppercase tracking-wide text-faint">Estimado</p>
            <p className="mt-0.5 font-semibold">
              <Money value={list.totals.estimated} currency={currency} />
            </p>
          </div>
          <div>
            <p className="text-[0.7rem] uppercase tracking-wide text-faint">Pagado de verdad</p>
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
          <div>
            <p className="text-[0.7rem] uppercase tracking-wide text-faint">Desvío</p>
            <p className="mt-0.5 font-semibold">
              <Money
                value={list.totals.difference}
                currency={currency}
                tone={difference > 0 ? 'negative' : difference < 0 ? 'positive' : 'neutral'}
              />
            </p>
            <p className="text-[0.65rem] leading-snug text-faint">
              {difference > 0 ? 'Costó más de lo previsto' : difference < 0 ? 'Costó menos de lo previsto' : 'Sin desvío'}
            </p>
          </div>
        </div>
      </Card>

      <Card className="space-y-3">
        <SectionTitle
          title="Productos"
          hint={total === 0 ? 'Añada lo que necesita comprar' : `${comprados} comprados · ${total - comprados} pendientes`}
        />

        {total === 0 ? (
          <EmptyState
            title="Lista vacía"
            hint="Añada productos con su cantidad y el precio que espera pagar. Así sabrá cuánto va a gastar antes de salir."
          />
        ) : (
          <div className="space-y-2">
            {list.items.map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-3 rounded-xl border border-border-soft p-3 transition"
              >
                <button
                  type="button"
                  disabled={registered}
                  onClick={() => void togglePurchased(item)}
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
                  <p className={`text-sm font-medium ${item.isPurchased ? 'text-muted line-through' : 'text-ink'}`}>
                    {item.name}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {item.quantity}
                    {item.unit ? ` ${item.unit}` : ''}
                    {item.estimatedUnitPrice ? ` × ${formatMoney(item.estimatedUnitPrice, currency)}` : ' · sin precio estimado'}
                    {item.isPurchased && item.actualUnitPrice
                      ? ` · pagado ${formatMoney(item.actualUnitPrice, currency)}`
                      : ''}
                  </p>
                </div>

                <div className="shrink-0 text-right">
                  <p className="text-sm font-semibold">
                    <Money
                      value={item.isPurchased ? item.actualTotal : item.estimatedTotal}
                      currency={currency}
                      tone={item.isPurchased ? 'negative' : 'neutral'}
                    />
                  </p>
                  {!registered ? (
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(item);
                        setEditName(item.name);
                        setEditQuantity(item.quantity);
                        setEditUnit(item.unit ?? '');
                        setEditEstimated(item.estimatedUnitPrice ?? '');
                        setEditActual(item.actualUnitPrice ?? '');
                      }}
                      className="mt-1 text-xs text-brand underline"
                    >
                      Editar
                    </button>
                  ) : null}
                  {!registered && !item.isPurchased ? (
                    <button
                      type="button"
                      onClick={() => setToDeleteItem(item)}
                      className="mt-1 ml-2 text-xs text-negative underline"
                      aria-label={`Borrar ${item.name}`}
                    >
                      Borrar
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}

        {!registered ? (
          <div className="space-y-3 border-t border-border-soft pt-3">
            <p className="text-sm font-medium text-ink">Añadir producto</p>
            <Field
              label="¿Qué necesita?"
              value={addName}
              onChange={setAddName}
              placeholder="Ej.: Arroz"
              autoComplete="off"
              enterKeyHint="done"
              onEnter={() => void addItem()}
            />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Cantidad" value={addQuantity} onChange={setAddQuantity} inputMode="decimal" />
              <MoneyInput label="Precio estimado" value={addPrice} onChange={setAddPrice} size="md" />
            </div>
            <Button disabled={adding || addName.trim().length < 1} onClick={() => void addItem()} fullWidth>
              <IconPlus size={18} /> {adding ? 'Añadiendo…' : 'Añadir a la lista'}
            </Button>
          </div>
        ) : null}
      </Card>

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

      {/* Registrar el gasto */}
      <Sheet open={paying} onClose={() => setPaying(false)} title="Registrar el gasto en FINANZA">
        <div className="space-y-3 pb-3">
          <Notice tone="info">
            Se creará <strong>un movimiento de gasto</strong> con su asiento contable, igual que si lo registrara a mano.
            Si vuelve a pulsar, no se duplicará: la lista sólo puede generar un gasto.
          </Notice>
          <Select
            label="¿De qué cuenta sale el dinero?"
            value={payAccountId}
            onChange={setPayAccountId}
            options={(accountsQuery.data ?? []).map((account) => ({
              value: account.id,
              label: `${account.name}${account.isCreditCard ? ' (tarjeta)' : ''} · ${account.balance}`,
            }))}
            placeholder="— Seleccione la cuenta —"
          />
          <Select
            label="Categoría (opcional)"
            value={payCategoryId}
            onChange={setPayCategoryId}
            options={(categoriesQuery.data ?? []).map((category) => ({ value: category.id, label: category.name }))}
            placeholder="— Sin categoría (se usará «Otros») —"
          />
          <MoneyInput label="Importe pagado" value={payAmount} onChange={setPayAmount} />
          <Field label="Fecha del gasto" value={payDate} onChange={setPayDate} type="date" />
          <p className="text-xs leading-snug text-faint">
            El importe propuesto es lo que apuntó como real. Puede ajustarlo: lo que se contabiliza es lo que escriba
            aquí.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setPaying(false)}>
              Cancelar
            </Button>
            <Button disabled={payingBusy || !payAccountId || !payAmount} onClick={() => void registerExpense()}>
              {payingBusy ? 'Registrando…' : 'Registrar gasto'}
            </Button>
          </div>
        </div>
      </Sheet>

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
    </div>
  );
}
