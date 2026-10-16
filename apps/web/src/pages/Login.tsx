import { useEffect, useState } from 'react';
import { z } from 'zod';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../store/auth';
import { Button, Field, Notice, PasswordField } from '../components/ui';
import { IconAlert, IconLock, IconWifiOff } from '../components/icons';

const loginSchema = z.object({
  email: z.string().email('Escriba un correo electrónico válido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
});

const setupSchema = z.object({
  name: z.string().min(2, 'Escriba su nombre'),
  email: z.string().email('Escriba un correo electrónico válido'),
  password: z.string().min(10, 'La contraseña debe tener al menos 10 caracteres'),
});

type LoginErrors = Partial<Record<'email' | 'password', string>>;
type SetupErrors = Partial<Record<'name' | 'email' | 'password', string>>;

/**
 * ACCESO Y PRIMER USO
 * -------------------
 * Dos cosas que se piden y se dan con claridad:
 *  · Entrar una sola vez: la sesión se guarda en el servidor y se renueva sola,
 *    así que cerrar la aplicación no obliga a escribir la contraseña otra vez.
 *  · Ningún engaño: si falta algo (por ejemplo, la recuperación de contraseña)
 *    se dice aquí mismo, en vez de poner un botón que no hace nada.
 *
 * Si FINANZA todavía no tiene usuarios, esta pantalla crea el usuario
 * propietario. A partir de ahí, los demás usuarios los da de alta un
 * administrador desde «Ajustes».
 */
export function LoginPage({
  sessionExpired,
  sessionMessage,
  onDismissExpired,
}: {
  sessionExpired: boolean;
  sessionMessage: string | null;
  onDismissExpired: () => void;
}) {
  const { login, registerFirstUser } = useAuth();
  const [requiresSetup, setRequiresSetup] = useState<boolean | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<LoginErrors & SetupErrors>({});

  useEffect(() => {
    api
      .get<{ requiresSetup: boolean }>('/auth/bootstrap-status')
      .then((response) => setRequiresSetup(response.requiresSetup))
      .catch(() => setRequiresSetup(false));
  }, []);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleLogin = async () => {
    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      const fieldErrors: LoginErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as 'email' | 'password';
        fieldErrors[key] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }
    setErrors({});
    setServerError(null);
    setSubmitting(true);
    try {
      await login(parsed.data.email.trim(), parsed.data.password);
    } catch (error) {
      // Un error de red NO es «credenciales incorrectas»: son problemas distintos
      // y el usuario merece saber cuál de los dos tiene delante.
      setServerError(
        error instanceof ApiError
          ? error.message
          : 'No se pudo contactar con el servidor. Revise su conexión e inténtelo de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetup = async () => {
    const parsed = setupSchema.safeParse({ name, email, password });
    if (!parsed.success) {
      const fieldErrors: SetupErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as 'name' | 'email' | 'password';
        fieldErrors[key] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }
    setErrors({});
    setServerError(null);
    setSubmitting(true);
    try {
      await registerFirstUser(parsed.data.name.trim(), parsed.data.email.trim(), parsed.data.password);
    } catch (error) {
      setServerError(error instanceof ApiError ? error.message : 'No se pudo crear el usuario.');
    } finally {
      setSubmitting(false);
    }
  };

  const isSetup = requiresSetup === true;

  return (
    <div className="flex min-h-dvh flex-col justify-center px-5 pb-[calc(var(--safe-bottom)+1.5rem)] pt-[calc(var(--safe-top)+2rem)]">
      <div className="mx-auto w-full max-w-sm">
        {/* Marca */}
        <div className="mb-7 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-white shadow-elevated">
            <IconLock size={26} />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">FINANZA</h1>
          <p className="mt-1 text-sm text-muted">Tu dinero, bajo control.</p>
        </div>

        {!isOnline ? (
          <div className="mb-4">
            <Notice tone="warning" title="Sin conexión">
              <span className="flex items-start gap-2">
                <IconWifiOff size={16} className="mt-0.5 shrink-0" />
                Para entrar hace falta conexión con el servidor. Sus movimientos pendientes siguen guardados en este
                dispositivo y se enviarán cuando vuelva la conexión.
              </span>
            </Notice>
          </div>
        ) : null}

        {sessionExpired ? (
          <div className="mb-4">
            <Notice tone="warning" title="Su sesión terminó">
              {sessionMessage ??
                'Por seguridad debe volver a identificarse. Los movimientos registrados sin conexión siguen guardados en este dispositivo.'}
              <button type="button" onClick={onDismissExpired} className="ml-1 underline">
                Entendido
              </button>
            </Notice>
          </div>
        ) : null}

        {serverError ? (
          <div className="mb-4">
            <Notice tone="negative" title="No se pudo entrar">
              {serverError}
            </Notice>
          </div>
        ) : null}

        {requiresSetup === null ? (
          <div className="space-y-3" aria-busy="true">
            <div className="h-11 animate-pulse rounded-xl bg-surface-2" />
            <div className="h-11 animate-pulse rounded-xl bg-surface-2" />
            <div className="h-12 animate-pulse rounded-xl bg-surface-2" />
          </div>
        ) : isSetup ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSetup();
            }}
          >
            <Notice tone="info" title="Primer uso">
              FINANZA todavía no tiene usuarios. Cree el propietario: después podrá añadir más personas desde «Ajustes».
            </Notice>

            <Field
              label="Nombre"
              value={name}
              onChange={setName}
              autoComplete="name"
              enterKeyHint="next"
              error={errors.name}
            />
            <Field
              label="Correo electrónico"
              value={email}
              onChange={setEmail}
              type="email"
              inputMode="email"
              autoComplete="username"
              enterKeyHint="next"
              placeholder="usted@ejemplo.com"
              error={errors.email}
            />
            <PasswordField
              label="Contraseña"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              hint="Mínimo 10 caracteres."
            />
            {errors.password ? <p className="-mt-2 text-xs text-negative">{errors.password}</p> : null}

            <Button type="submit" fullWidth size="lg" disabled={submitting || !isOnline}>
              {submitting ? 'Creando su acceso…' : 'Crear usuario propietario'}
            </Button>
          </form>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void handleLogin();
            }}
          >
            <Field
              label="Correo electrónico"
              value={email}
              onChange={setEmail}
              type="email"
              inputMode="email"
              autoComplete="username"
              enterKeyHint="next"
              placeholder="usted@ejemplo.com"
              error={errors.email}
            />
            <PasswordField label="Contraseña" value={password} onChange={setPassword} autoComplete="current-password" />
            {errors.password ? <p className="-mt-2 text-xs text-negative">{errors.password}</p> : null}

            <Button type="submit" fullWidth size="lg" disabled={submitting || !isOnline}>
              {submitting ? 'Entrando…' : 'Entrar'}
            </Button>

            <p className="text-center text-xs leading-snug text-faint">
              Este dispositivo quedará autorizado para registrar movimientos sin conexión durante la ventana configurada
              (24 h por defecto). Cerrar la aplicación <strong>no</strong> cierra su sesión.
            </p>

            <div className="rounded-xl border border-border-soft bg-surface p-3">
              <p className="flex items-start gap-2 text-xs leading-snug text-muted">
                <IconAlert size={15} className="mt-0.5 shrink-0 text-warning" />
                <span>
                  <strong className="text-ink">Recuperación de contraseña: pendiente.</strong> Todavía no existe un
                  mecanismo de recuperación automática. Si olvida la contraseña, hay que restablecerla desde la
                  administración del sistema; por eso esta pantalla no ofrece un enlace que no llevaría a ningún sitio.
                </span>
              </p>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
