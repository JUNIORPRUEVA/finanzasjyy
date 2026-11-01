import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, Notice, SectionTitle, Spinner } from '../components/ui';
import { IconAlert, IconCheck, IconRefresh } from '../components/icons';
import { api, ApiError } from '../lib/api';
import { listQueuedOperations, type QueuedOperation } from '../lib/db';
import {
  descartarOperacion,
  guardarOperacionReparada,
  queueHealth,
  repararPayload,
  repairAndResend,
  reportProblemToAdmin,
  retryOperation,
  syncPendingOperations,
  type QueueHealth,
} from '../lib/sync';

/**
 * SALUD DE LOS DATOS — la página donde se arregla de verdad
 * =========================================================
 * El aviso del panel dice QUÉ pasa; aquí se puede hacer algo con cada operación
 * que no llegó al servidor, una por una:
 *
 *   · REPARAR Y REENVIAR: corrige el dato inválido (por ejemplo, una categoría
 *     de ingresos usada en un gasto) y lo envía. Reenviar lo mismo sin corregir
 *     el dato no sirve: el servidor lo volvería a rechazar siempre.
 *   · REINTENTAR: para lo que sólo falló por falta de conexión.
 *   · DESCARTAR: sólo para lo que el servidor NO aplicó. Se pide motivo y queda
 *     en la auditoría del propio teléfono… nunca se descarta algo confirmado.
 *   · PEDIR A UN ADMINISTRADOR: deja el aviso en la auditoría del sistema.
 *
 * Aquí nunca se cambia un importe ni una fecha: se arregla el dato que el
 * servidor rechazó y se reenvía exactamente lo que el usuario escribió.
 */
const ETIQUETA_TIPO: Record<string, string> = {
  TRANSACTION: 'Movimiento',
  TRANSFER: 'Traspaso',
  CLOSING_SAVE: 'Cierre del día',
  LOAN_PAYMENT: 'Pago de préstamo',
};

const ETIQUETA_ESTADO: Record<string, string> = {
  PENDING: 'pendiente',
  SENDING: 'enviando',
  ERROR: 'no se pudo enviar',
  CONFLICT: 'en conflicto',
  REJECTED: 'rechazada',
};

interface Categoria {
  id: string;
  name: string;
  kind: 'INCOME' | 'EXPENSE';
}

