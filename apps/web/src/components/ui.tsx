import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { IconAlert, IconCheck, IconChevronRight, IconClose, IconEye, IconEyeOff, IconLock } from './icons';

/**
 * SISTEMA DE COMPONENTES DE FINANZA
 * =================================
 * Un solo sitio para todo lo visual. Las pantallas componen con estas piezas y
 * usan los nombres de color del tema (surface, ink, muted, brand…), de modo que
 * el modo claro y el oscuro funcionan igual de bien.
 *
 * Reglas que se respetan en todas las piezas:
 *  · Zona táctil mínima de 44 px de alto en móvil.
 *  · Campos con 16 px de letra (menos provoca zoom automático en iPhone).
 *  · Colores con significado: verde entra, rojo sale, ámbar pendiente.
 *  · Nada de texto cortado: los números se alinean con cifras tabulares.
 */

// ---------------------------------------------------------------------------
// Superficies
// ---------------------------------------------------------------------------

export function Card({
  children,
  className = '',
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section';
}) {
  return (
    <Tag className={`rounded-card border border-border-soft bg-surface p-4 shadow-card ${className}`}>
      {children}
    </Tag>
  );
}

export function SectionTitle({
  title,
  hint,
  right,
}: {
  title: string;
  hint?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-base font-semibold tracking-tight text-ink">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs leading-snug text-muted">{hint}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

export function ListRow({
  title,
  subtitle,
  trailing,
  leading,
  onClick,
  className = '',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  leading?: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const content = (
    <>
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink">{title}</div>
        {subtitle ? <div className="mt-0.5 text-xs text-muted">{subtitle}</div> : null}
      </div>
      {trailing ? <div className="shrink-0 text-right">{trailing}</div> : null}
      {onClick ? <IconChevronRight size={16} className="shrink-0 text-faint" /> : null}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full touch-target items-center gap-3 rounded-xl px-1 py-2 text-left transition active:bg-surface-2 ${className}`}
      >
        {content}
      </button>
    );
  }

  return <div className={`flex w-full items-center gap-3 px-1 py-2 ${className}`}>{content}</div>;
}

// ---------------------------------------------------------------------------
// Dinero
// ---------------------------------------------------------------------------

export type Tone = 'positive' | 'negative' | 'warning' | 'neutral' | 'critical' | 'info';

const TONE_TEXT: Record<Tone, string> = {
  positive: 'text-positive',
  negative: 'text-negative',
  warning: 'text-warning',
  neutral: 'text-ink',
  critical: 'text-negative',
  info: 'text-info',
};

const CURRENCY_SYMBOL: Record<string, string> = { DOP: 'RD$', USD: 'US$', EUR: '€' };

function formatAmountParts(value: string, currency: string) {
  const negative = value.startsWith('-');
  const absolute = negative ? value.slice(1) : value;
  const [integerPart, decimalPart = '00'] = absolute.split('.');
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return { negative, integer: grouped, decimals: decimalPart, symbol: CURRENCY_SYMBOL[currency] ?? currency };
}

export function Money({
  value,
  currency = 'DOP',
  tone = 'neutral',
  className = '',
}: {
  value: string | null | undefined;
  currency?: string;
  tone?: Tone;
  className?: string;
}) {
  if (value === null || value === undefined || value === '') {
    return <span className={`money ${TONE_TEXT.neutral} ${className}`}>—</span>;
  }
  const { negative, integer, decimals, symbol } = formatAmountParts(value, currency);
  return (
    <span className={`money whitespace-nowrap ${TONE_TEXT[tone]} ${className}`}>
      {negative ? '-' : ''}
      {symbol} {integer}.{decimals}
    </span>
  );
}

/**
 * Importe protagonista: el número más grande de la pantalla.
 * Se usa para el «dinero disponible», que es la pregunta principal del usuario.
 */
export function AmountDisplay({
  value,
  currency = 'DOP',
  label,
  hint,
  tone = 'neutral',
  size = 'hero',
}: {
  value: string | null | undefined;
  currency?: string;
  label?: string;
  hint?: string;
  tone?: Tone;
  size?: 'hero' | 'large' | 'medium';
}) {
  const sizes = {
    hero: 'text-[2.1rem] leading-none font-semibold',
    large: 'text-2xl font-semibold',
    medium: 'text-lg font-semibold',
  } as const;

  if (value === null || value === undefined || value === '') {
    return (
      <div>
        {label ? <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p> : null}
        <p className={`money mt-1 ${sizes[size]} text-faint`}>— sin datos —</p>
        {hint ? <p className="mt-1 text-xs text-faint">{hint}</p> : null}
      </div>
    );
  }

  const { negative, integer, decimals, symbol } = formatAmountParts(value, currency);
  return (
    <div>
      {label ? <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p> : null}
      <p className={`money mt-1 flex items-baseline gap-1.5 ${sizes[size]} ${TONE_TEXT[tone]}`}>
        <span className="text-[0.6em] font-medium opacity-70">{symbol}</span>
        <span>
          {negative ? '-' : ''}
          {integer}
          <span className="text-[0.62em] font-medium opacity-80">.{decimals}</span>
        </span>
      </p>
      {hint ? <p className="mt-1 text-xs leading-snug text-faint">{hint}</p> : null}
    </div>
  );
}

export function Kpi({
  label,
  value,
  hint,
  tone = 'neutral',
  currency,
}: {
  label: string;
  value: string | null;
  hint?: string;
  tone?: Tone;
  currency?: string;
}) {
  return (
    <div className="rounded-xl border border-border-soft bg-surface p-3">
      <p className="text-[0.7rem] font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1">
        <Money value={value} tone={tone} currency={currency} className="text-lg font-semibold" />
      </p>
      {hint ? <p className="mt-1 text-[0.7rem] leading-snug text-faint">{hint}</p> : null}
    </div>
  );
}

export function ProgressBar({
  percent,
  tone = 'positive',
  className = '',
}: {
  percent: number;
  tone?: Tone;
  className?: string;
}) {
  const colors: Record<Tone, string> = {
    positive: 'bg-positive',
    negative: 'bg-negative',
    warning: 'bg-warning',
    neutral: 'bg-brand',
    critical: 'bg-negative',
    info: 'bg-info',
  };
  return (
    <div className={`h-2 w-full overflow-hidden rounded-full bg-surface-3 ${className}`}>
      <div
        className={`h-full rounded-full transition-[width] duration-300 ${colors[tone]}`}
        style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Etiquetas y estado
// ---------------------------------------------------------------------------

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  const classes: Record<Tone, string> = {
    positive: 'bg-positive/12 text-positive border-positive/30',
    negative: 'bg-negative/12 text-negative border-negative/30',
    warning: 'bg-warning/12 text-warning border-warning/30',
    neutral: 'bg-surface-3 text-muted border-border-soft',
    critical: 'bg-negative/20 text-negative border-negative/40',
    info: 'bg-info/12 text-info border-info/30',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.7rem] font-medium ${classes[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatusDot({ tone }: { tone: Tone }) {
  const colors: Record<Tone, string> = {
    positive: 'bg-positive',
    negative: 'bg-negative',
    warning: 'bg-warning',
    neutral: 'bg-faint',
    critical: 'bg-negative',
    info: 'bg-info',
  };
  return <span className={`inline-block h-2 w-2 rounded-full ${colors[tone]}`} aria-hidden="true" />;
}

// ---------------------------------------------------------------------------
// Botones
// ---------------------------------------------------------------------------

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  disabled = false,
  className = '',
  title,
  fullWidth = false,
  size = 'md',
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  className?: string;
  title?: string;
  fullWidth?: boolean;
  size?: 'sm' | 'md' | 'lg';
}) {
  const variants = {
    primary: 'bg-brand text-white hover:bg-brand-strong active:bg-brand-strong',
    secondary: 'bg-surface-3 text-ink hover:bg-surface-2 border border-border-soft',
    danger: 'bg-negative/90 text-white hover:bg-negative',
    ghost: 'bg-transparent text-muted hover:bg-surface-2 hover:text-ink',
  } as const;

  const sizes = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2.5 text-sm',
    lg: 'px-5 py-3 text-base',
  } as const;

  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex touch-target items-center justify-center gap-2 rounded-xl font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${fullWidth ? 'w-full' : ''} ${className}`}
    >
      {children}
    </button>
  );
}

export function IconButton({
  children,
  onClick,
  label,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`inline-flex h-11 w-11 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink ${className}`}
    >
      {children}
    </button>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className = '',
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={`flex gap-1 overflow-x-auto rounded-xl border border-border-soft bg-surface p-1 ${className}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
            value === option.value ? 'bg-brand text-white' : 'text-muted hover:bg-surface-2 hover:text-ink'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formularios
// ---------------------------------------------------------------------------

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  hint,
  autoComplete,
  enterKeyHint,
  inputMode,
  required,
  error,
  onEnter,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
  autoComplete?: string;
  enterKeyHint?: 'enter' | 'done' | 'next' | 'search' | 'go';
  inputMode?: 'text' | 'email' | 'numeric' | 'decimal' | 'tel' | 'url' | 'search';
  required?: boolean;
  /** Mensaje de validación: si existe, el campo se marca en rojo y se anuncia. */
  error?: string;
  onEnter?: () => void;
}) {
  // La pista y el error NO forman parte del nombre del campo: se asocian con
  // `aria-describedby`. Así el lector de pantalla dice «Descripción» y, aparte,
  // lee la explicación, en vez de leerlo todo junto como si fuera el nombre.
  const inputId = useId();
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className="block">
      <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={inputId}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={
          onEnter
            ? (event) => {
                if (event.key === 'Enter') {
                  onEnter();
                }
              }
            : undefined
        }
        placeholder={placeholder}
        autoComplete={autoComplete}
        enterKeyHint={enterKeyHint}
        inputMode={inputMode}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`w-full rounded-xl border bg-surface-2 px-3 py-2.5 text-ink outline-none transition placeholder:text-faint focus:border-brand ${
          error ? 'border-negative' : 'border-border-soft'
        }`}
      />
      {error ? (
        <span id={`${inputId}-error`} className="mt-1 block text-xs text-negative">
          {error}
        </span>
      ) : null}
      {hint ? (
        <span id={`${inputId}-hint`} className="mt-1 block text-xs text-faint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Campo de contraseña con botón para mostrarla.
 * Ver la contraseña que uno escribe en una calle es una diferencia real entre
 * escribirla bien y rendirse.
 *
 * El botón de mostrar/ocultar está FUERA de la etiqueta: un botón dentro de un
 * `<label>` no es HTML válido y además contamina el nombre accesible del campo
 * (los lectores de pantalla leerían «Contraseña mostrar contraseña»).
 */
export function PasswordField({
  label,
  value,
  onChange,
  autoComplete = 'current-password',
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  hint?: string;
}) {
  const [visible, setVisible] = useState(false);
  const inputId = useId();

  return (
    <div className="block">
      <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-ink">
        {label}
      </label>
      <span className="relative block">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint">
          <IconLock size={18} />
        </span>
        <input
          id={inputId}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          enterKeyHint="go"
          className="w-full rounded-xl border border-border-soft bg-surface-2 py-2.5 pl-10 pr-12 text-ink outline-none transition focus:border-brand"
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-faint transition hover:text-ink"
        >
          {visible ? <IconEyeOff size={18} /> : <IconEye size={18} />}
        </button>
      </span>
      {hint ? <span className="mt-1 block text-xs text-faint">{hint}</span> : null}
    </div>
  );
}

export function Select({
  label,
  value,
  onChange,
  options = [],
  groups,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options?: Array<{ value: string; label: string }>;
  groups?: Array<{ label: string; options: Array<{ value: string; label: string }> }>;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full appearance-none rounded-xl border border-border-soft bg-surface-2 px-3 py-2.5 text-ink outline-none transition focus:border-brand"
      >
        <option value="">{placeholder ?? '— Seleccione —'}</option>
        {groups
          ? groups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))
          : options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
      </select>
      {hint ? <span className="mt-1 block text-xs text-faint">{hint}</span> : null}
    </label>
  );
}

/**
 * Campo de importe.
 * Sólo acepta dígitos y hasta 2 decimales: así el servidor recibe SIEMPRE texto
 * decimal válido y no hay sorpresas al guardar. Usa teclado numérico y admite
 * coma decimal (formato español).
 */
export function MoneyInput({
  value,
  onChange,
  label,
  autoFocus = false,
  hint,
  size = 'lg',
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  autoFocus?: boolean;
  hint?: string;
  size?: 'lg' | 'md';
}) {
  const handleChange = (raw: string) => {
    const cleaned = raw.replace(/[^\d.,]/g, '');
    const normalized = cleaned.replace(',', '.');
    const [integerPart, ...rest] = normalized.split('.');
    const decimals = rest.join('').slice(0, 2);
    onChange(rest.length > 0 ? `${integerPart}.${decimals}` : integerPart);
  };

  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-faint">
          RD$
        </span>
        <input
          // El enfoque automático del importe es intencionado: al abrir «Registrar»
          // el usuario quiere escribir la cifra ya, sin un toque extra en el móvil.
          autoFocus={autoFocus}
          value={value}
          onChange={(event) => handleChange(event.target.value)}
          inputMode="decimal"
          enterKeyHint="done"
          autoComplete="off"
          placeholder="0.00"
          aria-label={label}
          className={`money w-full rounded-xl border border-border-soft bg-surface-2 py-3 pl-12 pr-3 font-semibold text-ink outline-none transition placeholder:text-faint focus:border-brand ${
            size === 'lg' ? 'text-3xl' : 'text-xl'
          }`}
        />
      </div>
      {hint ? <span className="mt-1 block text-xs text-faint">{hint}</span> : null}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Estados: cargando, vacío, error
// ---------------------------------------------------------------------------

export function Spinner({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted" role="status">
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-border-strong border-t-brand" />
      {label}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-surface-2 ${className}`} />;
}

export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-16" />
      ))}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border-strong bg-surface/50 p-6 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint ? <p className="mx-auto mt-1 max-w-xs text-xs leading-snug text-muted">{hint}</p> : null}
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = 'No se pudo cargar',
  message,
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-xl border border-negative/40 bg-negative/10 p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-negative">
        <IconAlert size={18} />
        {title}
      </p>
      {message ? <p className="mt-1 text-xs leading-snug text-ink/80">{message}</p> : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          Reintentar
        </Button>
      ) : null}
    </div>
  );
}

