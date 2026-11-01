import { useEffect, useState } from 'react';
import { Badge, Button, Card, Notice, SectionTitle } from './ui';
import { IconAlert, IconCheck, IconRefresh } from './icons';
import { queueHealth, repairAndResend, reportProblemToAdmin, syncPendingOperations, type QueueHealth } from '../lib/sync';
import { ApiError } from '../lib/api';

/**
 * AGENTE DE SALUD DE LOS DATOS
 * ============================
 * Un vigilante que se encarga de una sola cosa: que NADA de lo que el usuario
 * registró se quede en el teléfono sin llegar al servidor.
 *
 * Antes, un movimiento que el servidor rechazaba (o que quedaba en conflicto) se
 * quedaba en la cola del dispositivo para siempre y en silencio: la pantalla
 * decía «al día» porque sólo contaba las operaciones pendientes normales. Así se
 * podía ver «traspaso confirmado» y no haberse movido nada.
 *
 * Ahora el agente:
 *   · cuenta TODO lo que falta, incluido lo atascado,
 *   · reintenta solo lo que puede reintentarse,
 *   · ofrece «Reparar y reenviar» para lo atascado (con identificador nuevo,
 *     sin tocar importes: el servidor sigue deduplicando),
 *   · y si no hay forma, avisa al administrador con el detalle técnico.
 *
 * No inventa ni corrige importes: reenvía exactamente lo que el usuario escribió.
 */
export function AgenteDeSalud() {
  const [salud, setSalud] = useState<QueueHealth | null>(null);
  const [ocupado, setOcupado] = useState<'sync' | 'repair' | 'report' | null>(null);
  const [mensaje, setMensaje] = useState<{ tono: 'positive' | 'warning' | 'negative'; texto: string } | null>(null);

  useEffect(() => {
    const refrescar = async () => setSalud(await queueHealth());
    void refrescar();
    const intervalo = setInterval(refrescar, 4_000);
    return () => clearInterval(intervalo);
  }, []);

  const reintentar = async () => {
    setOcupado('sync');
    setMensaje(null);
    try {
      const resultado = await syncPendingOperations();
      setSalud(await queueHealth());
      if (resultado.applied + resultado.duplicates > 0) {
        setMensaje({
          tono: 'positive',
          texto: `${resultado.applied + resultado.duplicates} operación(es) confirmadas por el servidor.`,
        });
      } else if (resultado.rejected + resultado.conflicts > 0) {
        setMensaje({
          tono: 'warning',
          texto: `${resultado.rejected + resultado.conflicts} operación(es) necesitan una corrección: use «Reparar y reenviar».`,
        });
      } else if (resultado.failed > 0) {
        setMensaje({ tono: 'negative', texto: 'El servidor no respondió. Se reintentará solo.' });
      } else {
        setMensaje({ tono: 'positive', texto: 'No quedaba nada por enviar.' });
      }
    } finally {
      setOcupado(null);
    }
  };

  const reparar = async () => {
    setOcupado('repair');
    setMensaje(null);
    try {
      const { repaired } = await repairAndResend();
      setSalud(await queueHealth());
      setMensaje({
        tono: repaired > 0 ? 'positive' : 'positive',
        texto:
          repaired > 0
            ? `Se han reparado y reenviado ${repaired} operación(es). Si alguna vuelve a rechazarse, abajo verá el motivo exacto.`
            : 'No había nada atascado que reparar.',
      });
    } catch (error) {
      setMensaje({
        tono: 'negative',
        texto: error instanceof ApiError ? error.message : 'No se pudo reparar. Compruebe la conexión.',
      });
    } finally {
      setOcupado(null);
    }
  };

  const avisar = async () => {
    if (!salud) {
      return;
    }
    setOcupado('report');
    setMensaje(null);
    try {
      await reportProblemToAdmin({
        description:
          'El dispositivo tiene datos sin llegar al servidor y el usuario pide que un administrador lo revise.',
        health: salud,
      });
      setMensaje({
        tono: 'positive',
        texto: 'Aviso enviado. Queda registrado en la auditoría para que un administrador lo revise.',
      });
    } catch (error) {
      setMensaje({
        tono: 'negative',
        texto: error instanceof ApiError ? error.message : 'No se pudo enviar el aviso: hace falta conexión.',
      });
    } finally {
      setOcupado(null);
    }
  };

  if (!salud) {
    return null;
  }

  // Todo correcto: una línea discreta, sin ruido.
  if (salud.total === 0 && salud.isOnline) {
    return (
      <Card>
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-positive/12 text-positive">
            <IconCheck size={18} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">Datos al día</p>
            <p className="text-xs leading-snug text-muted">
              Todo lo que ha registrado en este dispositivo está confirmado por el servidor.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const hayAtascado = salud.stuck > 0;

  return (
    <Card className={hayAtascado ? 'border-warning/50 bg-warning/10' : 'border-info/40 bg-info/10'}>
      <SectionTitle
        title="Agente de datos"
        hint="Vigila que nada se quede sin llegar al servidor"
        right={
          <Badge tone={hayAtascado ? 'warning' : 'info'}>
            {salud.total} sin confirmar
          </Badge>
        }
      />

      <div className="space-y-1 text-sm leading-snug text-ink">
        {!salud.isOnline ? (
          <p className="flex items-start gap-2">
            <IconAlert size={16} className="mt-0.5 shrink-0 text-warning" />
            Sin conexión: lo registrado se guarda aquí y se enviará solo al recuperar la red.
          </p>
        ) : null}
        {salud.pending > 0 ? (
          <p>
            <strong>{salud.pending}</strong> operación(es) esperando confirmación del servidor.
          </p>
        ) : null}
        {salud.rejected > 0 ? (
          <p>
            <strong>{salud.rejected}</strong> rechazada(s) por el servidor: no se aplicaron y el dinero no se movió.
          </p>
        ) : null}
        {salud.conflict > 0 ? (
          <p>
            <strong>{salud.conflict}</strong> en conflicto: ya existía una operación con esos datos.
          </p>
        ) : null}
        {salud.lastError ? (
          <p className="rounded-lg bg-surface-2 p-2 text-xs text-muted">
            Último aviso del servidor: <span className="text-ink">{salud.lastError}</span>
          </p>
        ) : null}
        {salud.oldestOccurredAt ? (
          <p className="text-xs text-faint">
            La más antigua es del {new Date(salud.oldestOccurredAt).toLocaleString('es-DO')}.
          </p>
        ) : null}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Button variant="secondary" size="sm" disabled={ocupado !== null || !salud.isOnline} onClick={() => void reintentar()}>
          <IconRefresh size={15} />
          {ocupado === 'sync' ? 'Enviando…' : 'Reintentar ahora'}
        </Button>
        <Button size="sm" disabled={ocupado !== null || !hayAtascado || !salud.isOnline} onClick={() => void reparar()}>
          {ocupado === 'repair' ? 'Reparando…' : 'Reparar y reenviar'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="sm:col-span-2"
          disabled={ocupado !== null || !salud.isOnline}
          onClick={() => void avisar()}
        >
          {ocupado === 'report' ? 'Avisando…' : 'Pedir a un administrador que lo revise'}
        </Button>
      </div>

      {mensaje ? (
        <div className="mt-3">
          <Notice tone={mensaje.tono}>{mensaje.texto}</Notice>
        </div>
      ) : null}

      <p className="mt-2 text-[0.7rem] leading-snug text-faint">
        El agente no cambia importes ni fechas: reenvía exactamente lo que usted registró y el servidor rechaza lo
        repetido. Nunca se borra un movimiento sin confirmar.
      </p>
    </Card>
  );
}
