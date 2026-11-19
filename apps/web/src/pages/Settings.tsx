import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlert, IconBuilding, IconCheck, IconChevronRight, IconUsers } from '../components/icons';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../store/auth';
import type { SessionPreferences } from '../store/auth';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Notice,
  PasswordField,
  SectionTitle,
  Select,
  Spinner,
  Tabs,
} from '../components/ui';
import { formatDateTime } from '../lib/format';
import { buscarActualizacion, versionActual } from '../lib/pwa';
import { deviceThemePreference, resolveTheme, setThemePreference, type ThemePreference } from '../lib/theme';

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

type TabId = 'preferencias' | 'apariencia' | 'seguridad' | 'notificaciones' | 'administracion';

/**
 * Opciones de apariencia, con su explicación en lenguaje llano. Se aplican al
 * instante (no hay que pulsar «Guardar»): quien elige un tema quiere verlo ya.
 */
const THEME_OPTIONS: Array<{ id: ThemePreference; label: string; hint: string; swatch: string[] }> = [
  {
    id: 'light',
    label: 'Claro',
    hint: 'Fondo claro. Se lee mejor con mucha luz, en la calle o junto a una ventana.',
    swatch: ['#f4f6fb', '#ffffff', '#1d4ed8'],
  },
  {
    id: 'dark',
    label: 'Oscuro',
    hint: 'Fondo oscuro. Más cómodo de noche y gasta menos batería en pantallas OLED.',
    swatch: ['#0a0f1c', '#131a2b', '#3b82f6'],
  },
  {
    id: 'system',
    label: 'Como el sistema',
    hint: 'FINANZA cambia sola cuando el teléfono cambia de modo claro a oscuro (o al revés).',
    swatch: ['#0a0f1c', '#f4f6fb', '#3b82f6'],
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
  // Versión de ESTE dispositivo y comprobación de actualización: antes estaba
  // en el pie del menú lateral; ahora vive en Configuración, donde se busca.
  const [estadoVersion, setEstadoVersion] = useState<'inicial' | 'buscando' | 'aldia'>('inicial');
  const version = versionActual();

  const comprobarVersion = async () => {
    setEstadoVersion('buscando');
    const resultado = await buscarActualizacion();
    // Si se aplicó, la página se está recargando: no hace falta cambiar el texto.
    if (resultado === 'al-dia') {
      setEstadoVersion('aldia');
      window.setTimeout(() => setEstadoVersion('inicial'), 4000);
    }
  };

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
        // Siempre pesos dominicanos: la aplicación no trabaja en otra moneda y
        // el selector se retiró para que nadie la deje en dólares sin querer.
        currency: 'DOP',
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
    // Si el servidor no contesta, se usan las preferencias que la sesión ya
    // guardó en el dispositivo (se descargan al entrar). Así esta pantalla no se
    // queda «Cargando ajustes…» para siempre cuando no hay conexión.
    if (preferencesQuery.isError && sessionPreferences) {
      return (
        <div className="space-y-4">
          <Notice tone="warning">
            Sin conexión: lo que ve son las preferencias guardadas en este dispositivo. Los cambios no se podrán
            guardar hasta que vuelva la conexión.
          </Notice>
          <AjustesBasicos preferences={sessionPreferences} />
        </div>
      );
    }
    if (preferencesQuery.isError) {
      return (
        <EmptyState
          title="No se pudieron cargar los ajustes"
          hint="Hace falta conexión la primera vez. Sus preferencias se guardan en el dispositivo y luego se consultan sin internet."
          action={
            <Button variant="secondary" onClick={() => void preferencesQuery.refetch()}>
              Reintentar
            </Button>
          }
        />
      );
    }
    return <Spinner label="Cargando ajustes…" />;
  }

  return (
    <div className="space-y-4">
      {/* La página se presenta: es la única puerta de configuración del menú. */}
      <div>
        <h1 className="text-xl font-semibold text-ink">Configuración</h1>
        <p className="mt-0.5 text-xs leading-snug text-muted">
          Todo lo que puede cambiar de FINANZA, en un solo sitio.
        </p>
      </div>

      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <Tabs
        tabs={[
          { id: 'preferencias' as TabId, label: 'Preferencias' },
          { id: 'apariencia' as TabId, label: 'Apariencia' },
          { id: 'notificaciones' as TabId, label: 'Notificaciones' },
          { id: 'seguridad' as TabId, label: 'Seguridad' },
          { id: 'administracion' as TabId, label: 'Administración' },
        ]}
        active={tab}
        onChange={(next) => {
          setTab(next);
          setParams({ tab: next });
        }}
      />

      {tab === 'preferencias' ? (
        <>
          <SettingsGroup title="Perfil">
            <Row>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-muted">Nombre</dt>
                <dd className="truncate text-right text-ink">{user?.name}</dd>
                <dt className="text-muted">Correo</dt>
                <dd className="truncate text-right text-ink">{user?.email}</dd>
                <dt className="text-muted">Rol</dt>
                <dd className="text-right text-ink">{user?.role}</dd>
                <dt className="text-muted">Unidades</dt>
                <dd className="break-words text-right text-ink">{entities.map((entity) => entity.name).join(' · ')}</dd>
              </dl>
            </Row>
          </SettingsGroup>

          <SettingsGroup title="Funcionamiento" hint="Se guarda en su cuenta y viaja con usted a otros dispositivos">
            <Row>
              <Select
                compact
                label="Zona horaria"
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
            </Row>

            {/* La moneda no se elige: FINANZA trabaja sólo en pesos dominicanos. */}
            <Row className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted">Moneda</span>
              <span className="text-sm font-medium text-ink">Peso dominicano (RD$)</span>
            </Row>

            <Row>
              <div className="grid grid-cols-2 gap-2">
                <Field
                  compact
                  label="Hora del cierre (0-23)"
                  value={String(form.closingReminderHour)}
                  onChange={(value) => setForm({ ...form, closingReminderHour: Number(value) || 0 })}
                  type="number"
                />
                <Field
                  compact
                  label="Minuto (0-59)"
                  value={String(form.closingReminderMinute)}
                  onChange={(value) => setForm({ ...form, closingReminderMinute: Number(value) || 0 })}
                  type="number"
                />
              </div>
              <p className="mt-1 text-[0.68rem] leading-snug text-faint">
                Avisos escalonados: a esa hora, +1 h y +3 h si el cierre sigue pendiente.
              </p>
            </Row>

            <Row>
              <Field
                compact
                label="Horas que puede trabajar sin conexión (1-168)"
                value={String(form.offlineWindowHours)}
                onChange={(value) => setForm({ ...form, offlineWindowHours: Number(value) || 24 })}
                type="number"
                hint="Después de ese tiempo se pide validar la sesión con conexión."
              />
            </Row>

            <Row>
              <div className="grid grid-cols-2 gap-2">
                <Field
                  compact
                  label="Aviso de presupuesto (%)"
                  value={String(form.budgetWarnPct)}
                  onChange={(value) => setForm({ ...form, budgetWarnPct: Number(value) || 80 })}
                  type="number"
                />
                <Field
                  compact
                  label="Alerta de presupuesto (%)"
                  value={String(form.budgetAlertPct)}
                  onChange={(value) => setForm({ ...form, budgetAlertPct: Number(value) || 100 })}
                  type="number"
                />
              </div>
            </Row>

            <Row>
              <Button fullWidth disabled={saveMutation.isPending} onClick={() => saveMutation.mutate(form)}>
                {saveMutation.isPending ? 'Guardando…' : 'Guardar cambios'}
              </Button>
            </Row>
          </SettingsGroup>

          {/* La versión y su actualización viven AQUÍ, no en el menú lateral. */}
          <SettingsGroup title="Aplicación">
            <Row className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">Versión instalada</p>
                <p className="tabular-nums text-[0.68rem] text-faint">
                  v{version.version} · {version.compilada}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void comprobarVersion()}
                className="shrink-0 text-xs font-semibold text-brand underline decoration-dotted underline-offset-2"
              >
                {estadoVersion === 'buscando'
                  ? 'Buscando…'
                  : estadoVersion === 'aldia'
                    ? 'Ya está al día'
                    : 'Buscar actualización'}
              </button>
            </Row>
          </SettingsGroup>
        </>
      ) : null}

      {tab === 'apariencia' ? (
        <>
          <SettingsGroup title="Tema" hint="Se aplica al instante, sin recargar la pantalla">
            {THEME_OPTIONS.map((option) => {
              // «En uso» refleja lo que se ve AHORA en este dispositivo, no lo
              // que diga la cuenta: si el teléfono tiene claro y la cuenta
              // oscuro, manda el teléfono.
              const isActive = deviceThemePreference() === option.id;
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
                  className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition ${
                    isActive ? 'bg-brand-soft' : 'hover:bg-surface-2'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="flex h-7 w-9 shrink-0 overflow-hidden rounded-md border border-border-soft"
                  >
                    {option.swatch.map((color, index) => (
                      <span key={color + index} className="h-full flex-1" style={{ backgroundColor: color }} />
                    ))}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm ${isActive ? 'font-semibold text-brand' : 'font-medium text-ink'}`}>
                      {option.label}
                    </span>
                    <span className="mt-0.5 block text-[0.68rem] leading-snug text-muted">{option.hint}</span>
                  </span>
                  {isActive ? (
                    <span className="flex shrink-0 items-center gap-1 text-brand">
                      <IconCheck size={17} />
                      {/* Visible sólo para lectores de pantalla: el visto ya lo dice. */}
                      <span className="sr-only">En uso</span>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </SettingsGroup>

          {resolveTheme(deviceThemePreference()) !== resolveTheme(form.theme as ThemePreference) ? (
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

          <SettingsGroup title="Qué cambia con el tema">
            <Row>
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
              <p className="mt-2 text-[0.68rem] leading-snug text-faint">
                Su elección se guarda en la cuenta y también en este teléfono, para que la aplicación abra directamente
                con el tema elegido y sin destellos blancos.
              </p>
            </Row>
          </SettingsGroup>
        </>
      ) : null}

      {tab === 'notificaciones' ? (
        <>
          <SettingsGroup
            title="Notificaciones"
            hint="Los avisos críticos los genera el servidor: no dependen de que el navegador esté abierto"
          >
            <Row>
              <Notice tone={pushQuery.data?.pushEnabledOnServer ? 'positive' : 'warning'}>
                {pushQuery.data?.pushEnabledOnServer
                  ? `El servidor puede enviar notificaciones push. Este dispositivo tiene ${pushQuery.data.activeCount} suscripción(es) activa(s).`
                  : 'Faltan las claves VAPID en el servidor: las notificaciones push están DESACTIVADAS. Las alertas siguen apareciendo dentro de la aplicación, en «Control».'}
              </Notice>
            </Row>

            <Row className="flex flex-wrap gap-2">
              <Button size="sm" disabled={subscribePushMutation.isPending} onClick={() => subscribePushMutation.mutate()}>
                {subscribePushMutation.isPending ? 'Suscribiendo…' : 'Activar en este dispositivo'}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={testPushMutation.isPending}
                onClick={() => testPushMutation.mutate()}
              >
                Enviar prueba
              </Button>
            </Row>

            {pushQuery.data && pushQuery.data.subscriptions.length > 0 ? (
              <div className="divide-y divide-border-soft">
                {pushQuery.data.subscriptions.map((subscription) => (
                  <div key={subscription.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-muted">
                    <span className="truncate">{subscription.platform ?? 'dispositivo'}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {subscription.isActive ? <Badge tone="positive">activa</Badge> : <Badge tone="neutral">inactiva</Badge>}
                      {subscription.failCount > 0 ? <Badge tone="warning">{subscription.failCount} fallo(s)</Badge> : null}
                      <span>{subscription.lastSentAt ? formatDateTime(subscription.lastSentAt) : 'nunca'}</span>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </SettingsGroup>

          <p className="px-1 text-[0.68rem] leading-snug text-faint">
            En iPhone, las notificaciones web requieren iOS 16.4 o superior <strong>y</strong> tener FINANZA instalada
            en la pantalla de inicio. Si no se cumple, la app avisa igualmente en «Control».
          </p>
        </>
      ) : null}

      {tab === 'seguridad' ? (
        <>
          <SettingsGroup title="Cambiar contraseña" hint="Se cerrarán las demás sesiones">
            <Row>
              <PasswordField
                compact
                label="Contraseña actual"
                value={currentPassword}
                onChange={setCurrentPassword}
                autoComplete="current-password"
              />
            </Row>
            <Row>
              <PasswordField
                compact
                label="Contraseña nueva"
                value={newPassword}
                onChange={setNewPassword}
                autoComplete="new-password"
                hint="Mínimo 10 caracteres, con letras y números."
              />
            </Row>
            <Row>
              <Button
                size="sm"
                disabled={currentPassword.length < 8 || newPassword.length < 10 || passwordMutation.isPending}
                onClick={() => passwordMutation.mutate()}
              >
                {passwordMutation.isPending ? 'Cambiando…' : 'Cambiar contraseña'}
              </Button>
            </Row>
          </SettingsGroup>

          <SettingsGroup title="Sesiones y dispositivos" hint="Puede cerrar el acceso de cualquier dispositivo">
            {sessionsQuery.isLoading ? (
              <Row>
                <Spinner />
              </Row>
            ) : null}
            <div className="divide-y divide-border-soft">
              {sessionsQuery.data?.map((session) => (
                <div key={session.id} className="flex items-start justify-between gap-2 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{session.deviceId ?? 'Sesión sin dispositivo'}</p>
                    <p className="truncate text-[0.68rem] text-faint">
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
          </SettingsGroup>

          <SettingsGroup title="Sesión actual">
            <Row>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  await logout();
                  window.location.href = `${location.pathname}`;
                }}
              >
                Cerrar sesión en este dispositivo
              </Button>
              <p className="mt-2 text-[0.68rem] leading-snug text-faint">
                Los movimientos sin confirmar siguen guardados en este dispositivo hasta que vuelva a entrar.
              </p>
            </Row>
          </SettingsGroup>
        </>
      ) : null}

      {/*
        ADMINISTRACIÓN: todo lo que antes ocupaba su propia línea en el menú
        lateral vive aquí. Se toca una vez (unidades, permisos) o sólo cuando
        algo no ha llegado al servidor (salud de los datos); no es del día a día.
      */}
      {tab === 'administracion' ? (
        <SettingsGroup title="Administración" hint="Se configura una vez; no hace falta para el día a día">
          <AdminLink
            to="/unidades"
            title="Unidades financieras"
            hint="Negocios y finanzas personales"
            icon={IconBuilding}
          />
          {user?.role === 'OWNER' || user?.role === 'ADMIN' ? (
            <AdminLink
              to="/personas"
              title="Personas con acceso"
              hint="Quién entra y de quién es cada acción"
              icon={IconUsers}
            />
          ) : null}
          <AdminLink
            to="/datos"
            title="Salud de los datos"
            hint="Qué falta por confirmar y cómo arreglarlo"
            icon={IconAlert}
          />
        </SettingsGroup>
      ) : null}
    </div>
  );
}

/**
 * LISTA PLANA DE CONFIGURACIÓN
 * ----------------------------
 * Un solo borde y separadores finos: nada de tarjetas dentro de tarjetas. El
 * título va fuera, pequeño, para que la vista se lea como una lista compacta.
 */
function SettingsGroup({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="px-1">
        <h2 className="text-[0.66rem] font-semibold uppercase tracking-[0.09em] text-faint">{title}</h2>
        {hint ? <p className="mt-0.5 text-[0.68rem] leading-snug text-faint">{hint}</p> : null}
      </div>
      <div className="divide-y divide-border-soft overflow-hidden rounded-xl border border-border-soft bg-surface">
        {children}
      </div>
    </section>
  );
}

/** Fila de una lista de configuración: padding uniforme y contenido al grano. */
function Row({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`px-3 py-2.5 ${className}`}>{children}</div>;
}

/**
 * ACCESO A UNA PÁGINA DE ADMINISTRACIÓN
 * --------------------------------------
 * Una fila con nombre y una frase corta: lo mismo en las tres, sin ruido y con
 * el mismo aspecto, para que la pestaña se lea de un vistazo.
 */
function AdminLink({
  to,
  title,
  hint,
  icon: Icon,
}: {
  to: string;
  title: string;
  hint: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}) {
  return (
    <Link to={to} className="flex items-center gap-3 px-3 py-2.5 transition hover:bg-surface-2">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center bg-brand-soft text-brand">
        <Icon size={17} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{title}</span>
        <span className="block truncate text-[0.68rem] text-muted">{hint}</span>
      </span>
      <IconChevronRight size={17} className="shrink-0 text-faint" />
    </Link>
  );
}

/**
 * AJUSTES SIN CONEXIÓN (sólo consulta)
 * ------------------------------------
 * Cuando el servidor no responde, esta pantalla no puede editar nada (guardar
 * sin confirmar preferencias sería peor que no guardarlas). Lo que sí puede
 * hacer es decir con claridad cómo está configurada la aplicación, con los datos
 * que la sesión ya tiene en el teléfono.
 */
function AjustesBasicos({ preferences }: { preferences: SessionPreferences }) {
  return (
    <Card className="space-y-3">
      <SectionTitle title="Cómo está configurada la app" hint="Datos guardados en este dispositivo" />
      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <div>
          <p className="text-xs uppercase text-muted">Zona horaria</p>
          <p className="text-ink">{preferences.timezone}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-muted">Moneda</p>
          <p className="text-ink">Peso dominicano (RD$)</p>
        </div>
        <div>
          <p className="text-xs uppercase text-muted">Cierre del día</p>
          <p className="text-ink">
            {String(preferences.closingReminderHour).padStart(2, '0')}:
            {String(preferences.closingReminderMinute).padStart(2, '0')}
          </p>
        </div>
        <div>
          <p className="text-xs uppercase text-muted">Trabajo sin conexión</p>
          <p className="text-ink">{preferences.offlineWindowHours} h</p>
        </div>
        <div>
          <p className="text-xs uppercase text-muted">Aviso de presupuesto</p>
          <p className="text-ink">
            {preferences.budgetWarnPct}% · alerta {preferences.budgetAlertPct}%
          </p>
        </div>
        <div>
          <p className="text-xs uppercase text-muted">Notificaciones</p>
          <p className="text-ink">{preferences.pushEnabled ? 'Activadas' : 'Desactivadas'}</p>
        </div>
      </div>
    </Card>
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
