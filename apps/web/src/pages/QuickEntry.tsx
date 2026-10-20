import { Link, useSearchParams } from 'react-router-dom';
import { KINDS, MovimientoForm, TITULO_MOVIMIENTO, type EntryKind } from '../components/MovimientoForm';
import { IconChevronLeft } from '../components/icons';

/**
 * PANTALLA DE REGISTRO (página completa)
 * --------------------------------------
 * Aquí se registra un movimiento, a pantalla completa y sin pestañas: lo que se
 * abre es exactamente lo que se eligió («Registrar gasto» es un gasto, no un
 * formulario para cambiar de tipo dentro). El tipo llega por el enlace
 * (`?kind=EXPENSE`), que es lo que usan el menú del «+» y los accesos del inicio.
 *
 * Se quitaron la tarjeta de «Cuentas disponibles» y las notas de pie (fecha de
 * negocio, zona horaria): eran ruido al lado de lo único que se viene a hacer.
 */
export function QuickEntryPage() {
  const [params] = useSearchParams();

  const pedido = params.get('kind') as EntryKind | null;
  const kind: EntryKind = pedido && KINDS.includes(pedido) ? pedido : 'EXPENSE';
  const entityId = params.get('entityId') ?? '';

  return (
    <div className="mx-auto w-full max-w-md space-y-3">
      <div className="flex items-center gap-2">
        <Link
          to="/"
          aria-label="Volver al inicio"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink"
        >
          <IconChevronLeft size={20} />
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-base font-bold tracking-tight text-ink">{TITULO_MOVIMIENTO[kind]}</h1>
          <p className="truncate text-xs text-muted">Importe, descripción y cuenta. Nada más hace falta.</p>
        </div>
      </div>

      <MovimientoForm kind={kind} initialEntityId={entityId} />
    </div>
  );
}
