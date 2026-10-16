/**
 * Utilidades de formato y aritmética monetaria del cliente.
 *
 * REGLA: los importes viajan SIEMPRE como texto decimal ("1250.75") porque el
 * servidor los trata como Decimal. En el cliente se manipulan como texto y sólo
 * se convierten a `number` para MOSTRAR o para gráficas, nunca para decidir un
 * importe que se vaya a guardar.
 */

const MONEY_PATTERN = /^-?\d{1,12}(\.\d{1,2})?$/;

/** ¿El texto es un importe válido con máximo 2 decimales? */
export function isValidMoneyText(value: string): boolean {
  return MONEY_PATTERN.test(value.trim());
}

/**
 * Normaliza lo que el usuario teclea a texto decimal con 2 decimales.
 * Acepta coma decimal (formato español) y espacios.
 */
export function normalizeMoneyInput(value: string): string {
  const cleaned = value.trim().replace(/\s/g, '').replace(',', '.');
  if (cleaned === '') {
    return '';
  }
  if (!/^-?\d*(\.\d*)?$/.test(cleaned)) {
    return '';
  }
  const [integerPart, decimalPart = ''] = cleaned.split('.');
  const safeInteger = integerPart === '' || integerPart === '-' ? `${integerPart}0` : integerPart;
  return `${safeInteger}.${(decimalPart + '00').slice(0, 2)}`;
}

/** Suma exacta de importes en texto decimal (sin errores binarios). */
export function sumMoney(values: string[]): string {
  const totalCents = values.reduce((acc, value) => acc + toCents(value), 0);
  return fromCents(totalCents);
}

export function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const text = typeof value === 'number' ? value.toFixed(2) : String(value).trim();
  const negative = text.startsWith('-');
  const [integerPart, decimalPart = '00'] = text.replace('-', '').split('.');
  const cents = Number(integerPart) * 100 + Number((decimalPart + '00').slice(0, 2));
  return negative ? -cents : cents;
}

export function fromCents(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(Math.round(cents));
  const integerPart = Math.floor(absolute / 100);
  const decimalPart = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${integerPart}.${decimalPart}`;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  DOP: 'RD$',
  USD: 'US$',
  EUR: '€',
};

export function formatMoney(value: string | number | null | undefined, currency = 'DOP'): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency;
  const cents = toCents(value);
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const integerPart = Math.floor(absolute / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decimalPart = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${symbol} ${integerPart}.${decimalPart}`;
}

/** Importe sin símbolo (para tablas compactas). */
export function formatAmount(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  const cents = toCents(value);
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const integerPart = Math.floor(absolute / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decimalPart = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${integerPart}.${decimalPart}`;
}

const DATE_FORMATTER = new Intl.DateTimeFormat('es-DO', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Date de negocio (medianoche UTC) → 'dd/mm/aaaa'. */
export function formatBusinessDate(value: string | Date | null | undefined): string {
  if (!value) {
    return '—';
  }
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return DATE_FORMATTER.format(date);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) {
    return '—';
  }
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return new Intl.DateTimeFormat('es-DO', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** Fecha de negocio de hoy en la zona configurada, como 'YYYY-MM-DD'. */
export function todayBusinessDate(timeZone = 'America/Santo_Domingo'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts;
}

/** Etiquetas legibles para los tipos de movimiento. */
export const TXN_KIND_LABELS: Record<string, string> = {
  INCOME: 'Ingreso',
  EXPENSE: 'Gasto',
  TRANSFER_OUT: 'Transferencia enviada',
  TRANSFER_IN: 'Transferencia recibida',
  OWNER_WITHDRAWAL: 'Retiro del propietario',
  OWNER_CONTRIBUTION: 'Aporte de capital',
  LOAN_DISBURSEMENT: 'Préstamo recibido',
  LOAN_PAYMENT: 'Pago de préstamo',
  CREDIT_CARD_PAYMENT: 'Pago de tarjeta',
  RECEIVABLE_SETTLEMENT: 'Cobro de cuenta por cobrar',
  PAYABLE_SETTLEMENT: 'Pago de cuenta por pagar',
  ADJUSTMENT: 'Ajuste',
};

export function txnKindLabel(kind: string): string {
  return TXN_KIND_LABELS[kind] ?? kind;
}

/** Clase de color según el efecto del movimiento (no según su nombre). */
export function txnKindTone(kind: string): 'positive' | 'negative' | 'neutral' {
  if (kind === 'INCOME' || kind === 'TRANSFER_IN' || kind === 'RECEIVABLE_SETTLEMENT') {
    return 'positive';
  }
  if (kind === 'EXPENSE' || kind === 'TRANSFER_OUT' || kind === 'PAYABLE_SETTLEMENT' || kind === 'LOAN_PAYMENT') {
    return 'negative';
  }
  return 'neutral';
}

export const SEVERITY_LABELS: Record<string, string> = {
  INFO: 'Información',
  WARNING: 'Advertencia',
  CRITICAL: 'Crítico',
};

export const CLOSING_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pendiente',
  IN_PROGRESS: 'En proceso',
  PROVISIONAL: 'Provisional',
  WITH_DIFFERENCES: 'Con diferencias',
  FINALIZED: 'Finalizado',
  REOPENED: 'Reabierto',
  NOT_STARTED: 'Sin cierre',
};
