import type { ReactNode } from 'react';

/**
 * COMPONENTES BÁSICOS DE LA INTERFAZ
 * ---------------------------------
 * El usuario pidió una app que pueda usar alguien SIN formación contable:
 * por eso los números son grandes, los colores significan algo concreto y los
 * avisos explican siempre QUÉ pasa y QUÉ hacer.
 */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-slate-800 bg-slate-900/70 p-4 ${className}`}>{children}</div>;
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
    <div className="mb-3 flex items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs text-slate-400">{hint}</p> : null}
      </div>
      {right}
    </div>
  );
}

export type Tone = 'positive' | 'negative' | 'warning' | 'neutral' | 'critical';

const TONE_CLASSES: Record<Tone, string> = {
  positive: 'text-emerald-400',
  negative: 'text-rose-400',
  warning: 'text-amber-300',
  neutral: 'text-slate-200',
  critical: 'text-rose-300',
};

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
  const symbols: Record<string, string> = { DOP: 'RD$', USD: 'US$', EUR: '€' };
  const symbol = symbols[currency] ?? currency;

  if (value === null || value === undefined || value === '') {
    return <span className={`money ${TONE_CLASSES.neutral} ${className}`}>—</span>;
  }

  const negative = value.startsWith('-');
  const absolute = negative ? value.slice(1) : value;
  const [integerPart, decimalPart = '00'] = absolute.split('.');
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return (
    <span className={`money ${TONE_CLASSES[tone]} ${className}`}>
      {negative ? '-' : ''}
      {symbol} {grouped}.{decimalPart}
    </span>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  const classes: Record<Tone, string> = {
    positive: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    negative: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    warning: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
    neutral: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    critical: 'bg-rose-600/20 text-rose-200 border-rose-500/40',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${classes[tone]}`}>
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  disabled = false,
  className = '',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const variants = {
    primary: 'bg-emerald-600 text-white hover:bg-emerald-500 disabled:bg-emerald-900',
    secondary: 'bg-slate-800 text-slate-100 hover:bg-slate-700 disabled:bg-slate-900',
    danger: 'bg-rose-700 text-white hover:bg-rose-600 disabled:bg-rose-950',
    ghost: 'bg-transparent text-slate-300 hover:bg-slate-800',
  } as const;

  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * Campo de importe.
 * Sólo acepta dígitos y hasta 2 decimales: así el servidor recibe SIEMPRE un
 * texto decimal válido y no hay sorpresas al guardar.
 */
export function MoneyInput({
  value,
  onChange,
  label,
  autoFocus = false,
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  autoFocus?: boolean;
  hint?: string;
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
      <span className="mb-1 block text-sm font-medium text-slate-300">{label}</span>
      <input
        // El enfoque automático del importe es intencionado: al abrir «Registrar»
        // el usuario quiere escribir la cifra ya, y se evita un toque extra en el
        // móvil (el objetivo de la pantalla es anotar un movimiento en segundos).
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        inputMode="decimal"
        placeholder="0.00"
        aria-label={label}
        className="money w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 text-2xl font-semibold text-slate-100 outline-none focus:border-emerald-500"
      />
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
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
    <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-semibold">
        <Money value={value} tone={tone} currency={currency} />
      </p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function Spinner({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-emerald-400" />
      {label}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-700 p-6 text-center">
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
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
    positive: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100',
    negative: 'border-rose-500/40 bg-rose-500/10 text-rose-100',
    warning: 'border-amber-500/40 bg-amber-500/10 text-amber-100',
    neutral: 'border-slate-600/50 bg-slate-800/40 text-slate-200',
    critical: 'border-rose-500/50 bg-rose-600/15 text-rose-100',
  };

  return (
    <div className={`rounded-lg border p-3 text-sm ${classes[tone]}`}>
      {title ? <p className="font-semibold">{title}</p> : null}
      <div className={title ? 'mt-1' : ''}>{children}</div>
    </div>
  );
}

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
    <div className="flex gap-1 overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/60 p-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition ${
            active === tab.id ? 'bg-emerald-600 text-white' : 'text-slate-300 hover:bg-slate-800'
          }`}
        >
          {tab.label}
        </button>
      ))}
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
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options?: Array<{ value: string; label: string }>;
  /** Opciones agrupadas (por ejemplo, cuentas por unidad financiera). */
  groups?: Array<{ label: string; options: Array<{ value: string; label: string }> }>;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-300">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500"
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
    </label>
  );
}

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-300">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500"
      />
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}
