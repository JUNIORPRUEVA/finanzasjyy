import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Notice,
  PasswordField,
  SectionTitle,
  SegmentedControl,
  Select,
  Sheet,
  Spinner,
} from '../components/ui';
import { IconBell, IconCalendar, IconPlus, IconShare } from '../components/icons';
import { toast } from '../components/Toast';

/**
 * RECORDATORIOS Y NOTAS
 * ---------------------
 * Una nota suelta o una lista de puntos, con la posibilidad de que la app avise
 * a la hora elegida: una sola vez, todos los días o cada mes. Lo que se guarda
 * aquí se queda, y además se puede llevar al calendario del teléfono (Google
 * Calendar) con un enlace de suscripción que incluye también los compromisos
 * mensuales.
 *
 * Borrar pide la contraseña de quien creó el recordatorio: es la condición para
 * que un aviso importante no desaparezca por un toque de más.
 */

type Repeat = 'ONCE' | 'DAILY' | 'MONTHLY';
type Filter = 'todos' | 'avisos' | 'listas' | 'notas';

const REPEAT_OPTIONS: Array<{ value: Repeat; label: string }> = [
  { value: 'ONCE', label: 'Una sola vez' },
  { value: 'DAILY', label: 'Todos los días' },
  { value: 'MONTHLY', label: 'Cada mes' },
];

const REPEAT_LABEL: Record<Repeat, string> = {
  ONCE: 'Una vez',
  DAILY: 'Todos los días',
  MONTHLY: 'Cada mes',
};

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'todos', label: 'Todo' },
  { value: 'avisos', label: 'Con aviso' },
  { value: 'listas', label: 'Listas' },
  { value: 'notas', label: 'Notas' },
];

interface ReminderItem {
  id: string;
  text: string;
}

interface ReminderRow {
  id: string;
  title: string;
  isList: boolean;
  notes: string | null;
  items: ReminderItem[];
  alertEnabled: boolean;
  alertAt: string | null;
  repeat: Repeat;
  timezone: string;
  entity: { id: string; name: string; code: string } | null;
  creator: { id: string; name: string } | null;
  canDelete: boolean;
  dueNow: boolean;
  nextAlertAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CalendarLink {
  url: string;
  webcalUrl: string;
  googleUrl: string;
  instructions: string[];
}

interface FormState {
  id: string | null;
  title: string;
  isList: boolean;
  notes: string;
  items: string[];
  alertEnabled: boolean;
  alertAtLocal: string;
  repeat: Repeat;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Fecha y hora local en el formato que espera `<input type="datetime-local">`. */
function toLocalInput(iso: string | null): string {
  const date = iso ? new Date(iso) : defaultAlertDate();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Sugerencia al crear: dentro de una hora, en punto. */
function defaultAlertDate(): Date {
  const date = new Date();
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return date;
}

function emptyForm(): FormState {
  return {
    id: null,
    title: '',
    isList: false,
    notes: '',
    items: [''],
    alertEnabled: false,
    alertAtLocal: toLocalInput(null),
    repeat: 'ONCE',
  };
}

function formFrom(row: ReminderRow): FormState {
  return {
    id: row.id,
    title: row.title,
    isList: row.isList,
    notes: row.notes ?? '',
    items: row.isList ? (row.items.length > 0 ? row.items.map((item) => item.text) : ['']) : [''],
    alertEnabled: row.alertEnabled,
    alertAtLocal: toLocalInput(row.alertAt),
    repeat: row.repeat,
  };
}

/** Enlace de Google Calendar para añadir ESTE recordatorio con un toque. */
function googleCalendarUrl(row: ReminderRow): string | null {
  if (!row.alertAt) {
    return null;
  }
  const start = new Date(row.alertAt);
  const end = new Date(start.getTime() + 30 * 60_000);
  const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const details = row.isList
    ? row.items.map((item, index) => `${index + 1}. ${item.text}`).join('\n')
    : (row.notes ?? '');

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: row.title,
    dates: `${stamp(start)}/${stamp(end)}`,
    details,
  });

