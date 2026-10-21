import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Badge, Button, Card, EmptyState, Field, ListScreen, Notice, Panel, Select, Spinner } from '../components/ui';
import { IconAlert, IconUsers } from '../components/icons';
import { formatDateTime } from '../lib/format';

/**
 * PERSONAS CON ACCESO
 * ===================
 * La cuenta es de la familia, no de una sola persona. Aquí se crea el acceso de
 * la esposa, del hijo o de quien haga falta — **sin configurar permisos ni
 * restricciones**: entra y puede hacer todo, igual que el propietario.
 *
 * Lo que sí es obligatorio, y es el motivo de esta pantalla: **cada cosa que se
 * hace queda firmada**. El nombre viaja con el movimiento, con la lista de
 * compras, con el cierre y con el registro de auditoría. En una cuenta de varias
 * personas, un gasto sin autor no sirve de nada: no se puede preguntar «¿esto
 * quién lo apuntó?» si la aplicación no lo guarda en el momento.
 *
 * Decisiones:
 *  · Al crear a alguien se le da acceso a TODAS las unidades del que lo crea, de
 *    una vez. Entrar y ver la aplicación vacía sería peor que no poder entrar.
 *  · Desactivar a alguien cierra sus sesiones en el acto, pero **no borra nada**:
 *    lo que registró sigue en el libro mayor con su nombre.
 *  · La contraseña se puede cambiar aquí si alguien la olvida.
 *  · Nada de esta pantalla funciona sin conexión: los usuarios viven en el
 *    servidor (y se dice con esas palabras, sin dejarlo cargando).
 */

interface Persona {
  id: string;
  name: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  isSelf: boolean;
}

const ROLES: Array<{ value: Persona['role']; label: string; hint: string }> = [
  { value: 'ADMIN', label: 'Administrador', hint: 'Puede todo: registrar, organizar y crear más personas.' },
  { value: 'MEMBER', label: 'Miembro', hint: 'Puede registrar y consultar todo, pero no crear personas.' },
  { value: 'VIEWER', label: 'Sólo lectura', hint: 'Puede mirar, no registrar. Útil para quien solo consulta.' },
];

const etiquetaRol = (rol: Persona['role']) =>
  rol === 'OWNER' ? 'Propietario' : ROLES.find((item) => item.value === rol)?.label ?? rol;

const tonoRol = (rol: Persona['role']): 'positive' | 'neutral' | 'warning' =>
  rol === 'OWNER' ? 'positive' : rol === 'VIEWER' ? 'warning' : 'neutral';

/** Iniciales para el círculo: «Junior López» → «JL». */
function iniciales(nombre: string): string {
  const partes = nombre.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) {
    return '?';
  }
  return (partes[0][0] + (partes[1]?.[0] ?? '')).toUpperCase();
}

