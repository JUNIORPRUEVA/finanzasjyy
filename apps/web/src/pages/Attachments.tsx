import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import {
  Badge,
  Card,
  ConfirmDialog,
  EmptyState,
  Fab,
  Notice,
  PageIntro,
  SectionTitle,
  Select,
  Sheet,
  Spinner,
} from '../components/ui';
import { useAuth } from '../store/auth';
import { formatDateTime } from '../lib/format';

/**
 * COMPROBANTES Y DOCUMENTOS
 * -------------------------
 * Facturas, fotos de recibos y comprobantes. Sirven para justificar cada peso:
 * es la diferencia entre «creo que gasté esto» y «aquí está el papel».
 *
 * El archivo se envía al servidor, que valida tamaño y tipo real del contenido,
 * lo guarda fuera de la carpeta pública y lo devuelve sólo a quien tiene permiso
 * sobre esa unidad financiera. NUNCA se expone una ruta de archivo.
 */

interface AttachmentRow {
  id: string;
  entityId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  sha256?: string | null;
}

const MAX_MB = 8;

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: T[] }).data;
  }
  return [];
}

const formatSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

export function AttachmentsPage() {
  const { entities } = useAuth();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [entityId, setEntityId] = useState(entities[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  // La hoja de alta se abre desde el botón flotante: la lista queda libre.
  const [abriendo, setAbriendo] = useState(false);
  const [message, setMessage] = useState<{ tone: 'positive' | 'warning' | 'negative'; text: string } | null>(null);
  // Se pregunta con el diálogo propio de la aplicación (el del navegador es
  // bloqueante, no se puede leer cómodo en un teléfono y no se ve el archivo).
  const [pendingRemoval, setPendingRemoval] = useState<AttachmentRow | null>(null);

  const listQuery = useQuery<unknown>({ queryKey: ['attachments'], queryFn: () => api.get('/attachments') });
  const attachments = useMemo(() => asArray<AttachmentRow>(listQuery.data), [listQuery.data]);

  const upload = async (file: File) => {
    setMessage(null);

    if (file.size > MAX_MB * 1024 * 1024) {
      setMessage({ tone: 'negative', text: `El archivo pesa ${formatSize(file.size)} y el máximo es ${MAX_MB} MB.` });
      return;
    }

    setBusy(true);
    try {
      // Se lee como data URL: el servidor valida el tamaño real y el tipo del
      // contenido, no sólo la extensión del nombre.
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
        reader.readAsDataURL(file);
      });

      const saved = await api.post<AttachmentRow & { deduplicated?: boolean }>('/attachments', {
        entityId,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        contentBase64,
      });

      setMessage({
        tone: saved.deduplicated ? 'warning' : 'positive',
        text: saved.deduplicated
          ? 'Este archivo ya estaba guardado (mismo contenido): no se ha duplicado.'
          : `Guardado «${file.name}». Queda vinculado a la unidad financiera elegida.`,
      });
      await queryClient.invalidateQueries();
      setAbriendo(false);
    } catch (caught) {
      setMessage({ tone: 'negative', text: caught instanceof ApiError ? caught.message : 'No se pudo subir el archivo.' });
    } finally {
      setBusy(false);
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    }
  };

  const download = async (attachment: AttachmentRow) => {
    setMessage(null);
    try {
      const result = await api.get<{ filename: string; mimeType: string; contentBase64: string }>(
        `/attachments/${attachment.id}`,
      );
      const link = document.createElement('a');
      link.href = `data:${result.mimeType};base64,${result.contentBase64}`;
      link.download = result.filename;
      link.click();
    } catch (caught) {
      setMessage({ tone: 'negative', text: caught instanceof ApiError ? caught.message : 'No se pudo descargar el archivo.' });
    }
  };

  const remove = async (attachment: AttachmentRow) => {
    setBusy(true);
    try {
      await api.delete(`/attachments/${attachment.id}`);
      setMessage({
        tone: 'warning',
        text: 'Documento desvinculado. El archivo original se conserva para auditoría: nada se borra de verdad.',
      });
      await queryClient.invalidateQueries();
    } catch (caught) {
      setMessage({ tone: 'negative', text: caught instanceof ApiError ? caught.message : 'No se pudo desvincular.' });
    } finally {
      setBusy(false);
    }
  };

  const entityName = (id: string) => entities.find((entity) => entity.id === id)?.name ?? 'unidad';

  return (
    <div className="space-y-3">
      <PageIntro title="Documentos" purpose="Facturas y comprobantes guardados junto a sus movimientos." />

      {message && !abriendo ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <Card>
        <SectionTitle title="Mis documentos" hint={`${attachments.length} archivo(s)`} />
        {listQuery.isLoading ? <Spinner /> : null}
        {attachments.length === 0 && !listQuery.isLoading ? (
          <EmptyState
            title="Todavía no hay comprobantes"
            hint="Adjuntar el recibo convierte «creo que gasté esto» en un gasto demostrable."
          />
        ) : null}
        <div className="space-y-2">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="flex items-start justify-between gap-2 rounded-lg border border-border-soft p-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">{attachment.filename}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {formatSize(attachment.sizeBytes)} · {formatDateTime(attachment.createdAt)}
                </p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Badge tone="neutral">{entityName(attachment.entityId)}</Badge>
                  <Badge tone="neutral">{attachment.mimeType}</Badge>
                </div>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                <button type="button" className="text-xs text-positive underline" onClick={() => void download(attachment)}>
                  Descargar
                </button>
                <button type="button" className="text-xs text-negative underline" onClick={() => setPendingRemoval(attachment)}>
                  Desvincular
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <ConfirmDialog
        open={pendingRemoval !== null}
        title="¿Desvincular el documento?"
        tone="danger"
        confirmLabel="Sí, desvincular"
        message={
          <>
            <p className="font-medium text-ink">{pendingRemoval?.filename}</p>
            <p className="mt-1">
              Dejará de aparecer en la lista, pero <strong>el archivo se conserva para auditoría</strong>. Esto queda
              registrado en el historial.
            </p>
          </>
        }
        onCancel={() => setPendingRemoval(null)}
        onConfirm={() => {
          const target = pendingRemoval;
          setPendingRemoval(null);
          if (target) {
            void remove(target);
          }
        }}
      />

      {/* Alta del comprobante: hoja inferior que abre el botón flotante. */}
      <Sheet open={abriendo} onClose={() => setAbriendo(false)} title="Adjuntar un comprobante">
        <div className="space-y-3 pb-3">
          {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
          <Select
            label="Unidad financiera"
            value={entityId}
            onChange={setEntityId}
            options={entities.map((entity) => ({ value: entity.id, label: entity.name }))}
          />
          {/* El selector nativo («Choose File / No file chosen») sale en inglés y
              rompe el estilo: va oculto dentro de una etiqueta con el aspecto de un
              botón, así hay UN solo control y se llama como el botón. */}
          <label
            className={`flex h-11 w-full items-center justify-center border border-border-soft bg-surface-2 px-3 text-sm font-medium text-ink transition ${
              busy ? 'pointer-events-none opacity-50' : 'cursor-pointer hover:bg-surface-3'
            }`}
          >
            Elegir foto o PDF
            <input
              ref={inputRef}
              type="file"
              accept="image/*,application/pdf"
              capture="environment"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void upload(file);
                }
              }}
              className="sr-only"
            />
          </label>
          <p className="text-xs text-faint">
            Imagen o PDF, hasta {MAX_MB} MB. En el móvil se abre la cámara. No quedan en ninguna carpeta pública: se
            descargan sólo con permiso sobre la unidad.
          </p>
          {busy ? <Spinner label="Guardando el archivo…" /> : null}
        </div>
      </Sheet>

      {!abriendo ? <Fab label="Adjuntar" onClick={() => setAbriendo(true)} /> : null}
    </div>
  );
}

export { MAX_MB as ATTACHMENT_MAX_MB };