  if (row.repeat === 'DAILY') {
    params.set('recur', 'RRULE:FREQ=DAILY');
  } else if (row.repeat === 'MONTHLY') {
    params.set('recur', `RRULE:FREQ=MONTHLY;BYMONTHDAY=${start.getUTCDate()}`);
  }

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function RemindersPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('todos');
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ReminderRow | null>(null);
  const [password, setPassword] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showCalendar, setShowCalendar] = useState(false);

  const remindersQuery = useQuery<ReminderRow[]>({
    queryKey: ['reminders'],
    queryFn: () => api.get<ReminderRow[]>('/reminders'),
  });

  const calendarQuery = useQuery<CalendarLink>({
    queryKey: ['reminders-calendar'],
    queryFn: () => api.get<CalendarLink>('/reminders/calendar-link'),
    enabled: showCalendar,
    staleTime: 5 * 60_000,
  });

  const rows = useMemo(() => remindersQuery.data ?? [], [remindersQuery.data]);
  const visible = useMemo(() => {
    switch (filter) {
      case 'avisos':
        return rows.filter((row) => row.alertEnabled);
      case 'listas':
        return rows.filter((row) => row.isList);
      case 'notas':
        return rows.filter((row) => !row.isList);
      default:
        return rows;
    }
  }, [rows, filter]);

  const withAlert = rows.filter((row) => row.alertEnabled).length;

