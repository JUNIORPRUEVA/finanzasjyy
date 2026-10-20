import { useSearchParams } from 'react-router-dom';
import { KIND_TABS, MovimientoForm, type EntryKind } from '../components/MovimientoForm';

/**
 * PANTALLA «REGISTRAR»
 * --------------------
 * El formulario de verdad vive en `components/MovimientoForm.tsx`, porque es el
 * mismo que abre el botón «+» dentro de su panel: una sola versión, un solo
 * comportamiento. Aquí sólo se resuelve el enlace directo
 * (`/registrar?kind=EXPENSE&entityId=…`), que es el que usan los accesos del
 * inicio y los marcadores del navegador.
 *
 * Se quitaron de esta pantalla la tarjeta de «Cuentas disponibles» y las notas
 * de pie (fecha de negocio, zona horaria): eran ruido al lado de lo único que se
 * viene a hacer aquí, que es apuntar un movimiento.
 */
export function QuickEntryPage() {
  const [params] = useSearchParams();

  const pedido = params.get('kind') as EntryKind | null;
  const initialKind: EntryKind = KIND_TABS.some((tab) => tab.id === pedido) ? (pedido as EntryKind) : 'EXPENSE';
  const entityId = params.get('entityId') ?? '';

  return (
    <div className="mx-auto w-full max-w-md space-y-3">
      <div>
        <h1 className="text-lg font-bold tracking-tight text-ink">Registrar</h1>
        <p className="text-xs text-muted">Importe, descripción y cuenta. Nada más hace falta.</p>
      </div>
      <MovimientoForm
        initialKind={initialKind}
        initialEntityId={entityId}
        kinds={KIND_TABS.map((tab) => tab.id)}
      />
    </div>
  );
}
