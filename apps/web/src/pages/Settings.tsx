import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../store/auth';
import { Badge, Button, Card, Field, Notice, SectionTitle, Select, Spinner, Tabs } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { deviceThemePreference, setThemePreference, type ThemePreference } from '../lib/theme';

interface Preferences {
  timezone: string;
  currency: string;
  theme: string;
  closingReminderHour: number;
  closingReminderMinute: number;
  offlineWindowHours: number;
  budgetWarnPct: number;
  budgetAlertPct: number;
  pushEnabled: boolean;
  dailyBriefEnabled: boolean;
  reminderOffsetsJson: number[];
}

interface SessionRow {
  id: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  isActive: boolean;
}

interface PushStatus {
  pushEnabledOnServer: boolean;
  publicKey: string | null;
  count: number;
  activeCount: number;
  subscriptions: Array<{ id: string; platform: string | null; isActive: boolean; failCount: number; lastSentAt: string | null }>;
}

type TabId = 'preferencias' | 'apariencia' | 'seguridad' | 'notificaciones';

/**
 * Opciones de apariencia, con su explicación en lenguaje llano. Se aplican al
 * instante (no hay que pulsar «Guardar»): quien elige un tema quiere verlo ya.
 */
const THEME_OPTIONS: Array<{ id: ThemePreference; label: string; hint: string; swatch: string[] }> = [
  {
    id: 'light',
    label: 'Claro',
    hint: 'Fondo claro. Se lee mejor con mucha luz, en la calle o junto a una ventana.',
    swatch: ['#f4f6fb', '#ffffff', '#0b3b2a'],
  },
  {
    id: 'dark',
    label: 'Oscuro',
    hint: 'Fondo oscuro. Más cómodo de noche y gasta menos batería en pantallas OLED.',
    swatch: ['#0a0f1c', '#131a2b', '#3ddc97'],
  },
  {
    id: 'system',
    label: 'Como el sistema',
    hint: 'FINANZA cambia sola cuando el teléfono cambia de modo claro a oscuro (o al revés).',
    swatch: ['#0a0f1c', '#f4f6fb', '#3ddc97'],
  },
];

/**
 * AJUSTES
 * -------
 * Todo lo configurable sin tocar código: zona horaria, moneda, hora del cierre,
 * recordatorios, umbrales de presupuesto, ventana sin conexión, notificaciones
 * y seguridad de la cuenta.
 */