export function PeoplePage() {
  const queryClient = useQueryClient();

  const [creando, setCreando] = useState(false);
  const [nombre, setNombre] = useState('');
  const [correo, setCorreo] = useState('');
  const [clave, setClave] = useState('');
  const [rol, setRol] = useState<Persona['role']>('ADMIN');
  const [aviso, setAviso] = useState<{ tone: 'positive' | 'warning' | 'negative'; text: string } | null>(null);

  // Cambio de contraseña de otra persona.
  const [cambiandoClave, setCambiandoClave] = useState<Persona | null>(null);
  const [claveNueva, setClaveNueva] = useState('');

  const personasQuery = useQuery<Persona[]>({
    queryKey: ['users'],
    queryFn: () => api.get<Persona[]>('/auth/users'),
  });

  const personas = useMemo(() => personasQuery.data ?? [], [personasQuery.data]);

  const crearMutation = useMutation({
    mutationFn: () =>
      api.post<{ name: string; entityCount: number }>('/auth/users', {
        name: nombre.trim(),
        email: correo.trim(),
        password: clave,
        role: rol,
      }),
    onSuccess: (resultado) => {
      setAviso({
        tone: 'positive',
        text: `${resultado.name} ya puede entrar con su correo y su contraseña${
          resultado.entityCount > 0 ? `, y ve las ${resultado.entityCount} unidad(es) financiera(s)` : ''
        }. Todo lo que registre llevará su nombre.`,
      });
      setNombre('');
      setCorreo('');
      setClave('');
      setCreando(false);
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error) => {
      setAviso({
        tone: 'negative',
        text: error instanceof ApiError ? error.message : 'No se pudo crear el acceso.',
      });
    },
  });

  const activarMutation = useMutation({
    mutationFn: (persona: Persona) =>
      api.patch(`/auth/users/${persona.id}`, { isActive: !persona.isActive }),
    onSuccess: (_data, persona) => {
      setAviso({
        tone: persona.isActive ? 'warning' : 'positive',
        text: persona.isActive
          ? `${persona.name} ya no puede entrar. Lo que registró sigue en el historial con su nombre.`
          : `${persona.name} vuelve a tener acceso.`,
      });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error) => {
      setAviso({ tone: 'negative', text: error instanceof ApiError ? error.message : 'No se pudo cambiar el acceso.' });
    },
  });

  const claveMutation = useMutation({
    mutationFn: () => api.post(`/auth/users/${cambiandoClave!.id}/password`, { password: claveNueva }),
    onSuccess: () => {
      setAviso({
        tone: 'positive',
        text: `Contraseña cambiada. ${cambiandoClave?.name ?? 'La persona'} ya puede entrar con la nueva.`,
      });
      setCambiandoClave(null);
      setClaveNueva('');
    },
    onError: (error) => {
      setAviso({
        tone: 'negative',
        text: error instanceof ApiError ? error.message : 'No se pudo cambiar la contraseña.',
      });
    },
  });

  const puedeCrear = nombre.trim().length >= 2 && correo.includes('@') && clave.length >= 8;

  if (personasQuery.isLoading) {
    return <Spinner label="Cargando personas…" />;
  }

  if (personasQuery.isError) {
    return (
      <Notice tone="warning" title="No se pudo cargar la lista de personas">
        <p>
          Los accesos viven en el servidor, así que esta pantalla necesita conexión. Lo que ya está registrado se sigue
          viendo sin internet: cada movimiento lleva el nombre de quien lo hizo.
        </p>
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={() => void personasQuery.refetch()}>
            Reintentar
          </Button>
        </div>
      </Notice>
    );
  }

  return (
    <ListScreen
      toolbar={
        <>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight text-ink">Personas con acceso</h1>
              <p className="text-xs text-muted">
                {personas.filter((persona) => persona.isActive).length} con acceso ·{' '}
                {personas.filter((persona) => !persona.isActive).length} sin acceso
              </p>
            </div>
            <Button size="sm" onClick={() => setCreando(true)}>
              Añadir persona
            </Button>
          </div>
          <p className="text-xs leading-snug text-muted">
            Todos pueden entrar y registrar sin restricciones. Lo que sí queda siempre es <strong>su firma</strong>: el
            movimiento, la lista de compras y el cierre guardan quién lo hizo.
          </p>
        </>
      }
    >
      {/* El aviso se muestra en un solo sitio: dentro del panel mientras se
          rellena (que es donde está mirando el usuario) y en la página cuando no
          hay panel abierto. Duplicarlo hacía que el mismo error saliera dos veces. */}
      {aviso && !creando && cambiandoClave === null ? <Notice tone={aviso.tone}>{aviso.text}</Notice> : null}

      {personas.length === 0 ? (
        <EmptyState
          title="Todavía no hay personas"
          hint="Cree el acceso de su esposa o de su hijo con su correo. Entrarán con su propio nombre y todo quedará firmado."
        />
      ) : (
        <div className="space-y-2">
          {personas.map((persona) => (
            <Card key={persona.id} className="space-y-2">
              <div className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                    persona.isActive ? 'bg-brand-soft text-brand' : 'bg-surface-3 text-faint'
                  }`}
                >
                  {iniciales(persona.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-ink">
                    <span className="truncate">{persona.name}</span>
                    <Badge tone={tonoRol(persona.role)}>{etiquetaRol(persona.role)}</Badge>
                    {persona.isSelf ? <Badge tone="neutral">usted</Badge> : null}
                    {persona.isActive ? null : <Badge tone="warning">sin acceso</Badge>}
                  </p>
                  <p className="truncate text-xs text-muted">{persona.email}</p>
                  <p className="mt-0.5 text-[0.7rem] text-faint">
                    {persona.lastLoginAt
                      ? `Última entrada: ${formatDateTime(persona.lastLoginAt)}`
                      : 'Todavía no ha entrado'}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 border-t border-border-soft pt-2">
                <Button variant="secondary" size="sm" onClick={() => setCambiandoClave(persona)}>
                  Cambiar contraseña
                </Button>
                {persona.isSelf ? null : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={activarMutation.isPending}
                    onClick={() => activarMutation.mutate(persona)}
                  >
                    {persona.isActive ? 'Quitar acceso' : 'Dar acceso'}
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <p className="flex items-start gap-1.5 text-[0.7rem] leading-snug text-faint">
        <IconUsers size={14} className="mt-0.5 shrink-0" />
        El historial completo, acción por acción y con hora, está en «Auditoría». Nada de lo registrado se puede borrar:
        si algo está mal, se anula y queda el motivo.
      </p>

      {/* ALTA: panel lateral, igual que el resto de formularios de la app. */}
      <Panel open={creando} onClose={() => setCreando(false)} title="Añadir una persona">
        <div className="space-y-3 pb-4">
          <p className="text-xs leading-snug text-muted">
            Entrará con este correo y esta contraseña, verá todas sus unidades financieras y podrá registrar lo que
            necesite. No hay nada más que configurar.
          </p>
          <Field
            label="Nombre"
            value={nombre}
            onChange={setNombre}
            placeholder="Ej.: Ayleen"
            autoComplete="off"
          />
          <Field
            label="Correo electrónico"
            value={correo}
            onChange={setCorreo}
            type="email"
            inputMode="email"
            placeholder="nombre@correo.com"
            autoComplete="off"
          />
          <Field
            label="Contraseña"
            value={clave}
            onChange={setClave}
            type="password"
            placeholder="Al menos 8 caracteres"
            hint="Al menos 8 caracteres, con una letra y un número. Podrá cambiarla cuando quiera."
            autoComplete="new-password"
          />
          <Select
            label="Puede"
            value={rol}
            onChange={(valor) => setRol(valor as Persona['role'])}
            options={ROLES.map((opcion) => ({ value: opcion.value, label: opcion.label }))}
            hint={ROLES.find((opcion) => opcion.value === rol)?.hint}
          />
          {aviso && aviso.tone === 'negative' ? <Notice tone="negative">{aviso.text}</Notice> : null}
          <div className="flex gap-2 pt-1">
            <Button
              className="flex-1"
              disabled={!puedeCrear || crearMutation.isPending}
              onClick={() => crearMutation.mutate()}
            >
              {crearMutation.isPending ? 'Creando…' : 'Crear acceso'}
            </Button>
            <Button variant="secondary" onClick={() => setCreando(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      </Panel>

      {/* CONTRASEÑA: para cuando alguien la olvida. */}
      <Panel
        open={cambiandoClave !== null}
        onClose={() => {
          setCambiandoClave(null);
          setClaveNueva('');
        }}
        title={`Contraseña de ${cambiandoClave?.name ?? ''}`}
      >
        <div className="space-y-3 pb-4">
          <p className="flex items-start gap-1.5 text-xs leading-snug text-muted">
            <IconAlert size={14} className="mt-0.5 shrink-0 text-warning" />
            Escriba una contraseña nueva y dígasela a esa persona. No se puede ver la anterior.
          </p>
          <Field
            label="Contraseña nueva"
            value={claveNueva}
            onChange={setClaveNueva}
            type="password"
            placeholder="Al menos 8 caracteres"
            autoComplete="new-password"
          />
          <div className="flex gap-2 pt-1">
            <Button
              className="flex-1"
              disabled={claveNueva.length < 8 || claveMutation.isPending}
              onClick={() => claveMutation.mutate()}
            >
              {claveMutation.isPending ? 'Guardando…' : 'Cambiar contraseña'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setCambiandoClave(null);
                setClaveNueva('');
              }}
            >
              Cancelar
            </Button>
          </div>
        </div>
      </Panel>
    </ListScreen>
  );
}
