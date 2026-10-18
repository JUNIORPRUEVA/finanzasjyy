import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, DateRangeFilter, EmptyState, ListScreen, Notice, Skeleton } from '../components/ui';
import { formatDateTime, todayBusinessDate } from '../lib/format';

/**
 * AUDITORÍA
 * =========
 * Quién hizo qué y cuándo, con datos reales del registro de auditoría del
 * servidor. Sirve para lo que de verdad importa en un sistema con dinero:
 * poder reconstruir un cambio («¿quién anuló este cobro y por qué?») sin
 * depender de la memoria de nadie.
 *
 * Sólo la ven propietarios y administradores: es información sensible, y el
 * servidor lo comprueba por su cuenta (no confía en que la interfaz la oculte).
 */

interface AuditRow {
  id: string;
  userId: string | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string | null;
  ip: string | null;
  createdAt: string;
  beforeJson?: unknown;
  afterJson?: unknown;
}

interface AuditResponse {
  data: AuditRow[];
  meta: { page: number; limit: number; total: number; totalPages: number; hasNext: boolean };
}

/**
 * Traducción de los identificadores técnicos a algo legible.
 * Se traduce por PREFIJO, así que una acción nueva («shopping.list.created») se
 * lee bien sin tocar la lista.
 */
const ACTION_LABELS: Array<[RegExp, string]> = [
  [/^auth\.login/, 'Inicio de sesión'],
  [/^auth\.logout/, 'Cierre de sesión'],
  [/^auth\.refresh/, 'Sesión renovada'],
  [/^auth\.password/, 'Cambio de contraseña'],
  [/^auth\.session/, 'Sesión (dispositivo)'],
  [/^shopping\.list\.created/, 'Lista de compras creada'],
  [/^shopping\.list\.updated/, 'Lista de compras modificada'],
  [/^shopping\.list\.deleted/, 'Lista de compras borrada'],
  [/^shopping\.list\.duplicated/, 'Lista de compras duplicada'],
  [/^shopping\.list\.expense_registered/, 'Gasto registrado desde una lista'],
  [/^shopping\.item/, 'Producto de una lista'],
  [/^transaction\./, 'Movimiento'],
  [/^transfer\./, 'Traspaso'],
  [/^closing\./, 'Cierre del día'],
  [/^loan\./, 'Préstamo'],
  [/^budget\./, 'Presupuesto'],
  [/^account\./, 'Cuenta'],
  [/^category\./, 'Categoría'],
  [/^entity\./, 'Unidad financiera'],
  [/^user\./, 'Usuario'],
  [/^sync\./, 'Sincronización'],
];

function humanAction(action: string): string {
  const match = ACTION_LABELS.find(([pattern]) => pattern.test(action));
  if (!match) {
    return action;
  }
  // El matiz final (created/updated/voided…) se añade en español.
  const suffix = action.split('.').pop() ?? '';
  const SUFFIX: Record<string, string> = {
    created: ' · creado',
    updated: ' · modificado',
    deleted: ' · borrado',
    voided: ' · anulado',
    added: ' · añadido',
    expense_registered: '',
    reset_local: ' (desde el servidor)',
    idle_timeout: ' · cerrada por inactividad',
    max_lifetime: ' · duración máxima alcanzada',
    reuse_detected: ' · token reutilizado',
    revoked: ' · revocada',
  };
  return `${match[1]}${SUFFIX[suffix] ?? ''}`;
}

function detailOf(row: AuditRow): string | null {
  const source = (row.afterJson ?? row.beforeJson) as Record<string, unknown> | null | undefined;
  if (!source || typeof source !== 'object') {
    return null;
  }
  const parts: string[] = [];
  for (const key of ['name', 'amount', 'status', 'items', 'transactionId', 'listId', 'reason', 'sessionsRevoked']) {
    const value = source[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    parts.push(`${key}: ${String(value).slice(0, 60)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function AuditPage() {
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const query = useQuery<AuditResponse>({
    queryKey: ['audit', page, from, to],
    queryFn: () =>
      api.get<AuditResponse>(
        `/audit?page=${page}&limit=40${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`,
      ),
  });

  if (query.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <Notice tone="warning" title="No se pudo cargar la auditoría">
        Hace falta conexión con el servidor. La auditoría vive en la base de datos, no en el teléfono, precisamente para
        que no se pueda alterar desde el dispositivo.
      </Notice>
    );
  }

  const rows = query.data.data ?? [];

  return (
    <ListScreen
      toolbar={
        <>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight text-ink">Auditoría</h1>
              <p className="text-xs text-muted">{query.data.meta.total} registro(s)</p>
            </div>
            <DateRangeFilter
              value={{ from, to }}
              onChange={(rango) => {
                setFrom(rango.from);
                setTo(rango.to);
                setPage(1);
              }}
              today={todayBusinessDate()}
            />
          </div>
          <p className="text-xs leading-snug text-muted">
            Todo lo que cambia algo importante queda registrado: quién, qué, cuándo y desde qué dispositivo.
          </p>
        </>
      }
      footer={
        rows.length > 0 ? (
          <div className="flex items-center justify-between gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
              Anterior
            </Button>
            <span className="text-xs text-faint">
              {query.data.meta.page} / {Math.max(1, query.data.meta.totalPages)}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={!query.data.meta.hasNext}
              onClick={() => setPage((current) => current + 1)}
            >
              Siguiente
            </Button>
          </div>
        ) : null
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          title="No hay registros con ese filtro"
          hint="Pruebe a ampliar el rango de fechas o a quitarlo."
        />
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.id} className="rounded-xl border border-border-soft bg-surface p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 flex-1 text-sm font-medium text-ink">{humanAction(row.action)}</p>
                <span className="shrink-0 text-[0.68rem] text-faint">{formatDateTime(row.createdAt)}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {row.entityType}
                {row.actorType === 'SYSTEM' ? ' · por el sistema' : ''}
                {row.ip ? ` · desde ${row.ip}` : ''}
              </p>
              {detailOf(row) ? <p className="mt-1 break-words text-[0.7rem] text-faint">{detailOf(row)}</p> : null}
            </div>
          ))}
        </div>
      )}

      <p className="text-[0.7rem] leading-snug text-faint">
        Los registros no se pueden editar ni borrar. Si ve algo que no reconoce, cambie su contraseña y cierre las
        demás sesiones desde Ajustes → Seguridad: quedará registrado aquí, que es justo lo que se busca.
      </p>
    </ListScreen>
  );
}