  const save = useMutation({
    mutationFn: (state: FormState) => {
      const items = state.isList
        ? state.items.map((text) => ({ text: text.trim() })).filter((item) => item.text.length > 0)
        : undefined;

      const payload = {
        title: state.title.trim(),
        isList: state.isList,
        notes: state.isList ? undefined : state.notes.trim(),
        items,
        alertEnabled: state.alertEnabled,
        alertAt: state.alertEnabled ? new Date(state.alertAtLocal).toISOString() : undefined,
        repeat: state.alertEnabled ? state.repeat : ('ONCE' as Repeat),
      };

      return state.id
        ? api.patch<ReminderRow>(`/reminders/${state.id}`, payload)
        : api.post<ReminderRow>('/reminders', payload);
    },
    onSuccess: (saved) => {
      setForm(null);
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['reminders'] });
      toast.success(saved.alertEnabled ? `Guardado. Le avisaremos: ${saved.title}` : `Guardado: ${saved.title}`);
    },
    onError: (error) => {
      setFormError(error instanceof ApiError ? error.message : 'No se pudo guardar el recordatorio.');
    },
  });

  const remove = useMutation({
    mutationFn: ({ id, secret }: { id: string; secret: string }) =>
      api.delete<{ id: string; deleted: boolean }>(`/reminders/${id}`, { password: secret }),
    onSuccess: () => {
      setDeleting(null);
      setPassword('');
      setDeleteError(null);
      void queryClient.invalidateQueries({ queryKey: ['reminders'] });
      toast.success('Recordatorio borrado.');
    },
    onError: (error) => {
      setDeleteError(error instanceof ApiError ? error.message : 'No se pudo borrar el recordatorio.');
    },
  });

  const rotate = useMutation({
    mutationFn: () => api.post<CalendarLink>('/reminders/calendar-link/rotate'),
    onSuccess: (link) => {
      queryClient.setQueryData(['reminders-calendar'], link);
      toast.success('Enlace nuevo creado. El anterior ya no funciona.');
    },
    onError: () => toast.error('No se pudo cambiar el enlace.'),
  });

  const copyLink = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Enlace copiado. Péguelo en «Suscribirse a un calendario».');
    } catch {
      toast.error('No se pudo copiar. Mantenga pulsado el enlace para copiarlo a mano.');
    }
  };

  const abrirNuevo = () => {
    setFormError(null);
    setForm(emptyForm());
  };

  return (
    <div className="space-y-4 pb-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-ink">Recordatorios y notas</h1>
          <p className="mt-0.5 text-xs leading-snug text-muted">
            Lo que no se puede olvidar: apúntelo aquí y, si quiere, la app le avisa y lo lleva a su calendario.
          </p>
        </div>
        <Button onClick={abrirNuevo} className="shrink-0">
          <IconPlus size={18} />
          Nuevo
        </Button>
      </div>

      {/* Resumen: qué hay y cuántos avisos activos. */}
      {rows.length > 0 ? (
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl border border-border-soft bg-surface p-3">
            <p className="text-[0.7rem] uppercase tracking-wide text-faint">Notas</p>
            <p className="text-lg font-semibold text-ink">{rows.length}</p>
          </div>
          <div className="rounded-xl border border-border-soft bg-surface p-3">
            <p className="text-[0.7rem] uppercase tracking-wide text-faint">Listas</p>
            <p className="text-lg font-semibold text-ink">{rows.filter((row) => row.isList).length}</p>
          </div>
          <div className="rounded-xl border border-border-soft bg-surface p-3">
            <p className="text-[0.7rem] uppercase tracking-wide text-faint">Con aviso</p>
            <p className="text-lg font-semibold text-brand">{withAlert}</p>
          </div>
        </div>
      ) : null}

      <SegmentedControl options={FILTERS} value={filter} onChange={setFilter} />

      {remindersQuery.isLoading ? <Spinner /> : null}

      {remindersQuery.isError && !remindersQuery.data ? (
        <EmptyState
          title="No se pudieron consultar sus recordatorios"
          hint="Hace falta conexión. Vuelva a intentarlo."
          action={
            <Button variant="secondary" onClick={() => void remindersQuery.refetch()}>
              Reintentar
            </Button>
          }
        />
      ) : null}

      {!remindersQuery.isLoading && !remindersQuery.isError && visible.length === 0 ? (
        <EmptyState
          title={rows.length === 0 ? 'Todavía no hay nada anotado' : 'Nada en este filtro'}
          hint={
            rows.length === 0
              ? 'Cree una nota, una lista de pendientes o un aviso que se repita cada mes.'
              : 'Cambie el filtro para ver el resto.'
          }
          action={rows.length === 0 ? <Button onClick={abrirNuevo}>Crear el primero</Button> : undefined}
        />
      ) : null}

      <div className="space-y-3">
        {visible.map((row) => {
          const google = googleCalendarUrl(row);
          return (
            <Card key={row.id} className={row.dueNow ? 'border-brand/50' : undefined}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">{row.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {row.isList ? <Badge tone="neutral">Lista · {row.items.length}</Badge> : <Badge tone="neutral">Nota</Badge>}
                    {row.alertEnabled ? (
                      <Badge tone={row.dueNow ? 'positive' : 'info'}>
                        {REPEAT_LABEL[row.repeat]}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">Sin aviso</Badge>
                    )}
                    {row.entity ? <Badge tone="neutral">{row.entity.name}</Badge> : null}
                    {row.dueNow ? <Badge tone="positive">Le toca hoy</Badge> : null}
                  </div>
                </div>
                <span className="shrink-0 text-faint" aria-hidden="true">
                  <IconBell size={18} />
                </span>
              </div>

              {row.isList ? (
                <ol className="mt-2 space-y-1 pl-5 text-sm text-ink marker:text-faint list-decimal">
                  {row.items.slice(0, 6).map((item) => (
                    <li key={item.id}>{item.text}</li>
                  ))}
                  {row.items.length > 6 ? (
                    <li className="text-xs text-faint">y {row.items.length - 6} más…</li>
                  ) : null}
                </ol>
              ) : row.notes ? (
                <p className="mt-2 whitespace-pre-line text-sm leading-snug text-muted">{row.notes}</p>
              ) : null}

              {row.alertEnabled && row.alertAt ? (
                <p className="mt-2 text-xs text-muted">
                  Aviso: <strong className="text-ink">{formatDateTime(row.alertAt)}</strong>
                  {row.repeat !== 'ONCE' && row.nextAlertAt
                    ? ` · próxima vez ${formatDateTime(row.nextAlertAt)}`
                    : ''}
                  {row.creator ? ` · creado por ${row.creator.name}` : ''}
                </p>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => { setFormError(null); setForm(formFrom(row)); }}>
                  Editar
                </Button>
                {google ? (
                  <a
                    href={google}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold text-brand transition hover:bg-brand-soft"
                  >
                    <IconCalendar size={15} />
                    Añadir a Google Calendar
                  </a>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setDeleting(row);
                    setPassword('');
                    setDeleteError(null);
                  }}
                  className="ml-auto text-xs text-negative underline"
                >
                  Eliminar
                </button>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Calendario: suscripción que incluye recordatorios y compromisos. */}
      <Card>
        <div className="flex items-start justify-between gap-2">
          <SectionTitle
            title="Su calendario de FINANZA"
            hint="Recordatorios, compromisos mensuales, cuotas y cuentas por pagar, en Google Calendar"
          />
          <Button variant="secondary" size="sm" onClick={() => setShowCalendar((open) => !open)}>
            {showCalendar ? 'Ocultar' : 'Abrir'}
          </Button>
        </div>

        {showCalendar ? (
          <div className="mt-2 space-y-3">
            {calendarQuery.isLoading ? <Spinner /> : null}
            {calendarQuery.data ? (
              <>
                <div className="rounded-xl border border-border-soft bg-surface-2 p-3">
                  <p className="text-xs font-medium text-muted">Enlace para suscribirse</p>
                  <p className="mt-1 break-all font-mono text-[0.7rem] text-ink">{calendarQuery.data.url}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => void copyLink(calendarQuery.data.url)}>
                    <IconShare size={15} />
                    Copiar enlace
                  </Button>
                  <a
                    href={calendarQuery.data.googleUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold text-brand transition hover:bg-brand-soft"
                  >
                    <IconCalendar size={15} />
                    Abrir en Google Calendar
                  </a>
                  <a
                    href={calendarQuery.data.webcalUrl}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold text-brand transition hover:bg-brand-soft"
                  >
                    Añadir a mi calendario
                  </a>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={rotate.isPending}
                    onClick={() => {
                      if (window.confirm('¿Cambiar el enlace? El anterior dejará de funcionar y habrá que volver a suscribirse.')) {
                        rotate.mutate();
                      }
                    }}
                  >
                    Cambiar enlace
                  </Button>
                </div>
                <Notice tone="neutral">
                  <ul className="list-disc space-y-1 pl-4 text-xs leading-snug">
                    {calendarQuery.data.instructions.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </Notice>
              </>
            ) : null}
            {calendarQuery.isError ? (
              <Notice tone="negative">No se pudo obtener el enlace del calendario. Inténtelo de nuevo.</Notice>
            ) : null}
          </div>
        ) : null}
      </Card>

      {/* Alta y edición */}
      <Sheet
        open={form !== null}
        onClose={() => {
          setForm(null);
          setFormError(null);
        }}
        title={form?.id ? 'Editar recordatorio' : 'Nuevo recordatorio'}
      >
        {form ? (
          <form
            className="space-y-3 pb-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (form.title.trim().length < 2) {
                setFormError('Escriba un nombre de al menos 2 letras.');
                return;
              }
              if (form.isList && form.items.every((text) => text.trim().length === 0)) {
                setFormError('Añada al menos un punto a la lista.');
                return;
              }
              if (form.alertEnabled && Number.isNaN(new Date(form.alertAtLocal).getTime())) {
                setFormError('Indique la fecha y la hora del aviso.');
                return;
              }
              if (!save.isPending) {
                save.mutate(form);
              }
            }}
          >
            <Field
              label="Nombre"
              value={form.title}
              onChange={(title) => setForm({ ...form, title })}
              placeholder="Ej.: Pagar el alquiler / Lista del súper / Llamar al contador"
            />

            <div>
              <p className="mb-1 text-sm font-medium text-ink">¿Qué va a anotar?</p>
              <SegmentedControl
                options={[
                  { value: 'nota', label: 'Nota simple' },
                  { value: 'lista', label: 'Lista de puntos' },
                ]}
                value={form.isList ? 'lista' : 'nota'}
                onChange={(value) => setForm({ ...form, isList: value === 'lista' })}
              />
            </div>

            {form.isList ? (
              <div className="space-y-2">
                <p className="text-sm font-medium text-ink">Puntos de la lista</p>
                {form.items.map((item, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <span className="w-5 shrink-0 text-right text-sm text-faint">{index + 1}.</span>
                    <input
                      value={item}
                      onChange={(event) => {
                        const next = [...form.items];
                        next[index] = event.target.value;
                        setForm({ ...form, items: next });
                      }}
                      placeholder={index === 0 ? 'Primer punto' : 'Otro punto'}
                      className="w-full rounded-xl border border-border-soft bg-surface-2 px-3 py-2 text-ink outline-none transition placeholder:text-faint focus:border-brand"
                    />
                    <button
                      type="button"
                      aria-label={`Quitar punto ${index + 1}`}
                      onClick={() =>
                        setForm({
                          ...form,
                          items: form.items.length > 1 ? form.items.filter((_, position) => position !== index) : [''],
                        })
                      }
                      className="shrink-0 rounded-lg px-2 py-1 text-lg leading-none text-faint transition hover:text-negative"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setForm({ ...form, items: [...form.items, ''] })}
                  className="text-xs font-semibold text-brand"
                >
                  + Añadir punto
                </button>
              </div>
            ) : (
              <div>
                <label htmlFor="reminder-notes" className="mb-1 block text-sm font-medium text-ink">
                  Nota (opcional)
                </label>
                <textarea
                  id="reminder-notes"
                  value={form.notes}
                  onChange={(event) => setForm({ ...form, notes: event.target.value })}
                  rows={3}
                  placeholder="El detalle que no quiere olvidar"
                  className="w-full rounded-xl border border-border-soft bg-surface-2 px-3 py-2.5 text-ink outline-none transition placeholder:text-faint focus:border-brand"
                />
              </div>
            )}

            {/* Aviso */}
            <div className="rounded-xl border border-border-soft bg-surface-2/60 p-3">
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-ink">Requiere aviso</span>
                <input
                  type="checkbox"
                  checked={form.alertEnabled}
                  onChange={(event) => setForm({ ...form, alertEnabled: event.target.checked })}
                  className="h-5 w-5 accent-[var(--brand)]"
                />
              </label>

              {form.alertEnabled ? (
                <div className="mt-3 space-y-3">
                  <Field
                    label="Fecha y hora del aviso"
                    type="datetime-local"
                    value={form.alertAtLocal}
                    onChange={(alertAtLocal) => setForm({ ...form, alertAtLocal })}
                    hint="En su hora local. La app avisa a esa hora y el calendario lo recuerda también."
                  />
                  <Select
                    label="¿Se repite?"
                    value={form.repeat}
                    onChange={(repeat) => setForm({ ...form, repeat: repeat as Repeat })}
                    options={REPEAT_OPTIONS}
                  />
                  <p className="text-xs leading-snug text-faint">
                    {form.repeat === 'DAILY'
                      ? 'Le avisará todos los días a esa misma hora.'
                      : form.repeat === 'MONTHLY'
                        ? 'Le avisará cada mes el mismo día. Si el mes es más corto, el último día.'
                        : 'Le avisará una sola vez, en esa fecha y hora.'}
                  </p>
                </div>
              ) : null}
            </div>

            {formError ? <Notice tone="negative">{formError}</Notice> : null}

            <Button type="submit" className="w-full" size="lg" disabled={save.isPending}>
              {save.isPending ? 'Guardando…' : form.id ? 'Guardar cambios' : 'Guardar recordatorio'}
            </Button>
          </form>
        ) : null}
      </Sheet>

      {/* Borrado con la contraseña de quien lo creó */}
      <Sheet
        open={deleting !== null}
        onClose={() => {
          setDeleting(null);
          setPassword('');
          setDeleteError(null);
        }}
        title="Eliminar recordatorio"
      >
        {deleting ? (
          <form
            className="space-y-3 pb-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!password.trim()) {
                setDeleteError('Escriba la contraseña para confirmar el borrado.');
                return;
              }
              if (!remove.isPending) {
                remove.mutate({ id: deleting.id, secret: password });
              }
            }}
          >
            <Notice tone="warning" title={`«${deleting.title}» se borrará para siempre`}>
              Para confirmarlo escriba la contraseña de{' '}
              <strong>{deleting.creator?.name ?? 'quien creó el recordatorio'}</strong>, que es quien lo creó. No se
              puede deshacer.
            </Notice>
            <PasswordField label="Contraseña de quien lo creó" value={password} onChange={setPassword} />
            {deleteError ? <Notice tone="negative">{deleteError}</Notice> : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  setDeleting(null);
                  setPassword('');
                  setDeleteError(null);
                }}
              >
                Cancelar
              </Button>
              <Button type="submit" variant="danger" className="flex-1" disabled={remove.isPending}>
                {remove.isPending ? 'Borrando…' : 'Borrar definitivamente'}
              </Button>
            </div>
          </form>
        ) : null}
      </Sheet>
    </div>
  );
}
