import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../store/auth';
import { Card, ListScreen, Money, Notice, SectionTitle, Sheet, Skeleton, Spinner } from '../components/ui';
import { IconChevronRight, IconSearch } from '../components/icons';

/**
 * CATÁLOGO DE PRODUCTOS
 * =====================
 * Lo que ya se ha comprado, con el precio real que se pagó. Se llena solo:
 *   · al leer una factura con IA (todas sus líneas con precio);
 *   · al marcar un producto como comprado con su precio.
 *
 * Para qué sirve: saber cuánto cuesta cada cosa ANTES de comprarla, ver si el
 * precio de hoy está por encima de lo habitual y comparar entre comercios.
 * No es un documento contable: aquí no hay dinero que mover.
 */

interface CatalogoFila {
  name: string;
  normalizedName: string;
  unit: string | null;
  lastUnitPrice: string | null;
  minUnitPrice: string | null;
  maxUnitPrice: string | null;
  timesPurchased: number;
  lastSupplier: string | null;
  lastSeenAt: string | null;
}

interface FichaProducto extends CatalogoFila {
  history: Array<{
    date: string;
    listId: string;
    listName: string;
    quantity: string;
    unit: string | null;
    unitPrice: string | null;
  }>;
}

export function CatalogPage() {
  const { preferences } = useAuth();
  const currency = preferences?.currency ?? 'DOP';

  const [busqueda, setBusqueda] = useState('');
  const [filas, setFilas] = useState<CatalogoFila[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [ficha, setFicha] = useState<FichaProducto | null>(null);
  const [fichaCargando, setFichaCargando] = useState(false);
  const [fichaError, setFichaError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    setCargando(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams();
          const termino = busqueda.trim();
          if (termino.length >= 2) {
            params.set('search', termino);
          }
          const data = await api.get<{ entries: CatalogoFila[] }>(`/shopping-lists/catalog?${params.toString()}`);
          if (!cancelado) {
            setFilas(data.entries ?? []);
            setError(null);
          }
        } catch (caught) {
          if (!cancelado) {
            setError(caught instanceof ApiError ? caught.message : 'No se pudo leer el catálogo.');
            setFilas([]);
          }
        } finally {
          if (!cancelado) {
            setCargando(false);
          }
        }
      })();
    }, 250);

    return () => {
      cancelado = true;
      window.clearTimeout(timer);
    };
  }, [busqueda]);

  const resumen = useMemo(() => {
    const compras = filas.reduce((acc, row) => acc + row.timesPurchased, 0);
    return { productos: filas.length, compras };
  }, [filas]);

  const abrirFicha = async (row: CatalogoFila) => {
    setFichaError(null);
    setFichaCargando(true);
    setFicha({ ...row, history: [] });
    try {
      const data = await api.get<FichaProducto>(`/shopping-lists/catalog/${encodeURIComponent(row.normalizedName)}`);
      setFicha(data);
    } catch (caught) {
      setFichaError(caught instanceof ApiError ? caught.message : 'No se pudo abrir el producto.');
    } finally {
      setFichaCargando(false);
    }
  };

  /** Variación del último precio frente al mínimo pagado. */
  const variacion = (row: Pick<CatalogoFila, 'lastUnitPrice' | 'minUnitPrice'>) => {
    if (row.lastUnitPrice === null || row.minUnitPrice === null) {
      return null;
    }
    const ultimo = Number(row.lastUnitPrice);
    const minimo = Number(row.minUnitPrice);
    if (!Number.isFinite(ultimo) || !Number.isFinite(minimo) || minimo <= 0) {
      return null;
    }
    return Math.round(((ultimo - minimo) / minimo) * 100);
  };

  return (
    <ListScreen
      title="Catálogo de productos"
      purpose="Lo que ya compró y a qué precio. Se llena con las facturas que lee la IA."
      toolbar={
        <>
          <div className="relative">
            <IconSearch size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <input
              value={busqueda}
              onChange={(event) => setBusqueda(event.target.value)}
              aria-label="Buscar en el catálogo"
              placeholder="Buscar un producto…"
              autoComplete="off"
              enterKeyHint="search"
              className="h-11 w-full border border-border-soft bg-surface-2 pl-9 pr-3 text-base text-ink outline-none transition placeholder:text-faint focus:border-brand"
            />
          </div>
          <p className="px-1 text-[0.72rem] text-muted">
            {resumen.productos} producto(s) · {resumen.compras} compra(s) registradas
          </p>
        </>
      }
    >
      {error ? <Notice tone="warning">{error}</Notice> : null}

      {cargando ? (
        <div className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : null}

      {!cargando && filas.length === 0 && !error ? (
        <Card>
          <SectionTitle title="Todavía no hay productos" />
          <p className="text-sm leading-snug text-muted">
            El catálogo se llena al <strong>finalizar una compra con factura</strong> (la IA escribe los productos y sus
            precios) o al marcar un producto como comprado con su precio. Después podrá consultar aquí cuánto cuesta
            cada cosa.
          </p>
        </Card>
      ) : null}

      {!cargando && filas.length > 0 ? (
        <Card>
          <div className="divide-y divide-border-soft">
            {filas.map((row) => {
              const cambio = variacion(row);
              return (
                <button
                  key={row.normalizedName}
                  type="button"
                  onClick={() => void abrirFicha(row)}
                  className="flex w-full items-center gap-3 py-2.5 text-left transition hover:bg-surface-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{row.name}</p>
                    <p className="mt-0.5 truncate text-[0.7rem] text-faint">
                      {row.timesPurchased} compra(s)
                      {row.minUnitPrice !== null && row.maxUnitPrice !== null && row.minUnitPrice !== row.maxUnitPrice
                        ? ` · entre ${row.minUnitPrice} y ${row.maxUnitPrice}`
                        : ''}
                      {row.lastSupplier ? ` · ${row.lastSupplier}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold tabular-nums text-ink">
                      {row.lastUnitPrice === null ? '—' : <Money value={row.lastUnitPrice} currency={currency} />}
                    </p>
                    {cambio !== null && cambio > 0 ? (
                      <p className="text-[0.68rem] text-negative">+{cambio}% sobre el mínimo</p>
                    ) : cambio === 0 ? (
                      <p className="text-[0.68rem] text-positive">en su precio más bajo</p>
                    ) : null}
                  </div>
                  <IconChevronRight size={16} className="shrink-0 text-faint" />
                </button>
              );
            })}
          </div>
        </Card>
      ) : null}

      {/* Ficha del producto: precios y últimas compras. */}
      <Sheet open={ficha !== null} onClose={() => setFicha(null)} title={ficha?.name ?? 'Producto'}>
        <div className="space-y-3 pb-3">
          {ficha ? (
            <>
              <div className="divide-y divide-border-soft border border-border-soft text-sm">
                <div className="flex items-baseline justify-between gap-3 p-2">
                  <span className="text-muted">Último precio</span>
                  <span className="font-semibold text-ink">
                    {ficha.lastUnitPrice === null ? '—' : <Money value={ficha.lastUnitPrice} currency={currency} />}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-3 p-2">
                  <span className="text-muted">Precio más bajo</span>
                  <span className="text-ink">
                    {ficha.minUnitPrice === null ? '—' : <Money value={ficha.minUnitPrice} currency={currency} />}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-3 p-2">
                  <span className="text-muted">Precio más alto</span>
                  <span className="text-ink">
                    {ficha.maxUnitPrice === null ? '—' : <Money value={ficha.maxUnitPrice} currency={currency} />}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-3 p-2">
                  <span className="text-muted">Veces comprado</span>
                  <span className="text-ink">{ficha.timesPurchased}</span>
                </div>
                {ficha.unit ? (
                  <div className="flex items-baseline justify-between gap-3 p-2">
                    <span className="text-muted">Unidad</span>
                    <span className="text-ink">{ficha.unit}</span>
                  </div>
                ) : null}
                {ficha.lastSupplier ? (
                  <div className="flex items-baseline justify-between gap-3 p-2">
                    <span className="text-muted">Último comercio</span>
                    <span className="text-ink">{ficha.lastSupplier}</span>
                  </div>
                ) : null}
              </div>

              {fichaCargando ? <Spinner label="Leyendo sus compras…" /> : null}
              {fichaError ? <Notice tone="warning">{fichaError}</Notice> : null}

              {ficha.history.length > 0 ? (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Últimas compras</p>
                  <div className="divide-y divide-border-soft">
                    {ficha.history.map((row, index) => (
                      <div key={`${row.listId}-${index}`} className="flex items-baseline justify-between gap-2 py-1.5 text-xs">
                        <span className="min-w-0 truncate text-muted">
                          {row.date} · {row.listName}
                        </span>
                        <span className="shrink-0 tabular-nums text-ink">
                          {row.quantity}
                          {row.unit ? ` ${row.unit}` : ''} ·{' '}
                          {row.unitPrice === null ? '—' : <Money value={row.unitPrice} currency={currency} />}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-faint">
                  El historial aparece cuando la compra queda cerrada; los precios ya están guardados.
                </p>
              )}

              <p className="text-[0.7rem] leading-snug text-faint">
                Los precios son los que pagó, no una estimación. El catálogo no mueve dinero ni crea movimientos.
              </p>
            </>
          ) : null}
        </div>
      </Sheet>
    </ListScreen>
  );
}