export function DatosPage() {
  const [salud, setSalud] = useState<QueueHealth | null>(null);
  const [operaciones, setOperaciones] = useState<QueuedOperation[]>([]);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<{ tono: 'positive' | 'warning' | 'negative'; texto: string } | null>(null);

  const categoriasQuery = useQuery<Categoria[]>({
    queryKey: ['categorias-datos'],
    queryFn: () => api.get<Categoria[]>('/categories'),
  });

  const refrescar = async () => {
    setSalud(await queueHealth());
    setOperaciones(await listQueuedOperations());
  };

  useEffect(() => {
    void refrescar();
    const intervalo = setInterval(refrescar, 4_000);
    return () => clearInterval(intervalo);
  }, []);

  const categorias = useMemo(() => categoriasQuery.data ?? [], [categoriasQuery.data]);
  const atascadas = operaciones.filter((operacion) => operacion.status !== 'PENDING');

  const reintentar = async () => {
    setOcupado('todo');
    setMensaje(null);
    try {
      const resultado = await syncPendingOperations();
      await refrescar();
      setMensaje({
        tono: resultado.applied + resultado.duplicates > 0 ? 'positive' : 'warning',
        texto: `Enviadas ${resultado.applied + resultado.duplicates}· rechazadas ${resultado.rejected}· conflictos ${resultado.conflicts}· errores ${resultado.failed}.`,
      });
    } finally {
      setOcupado(null);
    }
  };

  const repararTodo = async () => {
    setOcupado('reparar-todo');
    setMensaje(null);
    try {
      // 1. Se corrige el dato de cada una (si se puede) y 2. se reenvía lo que sólo
      //    necesitaba otro intento.
      let corregidas = 0;
      for (const operacion of operaciones) {
        const { payload, resultado } = repararPayload(operacion, categorias);
        if (resultado.arreglada) {
          await guardarOperacionReparada(operacion, payload);
          corregidas += 1;
        }
      }
      const { repaired } = await repairAndResend();
      const envio = await syncPendingOperations();
      await refrescar();
      const quedan = (await queueHealth()).total;
      setMensaje({
        tono: quedan === 0 ? 'positive' : 'warning',
        texto:
          corregidas + repaired > 0
            ? `Corregidas ${corregidas} y reenviadas ${repaired}. Enviadas al servidor: ${envio.applied + envio.duplicates}. Quedan ${quedan}.`
            : `No había nada que se pudiera corregir sola. Quedan ${quedan}; abajo está el motivo exacto de cada una.`,
      });
    } finally {
      setOcupado(null);
    }
  };

  const repararUna = async (operacion: QueuedOperation) => {
    setOcupado(operacion.id);
    setMensaje(null);
    try {
      const { payload, resultado } = repararPayload(operacion, categorias);
      if (!resultado.arreglada) {
        setMensaje({ tono: 'warning', texto: resultado.motivo ?? 'No se pudo corregir sola.' });
        return;
      }
      await guardarOperacionReparada(operacion, payload);
      await refrescar();
      setMensaje({ tono: 'positive', texto: `Corregida y reenviada: ${resultado.cambios.join('; ')}.` });
    } catch (error) {
      setMensaje({ tono: 'negative', texto: error instanceof ApiError ? error.message : 'No se pudo reparar.' });
    } finally {
      setOcupado(null);
    }
  };

  const reintentarUna = async (operacion: QueuedOperation) => {
    setOcupado(operacion.id);
    try {
      await retryOperation(operacion.id);
      await syncPendingOperations();
      await refrescar();
      setMensaje({ tono: 'positive', texto: 'Reintentada.' });
    } finally {
      setOcupado(null);
    }
  };

  const descartar = async (operacion: QueuedOperation) => {
    const confirmado = window.confirm(
      `¿Descartar «${operacion.summary ?? ETIQUETA_TIPO[operacion.type] ?? operacion.type}»?\n\n` +
        'El servidor NO lo aplicó, así que no hay nada que borrar allí. Si lo descarta, tendrá que volver a registrarlo a mano.',
    );
    if (!confirmado) {
      return;
    }
    setOcupado(operacion.id);
    try {
      await descartarOperacion(operacion.id);
      await refrescar();
      setMensaje({ tono: 'positive', texto: 'Operación descartada de este dispositivo.' });
    } finally {
      setOcupado(null);
    }
  };

  const avisar = async () => {
    if (!salud) {
      return;
    }
    setOcupado('avisar');
    try {
      await reportProblemToAdmin({
        description: 'El usuario pide que un administrador revise datos que no se han podido subir al servidor.',
        health: salud,
      });
      setMensaje({ tono: 'positive', texto: 'Aviso registrado en la auditoría para el administrador.' });
    } catch (error) {
      setMensaje({ tono: 'negative', texto: error instanceof ApiError ? error.message : 'No se pudo avisar.' });
    } finally {
      setOcupado(null);
    }
  };

  if (!salud) {
    return <Spinner label="Revisando los datos de este dispositivo…" />;
  }

  return (
    <div className="space-y-4">
      <Card className={salud.total > 0 ? 'border-warning/50 bg-warning/10' : undefined}>
        <SectionTitle
          title="Salud de los datos"
          hint="Todo lo que registró tiene que llegar al servidor; aquí se arregla lo que no llegó"
          right={<Badge tone={salud.total > 0 ? 'warning' : 'positive'}>{salud.total} sin confirmar</Badge>}
        />

        <div className="space-y-1 text-sm text-ink">
          {salud.total === 0 ? (
            <p className="flex items-center gap-2 text-positive">
              <IconCheck size={16} /> Todo confirmado por el servidor.
            </p>
          ) : (
            <>
              {salud.pending > 0 ? <p>{salud.pending} esperando envío (se reintentan solas).</p> : null}
              {salud.rejected > 0 ? <p>{salud.rejected} rechazada(s): el servidor no las aplicó.</p> : null}
              {salud.conflict > 0 ? <p>{salud.conflict} en conflicto: ya existía otra con los mismos datos.</p> : null}
              {salud.lastError ? (
                <p className="rounded-lg bg-surface-2 p-2 text-xs text-muted">
                  Último aviso: <span className="text-ink">{salud.lastError}</span>
                </p>
              ) : null}
            </>
          )}
          {!salud.isOnline ? (
            <p className="flex items-start gap-2 text-warning">
              <IconAlert size={16} className="mt-0.5 shrink-0" /> Sin conexión: las reparaciones se aplicarán cuando
              vuelva la red.
            </p>
          ) : null}
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Button size="sm" disabled={ocupado !== null || !salud.isOnline} onClick={() => void repararTodo()}>
            {ocupado === 'reparar-todo' ? 'Reparando…' : 'Reparar y reenviar todo'}
          </Button>
          <Button variant="secondary" size="sm" disabled={ocupado !== null || !salud.isOnline} onClick={() => void reintentar()}>
            <IconRefresh size={15} /> Reintentar ahora
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="sm:col-span-2"
            disabled={ocupado !== null || !salud.isOnline}
            onClick={() => void avisar()}
          >
            {ocupado === 'avisar' ? 'Avisando…' : 'Pedir a un administrador que lo revise'}
          </Button>
        </div>

        {mensaje ? (
          <div className="mt-3">
            <Notice tone={mensaje.tono}>{mensaje.texto}</Notice>
          </div>
        ) : null}
      </Card>

      {operaciones.length === 0 ? (
        <EmptyState
          title="No hay nada atascado"
          hint="Cuando algo no llegue al servidor, aparecerá aquí con el motivo y la forma de arreglarlo."
        />
      ) : null}

      {operaciones.length > 0 ? (
        <Card>
          <SectionTitle title="Operaciones en este dispositivo" hint="De la más antigua a la más reciente" />
          <div className="space-y-3">
            {operaciones.map((operacion) => {
              const reparacion = repararPayload(operacion, categorias);
              const atascada = operacion.status !== 'PENDING';
              return (
                <div
                  key={operacion.id}
                  className={`rounded-lg border p-3 ${atascada ? 'border-warning/50 bg-warning/5' : 'border-border-soft'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                        {ETIQUETA_TIPO[operacion.type] ?? operacion.type}
                        <Badge tone={atascada ? 'warning' : 'neutral'}>
                          {ETIQUETA_ESTADO[operacion.status] ?? operacion.status}
                        </Badge>
                      </p>
                      <p className="truncate text-xs text-muted">{operacion.summary ?? 'Sin descripción'}</p>
                      <p className="text-[0.7rem] text-faint">
                        {new Date(operacion.occurredAt).toLocaleString('es-DO')}
                        {operacion.amount ? ` · ${operacion.amount}` : ''}
                      </p>
                    </div>
                  </div>

                  {operacion.lastError ? (
                    <p className="mt-2 rounded-lg bg-surface-2 p-2 text-xs leading-snug text-ink">
                      <strong>Motivo del servidor:</strong> {operacion.lastError}
                    </p>
                  ) : null}

                  {reparacion.resultado.arreglada ? (
                    <p className="mt-2 text-xs leading-snug text-positive">
                      <strong>Se puede corregir:</strong> {reparacion.resultado.cambios.join('; ')}.
                    </p>
                  ) : atascada ? (
                    <p className="mt-2 text-xs leading-snug text-warning">{reparacion.resultado.motivo}</p>
                  ) : null}

                  <div className="mt-2 flex flex-wrap gap-2">
                    {reparacion.resultado.arreglada ? (
                      <Button size="sm" disabled={ocupado !== null || !salud.isOnline} onClick={() => void repararUna(operacion)}>
                        {ocupado === operacion.id ? 'Reparando…' : 'Reparar y reenviar'}
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={ocupado !== null || !salud.isOnline}
                      onClick={() => void reintentarUna(operacion)}
                    >
                      Reintentar
                    </Button>
                    <Button variant="ghost" size="sm" disabled={ocupado !== null} onClick={() => void descartar(operacion)}>
                      Descartar
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          {atascadas.length > 0 ? (
            <p className="mt-3 text-[0.7rem] leading-snug text-faint">
              «Descartar» sólo quita la operación de este teléfono: el servidor no la aplicó, así que no se borra ningún
              movimiento confirmado. Si la descarta, regístrela otra vez a mano con el dato correcto.
            </p>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