export function Notice({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  const classes: Record<Tone, string> = {
    positive: 'border-positive/40 bg-positive/10 text-ink',
    negative: 'border-negative/40 bg-negative/10 text-ink',
    warning: 'border-warning/40 bg-warning/10 text-ink',
    neutral: 'border-border-soft bg-surface-2 text-ink',
    critical: 'border-negative/50 bg-negative/15 text-ink',
    info: 'border-info/40 bg-info/10 text-ink',
  };

  return (
    <div className={`rounded-xl border p-3 text-sm leading-snug ${classes[tone]}`}>
      {title ? <p className="font-semibold">{title}</p> : null}
      <div className={title ? 'mt-1' : ''}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Navegación por pestañas
// ---------------------------------------------------------------------------

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex gap-1 overflow-x-auto rounded-xl border border-border-soft bg-surface p-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          aria-pressed={active === tab.id}
          className={`touch-target whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
            active === tab.id ? 'bg-brand text-white' : 'text-muted hover:bg-surface-2 hover:text-ink'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Capas: hoja inferior y diálogo de confirmación
// ---------------------------------------------------------------------------

/**
 * Hoja inferior (bottom sheet): el patrón natural en móvil para acciones cortas.
 * Se cierra al tocar fuera y con la tecla Escape, y respeta el área segura.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // El título da NOMBRE al diálogo. Sin esto, un lector de pantalla anuncia
  // «diálogo» y nada más: quien no ve la pantalla no sabe qué se le está
  // preguntando. También permite dirigirse a él por su nombre en las pruebas.
  const titleId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    // Se bloquea el scroll del fondo mientras la hoja está abierta.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
    >
      {/* El fondo se puede tocar para cerrar, y por eso lleva su propio nombre:
          dos controles distintos no deben llamarse igual («Cerrar»). */}
      <button
        type="button"
        aria-label="Cerrar ventana emergente"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
      />
      <div
        ref={ref}
        className="relative w-full max-w-lg animate-rise rounded-t-sheet border border-border-soft bg-bg-elevated pb-[calc(var(--safe-bottom)+1rem)] shadow-elevated"
      >
        <div className="flex items-center justify-between px-5 pt-4">
          <p id={titleId} className="text-base font-semibold text-ink">
            {title}
          </p>
          <IconButton label="Cerrar" onClick={onClose}>
            <IconClose size={20} />
          </IconButton>
        </div>
        <div className="px-5 pt-2">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  tone = 'primary',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();

  if (!open) {
    return null;
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-5"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <button
        type="button"
        aria-label="Descartar aviso y cancelar"
        onClick={onCancel}
        className="absolute inset-0 bg-black/60"
      />
      <div className="relative w-full max-w-sm animate-pop rounded-card border border-border-soft bg-bg-elevated p-5 shadow-elevated">
        <p id={titleId} className="text-base font-semibold text-ink">
          {title}
        </p>
        <div className="mt-2 text-sm leading-snug text-muted">{message}</div>
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Confirmación de éxito breve, sin diálogo. */
export function SuccessMark({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-sm font-medium text-positive">
      <IconCheck size={18} />
      {label}
    </p>
  );
}