export function SettingsPage() {
  const { user, preferences: sessionPreferences, entities, logout, reload } = useAuth();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const queryClient = useQueryClient();
  const initialTab = (params.get('tab') as TabId | null) ?? 'preferencias';
  const [tab, setTab] = useState<TabId>(initialTab);
  const [message, setMessage] = useState<{ tone: 'positive' | 'warning' | 'negative'; text: string } | null>(null);

  const [form, setForm] = useState<Preferences | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const preferencesQuery = useQuery<Preferences>({
    queryKey: ['preferences'],
    queryFn: () => api.get<Preferences>('/auth/preferences'),
  });

  const sessionsQuery = useQuery<SessionRow[]>({
    queryKey: ['sessions'],
    queryFn: () => api.get<SessionRow[]>('/auth/sessions'),
  });

  const pushQuery = useQuery<PushStatus>({
    queryKey: ['push-status'],
    queryFn: () => api.get<PushStatus>('/notifications/push/status'),
  });

  useEffect(() => {
    if (preferencesQuery.data) {
      setForm(preferencesQuery.data);
    }
  }, [preferencesQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (values: Preferences) =>
      api.patch('/auth/preferences', {
        timezone: values.timezone,
        currency: values.currency,
        theme: values.theme,
        closingReminderHour: values.closingReminderHour,
        closingReminderMinute: values.closingReminderMinute,
        offlineWindowHours: values.offlineWindowHours,
        budgetWarnPct: values.budgetWarnPct,
        budgetAlertPct: values.budgetAlertPct,
        pushEnabled: values.pushEnabled,
        dailyBriefEnabled: values.dailyBriefEnabled,
        reminderOffsetsMinutes: values.reminderOffsetsJson,
      }),
    onSuccess: async () => {
      setMessage({ tone: 'positive', text: 'Preferencias guardadas.' });
      await reload();
      void queryClient.invalidateQueries({ queryKey: ['preferences'] });
    },
    onError: (error) => {
      setMessage({
        tone: 'negative',
        text: error instanceof ApiError ? error.message : 'No se pudieron guardar las preferencias.',
      });
    },
  });

  const passwordMutation = useMutation({
    mutationFn: () =>
      api.post('/auth/change-password', {
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      }),
    onSuccess: () => {
      setMessage({
        tone: 'positive',
        text: 'Contraseña cambiada. Se cerraron las demás sesiones por seguridad.',
      });
      setCurrentPassword('');
      setNewPassword('');
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (error) => {
      setMessage({
        tone: 'negative',
        text: error instanceof ApiError ? error.message : 'No se pudo cambiar la contraseña.',
      });
    },
  });

  const revokeSessionMutation = useMutation({
    mutationFn: (sessionId: string) => api.delete(`/auth/sessions/${sessionId}`),
    onSuccess: () => {
      setMessage({ tone: 'positive', text: 'Sesión cerrada en ese dispositivo.' });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });

  const subscribePushMutation = useMutation({
    mutationFn: async () => {
      if (!('serviceWorker' in navigator)) {
        throw new Error('Este navegador no soporta notificaciones push.');
      }
      const registration = await navigator.serviceWorker.ready;
      const publicKey = pushQuery.data?.publicKey;
      if (!publicKey) {
        throw new Error(
          'El servidor no tiene configuradas las claves VAPID: las notificaciones push están desactivadas. Las alertas seguirán apareciendo dentro de la aplicación.',
        );
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        throw new Error('No se concedió el permiso de notificaciones en este dispositivo.');
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const json = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      return api.post('/notifications/push/subscribe', {
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        deviceId: localStorage.getItem('finanza.deviceId') ?? undefined,
        platform: navigator.platform,
      });
    },
    onSuccess: () => {
      setMessage({
        tone: 'positive',
        text: 'Dispositivo suscrito. En iPhone, las notificaciones web sólo funcionan si FINANZA está instalada en la pantalla de inicio (iOS 16.4 o superior).',
      });
      void queryClient.invalidateQueries({ queryKey: ['push-status'] });
    },
    onError: (error) => {
      setMessage({ tone: 'warning', text: error instanceof Error ? error.message : 'No se pudo suscribir el dispositivo.' });
    },
  });

  const testPushMutation = useMutation({
    mutationFn: () => api.post<{ message: string }>('/notifications/push/test'),
    onSuccess: (result) => setMessage({ tone: 'positive', text: result.message }),
  });

  if (!form || preferencesQuery.isLoading) {
    return <Spinner label="Cargando ajustes…" />;
  }

  return (
    <div className="space-y-4">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <Tabs
        tabs={[
          { id: 'preferencias' as TabId, label: 'Preferencias' },
          { id: 'apariencia' as TabId, label: 'Apariencia' },
          { id: 'notificaciones' as TabId, label: 'Notificaciones' },
          { id: 'seguridad' as TabId, label: 'Seguridad' },
        ]}
        active={tab}
        onChange={(next) => {
          setTab(next);
          setParams({ tab: next });
        }}
      />

      {tab === 'preferencias' ? (
        <>
          <Card className="space-y-3">
            <SectionTitle title="Perfil" />
            <p className="text-sm text-ink">
              {user?.name} · {user?.email}
            </p>
            <p className="text-xs text-faint">Rol: {user?.role}</p>
            <div>
              <p className="mb-1 text-xs uppercase text-muted">Unidades financieras</p>
              <div className="flex flex-wrap gap-2">
                {entities.map((entity) => (
                  <Badge key={entity.id} tone="neutral">
                    {entity.name}
                  </Badge>
                ))}
              </div>
            </div>
          </Card>

          <Card className="space-y-3">
            <SectionTitle title="Cómo se comporta FINANZA" />
            <Select
              label="Zona horaria de negocio"
              value={form.timezone}
              onChange={(value) => setForm({ ...form, timezone: value })}
              options={[
                { value: 'America/Santo_Domingo', label: 'America/Santo_Domingo' },
                { value: 'America/New_York', label: 'America/New_York' },
                { value: 'America/Mexico_City', label: 'America/Mexico_City' },
                { value: 'Europe/Madrid', label: 'Europe/Madrid' },
                { value: 'UTC', label: 'UTC' },
              ]}
            />

            <Select
              label="Moneda principal"
              value={form.currency}
              onChange={(value) => setForm({ ...form, currency: value })}
              options={[
                { value: 'DOP', label: 'Peso dominicano (DOP)' },
                { value: 'USD', label: 'Dólar (USD)' },
                { value: 'EUR', label: 'Euro (EUR)' },
              ]}
            />

            <Field
              label="Hora del recordatorio de cierre (0-23)"
              value={String(form.closingReminderHour)}
              onChange={(value) => setForm({ ...form, closingReminderHour: Number(value) || 0 })}
              type="number"
              hint="Los avisos escalonados se envían a esa hora, +1 h y +3 h si el cierre sigue pendiente."
            />

            <Field
              label="Minuto del recordatorio (0-59)"
              value={String(form.closingReminderMinute)}
              onChange={(value) => setForm({ ...form, closingReminderMinute: Number(value) || 0 })}
              type="number"
            />

            <Field
              label="Horas que puede trabajar sin conexión (1-168)"
              value={String(form.offlineWindowHours)}
              onChange={(value) => setForm({ ...form, offlineWindowHours: Number(value) || 24 })}
              type="number"
              hint="Tras este tiempo sin conexión, la app bloquea nuevos registros hasta que vuelva a validar la sesión."
            />

            <Field
              label="Aviso de presupuesto al (%)"
              value={String(form.budgetWarnPct)}
              onChange={(value) => setForm({ ...form, budgetWarnPct: Number(value) || 80 })}
              type="number"
            />

            <Field
              label="Alerta de presupuesto al (%)"
              value={String(form.budgetAlertPct)}
              onChange={(value) => setForm({ ...form, budgetAlertPct: Number(value) || 100 })}
              type="number"
            />

            <Button disabled={saveMutation.isPending} onClick={() => saveMutation.mutate(form)}>
              {saveMutation.isPending ? 'Guardando…' : 'Guardar preferencias'}
            </Button>
          </Card>
        </>
      ) : null}

      {tab === 'apariencia' ? (
        <>
          <Card className="space-y-3">
            <SectionTitle title="Tema" hint="Se aplica al instante, sin recargar la pantalla" />
            <div className="space-y-2">
              {THEME_OPTIONS.map((option) => {
                const isActive = form.theme === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => {
                      setForm({ ...form, theme: option.id });
                      setThemePreference(option.id);
                      saveMutation.mutate({ ...form, theme: option.id });
                    }}
                    className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition ${
                      isActive ? 'border-brand bg-brand-soft' : 'border-border-soft bg-surface hover:bg-surface-2'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="mt-0.5 flex h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-border-soft"
                    >
                      {option.swatch.map((color, index) => (
                        <span key={color + index} className="h-full flex-1" style={{ backgroundColor: color }} />
                      ))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-ink">{option.label}</span>
                        {isActive ? <Badge tone="positive">En uso</Badge> : null}
                      </span>
                      <span className="mt-0.5 block text-xs leading-snug text-muted">{option.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="text-[0.7rem] leading-snug text-faint">
              Su elección se guarda en la cuenta (viaja con usted a otros dispositivos que todavía no hayan elegido) y
              también en este teléfono, para que la aplicación abra directamente con el tema elegido y sin destellos
              blancos.
            </p>
            {deviceThemePreference() !== form.theme ? (
              <Notice tone="warning">
                <p>
                  Este teléfono tiene guardado un tema distinto al de su cuenta. Se seguirá usando el de este teléfono,
                  que es el que usted eligió aquí.
                </p>
                <button
                  type="button"
                  className="mt-2 text-xs font-semibold text-brand underline"
                  onClick={() => {
                    setThemePreference(form.theme as ThemePreference);
                    saveMutation.mutate(form);
                  }}
                >
                  Usar el de mi cuenta
                </button>
              </Notice>
            ) : null}
          </Card>

          <Card className="space-y-2">
            <SectionTitle title="Qué cambia y qué no" />
            <ul className="space-y-1.5 text-xs leading-snug text-muted">
              <li>
                · Cambia el <strong>fondo, el texto y los bordes</strong>. La <strong>paleta de FINANZA no cambia</strong>:
                verde para lo bueno, rojo para lo malo, igual en los dos temas.
              </li>
              <li>
                · Los <strong>colores de las gráficas</strong> se ajustan para que sigan siendo legibles sobre fondo
                oscuro o claro.
              </li>
              <li>· No cambia ningún dato ni ninguna cifra: es sólo cómo se ve.</li>
            </ul>
          </Card>
        </>
      ) : null}

      {tab === 'notificaciones' ? (
        <Card className="space-y-3">
          <SectionTitle
            title="Notificaciones"
            hint="Los avisos críticos los genera el servidor: no dependen de que el navegador esté abierto"
          />

          <Notice tone={pushQuery.data?.pushEnabledOnServer ? 'positive' : 'warning'}>
            {pushQuery.data?.pushEnabledOnServer
              ? `El servidor puede enviar notificaciones push. Este dispositivo tiene ${pushQuery.data.activeCount} suscripción(es) activa(s).`
              : 'Faltan las claves VAPID en el servidor: las notificaciones push están DESACTIVADAS. Las alertas siguen apareciendo dentro de la aplicación, en «Más → Tareas».'}
          </Notice>

          <div className="flex flex-wrap gap-2">
            <Button disabled={subscribePushMutation.isPending} onClick={() => subscribePushMutation.mutate()}>
              {subscribePushMutation.isPending ? 'Suscribiendo…' : 'Activar en este dispositivo'}
            </Button>
            <Button variant="secondary" disabled={testPushMutation.isPending} onClick={() => testPushMutation.mutate()}>
              Enviar notificación de prueba
            </Button>
          </div>

          {pushQuery.data && pushQuery.data.subscriptions.length > 0 ? (
            <div className="space-y-1">
              {pushQuery.data.subscriptions.map((subscription) => (
                <div key={subscription.id} className="flex items-center justify-between text-xs text-muted">
                  <span>{subscription.platform ?? 'dispositivo'}</span>
                  <span className="flex items-center gap-2">
                    {subscription.isActive ? <Badge tone="positive">activa</Badge> : <Badge tone="neutral">inactiva</Badge>}
                    {subscription.failCount > 0 ? <Badge tone="warning">{subscription.failCount} fallo(s)</Badge> : null}
                    <span>{subscription.lastSentAt ? formatDateTime(subscription.lastSentAt) : 'nunca'}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          <p className="text-xs text-faint">
            En iPhone, las notificaciones web requieren iOS 16.4 o superior <strong>y</strong> tener FINANZA instalada
            en la pantalla de inicio. Si no se cumple, la app avisa igualmente dentro de su pantalla de tareas.
          </p>
        </Card>
      ) : null}

      {tab === 'seguridad' ? (
        <>
          <Card className="space-y-3">
            <SectionTitle title="Cambiar contraseña" hint="Se cerrarán las demás sesiones" />
            <Field label="Contraseña actual" value={currentPassword} onChange={setCurrentPassword} type="password" />
            <Field
              label="Contraseña nueva"
              value={newPassword}
              onChange={setNewPassword}
              type="password"
              hint="Mínimo 10 caracteres, con letras y números."
            />
            <Button
              disabled={currentPassword.length < 8 || newPassword.length < 10 || passwordMutation.isPending}
              onClick={() => passwordMutation.mutate()}
            >
              {passwordMutation.isPending ? 'Cambiando…' : 'Cambiar contraseña'}
            </Button>
          </Card>

          <Card>
            <SectionTitle title="Sesiones y dispositivos" hint="Puede cerrar el acceso de cualquier dispositivo" />
            {sessionsQuery.isLoading ? <Spinner /> : null}
            <div className="space-y-2">
              {sessionsQuery.data?.map((session) => (
                <div key={session.id} className="flex items-start justify-between gap-2 rounded-lg border border-border-soft p-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{session.deviceId ?? 'Sesión sin dispositivo'}</p>
                    <p className="truncate text-xs text-faint">
                      Último uso: {session.lastUsedAt ? formatDateTime(session.lastUsedAt) : '—'} · IP {session.ip ?? '—'}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    {session.isActive ? <Badge tone="positive">activa</Badge> : <Badge tone="neutral">cerrada</Badge>}
                    {session.isActive ? (
                      <button
                        type="button"
                        onClick={() => revokeSessionMutation.mutate(session.id)}
                        className="ml-2 text-xs text-negative underline"
                      >
                        Cerrar
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <SectionTitle title="Sesión actual" />
            <Button
              variant="danger"
              onClick={async () => {
                await logout();
                window.location.href = `${location.pathname}`;
              }}
            >
              Cerrar sesión en este dispositivo
            </Button>
            <p className="mt-2 text-xs text-faint">
              Los movimientos registrados sin conexión que aún no se han confirmado permanecen guardados en este
              dispositivo hasta que vuelva a entrar.
            </p>
          </Card>
        </>
      ) : null}

      {sessionPreferences ? (
        <p className="pb-4 text-center text-xs text-faint">
          Ventana sin conexión configurada: {sessionPreferences.offlineWindowHours} h
        </p>
      ) : null}
    </div>
  );
}

/** Convierte la clave pública VAPID (base64url) al formato que espera el navegador. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  // El buffer se crea explícitamente como ArrayBuffer: `pushManager.subscribe`
  // exige un BufferSource y no acepta un ArrayBufferLike compartido.
  const output = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let index = 0; index < rawData.length; index += 1) {
    output[index] = rawData.charCodeAt(index);
  }
  return output;
}
