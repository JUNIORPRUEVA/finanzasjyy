import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../store/auth';
import { Button, Notice } from '../components/ui';

const loginSchema = z.object({
  email: z.string().email('Escriba un correo electrónico válido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
});

const setupSchema = z.object({
  name: z.string().min(2, 'Escriba su nombre'),
  email: z.string().email('Escriba un correo electrónico válido'),
  password: z.string().min(10, 'La contraseña debe tener al menos 10 caracteres e incluir un número'),
});

type LoginForm = z.infer<typeof loginSchema>;
type SetupForm = z.infer<typeof setupSchema>;

/**
 * ACCESO Y PRIMER USO
 * -------------------
 * Si FINANZA todavía no tiene ningún usuario, la pantalla muestra el alta del
 * propietario (onboarding). A partir de ahí, el registro sólo lo puede hacer un
 * administrador desde Ajustes.
 */
export function LoginPage({
  sessionExpired,
  onDismissExpired,
}: {
  sessionExpired: boolean;
  onDismissExpired: () => void;
}) {
  const { login, registerFirstUser } = useAuth();
  const [requiresSetup, setRequiresSetup] = useState<boolean | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loginForm = useForm<LoginForm>({ resolver: zodResolver(loginSchema) });
  const setupForm = useForm<SetupForm>({ resolver: zodResolver(setupSchema) });

  useEffect(() => {
    api
      .get<{ requiresSetup: boolean }>('/auth/bootstrap-status')
      .then((response) => setRequiresSetup(response.requiresSetup))
      .catch(() => setRequiresSetup(false));
  }, []);

  const handleLogin = loginForm.handleSubmit(async (values) => {
    setSubmitting(true);
    setServerError(null);
    try {
      await login(values.email, values.password);
    } catch (error) {
      setServerError(error instanceof ApiError ? error.message : 'No se pudo iniciar sesión. Revise su conexión.');
    } finally {
      setSubmitting(false);
    }
  });

  const handleSetup = setupForm.handleSubmit(async (values) => {
    setSubmitting(true);
    setServerError(null);
    try {
      await registerFirstUser(values.name, values.email, values.password);
    } catch (error) {
      setServerError(error instanceof ApiError ? error.message : 'No se pudo crear el usuario.');
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-10">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold text-slate-100">FINANZA</h1>
        <p className="mt-1 text-sm text-slate-400">
          Que ningún peso entre o salga sin quedar identificado.
        </p>
      </div>

      {sessionExpired ? (
        <div className="mb-4">
          <Notice tone="warning" title="Su sesión caducó">
            Por seguridad debe volver a identificarse. Los movimientos registrados sin conexión siguen guardados en
            este dispositivo.
            <button type="button" onClick={onDismissExpired} className="ml-2 underline">
              Entendido
            </button>
          </Notice>
        </div>
      ) : null}

      {serverError ? (
        <div className="mb-4">
          <Notice tone="negative">{serverError}</Notice>
        </div>
      ) : null}

      {requiresSetup === null ? (
        <p className="text-center text-sm text-slate-400">Comprobando el estado del sistema…</p>
      ) : requiresSetup ? (
        <form onSubmit={handleSetup} className="space-y-4">
          <Notice tone="neutral" title="Primer uso">
            FINANZA no tiene usuarios todavía. Cree el usuario propietario; después podrá añadir más desde Ajustes.
          </Notice>

          <label className="block">
            <span className="mb-1 block text-sm text-slate-300">Nombre</span>
            <input
              {...setupForm.register('name')}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-emerald-500"
            />
            {setupForm.formState.errors.name ? (
              <span className="text-xs text-rose-400">{setupForm.formState.errors.name.message}</span>
            ) : null}
          </label>

          <label className="block">
            <span className="mb-1 block text-sm text-slate-300">Correo electrónico</span>
            <input
              type="email"
              {...setupForm.register('email')}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-emerald-500"
            />
            {setupForm.formState.errors.email ? (
              <span className="text-xs text-rose-400">{setupForm.formState.errors.email.message}</span>
            ) : null}
          </label>

          <label className="block">
            <span className="mb-1 block text-sm text-slate-300">Contraseña</span>
            <input
              type="password"
              {...setupForm.register('password')}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-emerald-500"
            />
            {setupForm.formState.errors.password ? (
              <span className="text-xs text-rose-400">{setupForm.formState.errors.password.message}</span>
            ) : null}
          </label>

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? 'Creando…' : 'Crear usuario propietario'}
          </Button>
        </form>
      ) : (
        <form onSubmit={handleLogin} className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm text-slate-300">Correo electrónico</span>
            <input
              type="email"
              autoComplete="username"
              {...loginForm.register('email')}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-emerald-500"
            />
            {loginForm.formState.errors.email ? (
              <span className="text-xs text-rose-400">{loginForm.formState.errors.email.message}</span>
            ) : null}
          </label>

          <label className="block">
            <span className="mb-1 block text-sm text-slate-300">Contraseña</span>
            <input
              type="password"
              autoComplete="current-password"
              {...loginForm.register('password')}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-emerald-500"
            />
            {loginForm.formState.errors.password ? (
              <span className="text-xs text-rose-400">{loginForm.formState.errors.password.message}</span>
            ) : null}
          </label>

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? 'Entrando…' : 'Entrar'}
          </Button>

          <p className="text-center text-xs text-slate-500">
            Al entrar, este dispositivo queda autorizado para registrar movimientos sin conexión durante la ventana
            configurada (24 h por defecto).
          </p>
        </form>
      )}
    </div>
  );
}
