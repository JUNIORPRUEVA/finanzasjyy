import { useEffect, useState } from 'react';
import { IconAlert, IconCheck, IconClose } from './icons';

/**
 * AVISOS BREVES (TOASTS)
 * ----------------------
 * Mensajes que aparecen un momento y se van solos. Sirven para confirmar algo
 * («Traspaso registrado») o avisar de un problema sin interrumpir el trabajo.
 *
 * Se implementa con un pequeño bus de eventos para no obligar a envolver toda
 * la aplicación en otro contexto más.
 */

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface ToastMessage {
  id: string;
  tone: ToastTone;
  text: string;
  /** Texto secundario opcional (por ejemplo, el motivo del error). */
  detail?: string;
}

type Listener = (toasts: ToastMessage[]) => void;

let toasts: ToastMessage[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) {
    listener([...toasts]);
  }
}

function push(tone: ToastTone, text: string, detail?: string): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  toasts = [...toasts.slice(-2), { id, tone, text, detail }];
  emit();

  // Se retiran solos: 5 s para los errores (hay que leerlos) y 3,5 s para el resto.
  const lifetime = tone === 'error' ? 5_000 : 3_500;
  setTimeout(() => {
    toasts = toasts.filter((toast) => toast.id !== id);
    emit();
  }, lifetime);

  return id;
}

export const toast = {
  success: (text: string, detail?: string) => push('success', text, detail),
  error: (text: string, detail?: string) => push('error', text, detail),
  warning: (text: string, detail?: string) => push('warning', text, detail),
  info: (text: string, detail?: string) => push('info', text, detail),
  dismiss: (id: string) => {
    toasts = toasts.filter((toastMessage) => toastMessage.id !== id);
    emit();
  },
};

const TONE_STYLES: Record<ToastTone, string> = {
  success: 'border-positive/40 bg-positive/15',
  error: 'border-negative/40 bg-negative/15',
  warning: 'border-warning/40 bg-warning/15',
  info: 'border-info/40 bg-info/15',
};

const TONE_TEXT: Record<ToastTone, string> = {
  success: 'text-positive',
  error: 'text-negative',
  warning: 'text-warning',
  info: 'text-info',
};

export function ToastHost() {
  const [messages, setMessages] = useState<ToastMessage[]>([]);

  useEffect(() => {
    const listener: Listener = (next) => setMessages(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (messages.length === 0) {
    return null;
  }

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-3 pt-[calc(var(--safe-top)+0.75rem)]"
      role="status"
      aria-live="polite"
    >
      {messages.map((message) => (
        <div
          key={message.id}
          className={`pointer-events-auto flex w-full max-w-md animate-rise items-start gap-2 rounded-xl border p-3 shadow-elevated backdrop-blur ${TONE_STYLES[message.tone]}`}
        >
          <span className={`mt-0.5 shrink-0 ${TONE_TEXT[message.tone]}`}>
            {message.tone === 'success' ? <IconCheck size={18} /> : <IconAlert size={18} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium leading-snug text-ink">{message.text}</p>
            {message.detail ? <p className="mt-0.5 text-xs leading-snug text-muted">{message.detail}</p> : null}
          </div>
          <button
            type="button"
            aria-label="Cerrar aviso"
            onClick={() => toast.dismiss(message.id)}
            className="shrink-0 text-faint transition hover:text-ink"
          >
            <IconClose size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
