import { CategoryKind } from '../generated/prisma/enums.js';
import { LEDGER } from './chart-of-accounts.js';

/**
 * CATEGORÍAS POR DEFECTO (globales: entityId = null).
 * Son editables por el usuario y cada una apunta a la cuenta contable que
 * corresponde, de modo que registrar un gasto en "Combustible" alimenta la
 * cuenta 6350 y no "Otros gastos".
 */
export interface CategorySeed {
  name: string;
  kind: CategoryKind;
  defaultLedgerCode: string;
  /** Nombre corto usado en el móvil para registrar en dos toques. */
  color?: string;
}

export const DEFAULT_CATEGORIES: CategorySeed[] = [
  // --------------------------- INGRESOS ---------------------------
  { name: 'Ventas de mercancía', kind: 'INCOME', defaultLedgerCode: LEDGER.SALES_INCOME },
  { name: 'Servicios prestados', kind: 'INCOME', defaultLedgerCode: LEDGER.SERVICE_INCOME },
  { name: 'Licencias y suscripciones', kind: 'INCOME', defaultLedgerCode: LEDGER.SUBSCRIPTION_INCOME },
  { name: 'Ventas de POS / FullPOS', kind: 'INCOME', defaultLedgerCode: LEDGER.SUBSCRIPTION_INCOME },
  { name: 'Alquileres cobrados', kind: 'INCOME', defaultLedgerCode: LEDGER.RENTAL_INCOME },
  { name: 'Comisiones ganadas', kind: 'INCOME', defaultLedgerCode: '4500' },
  { name: 'Intereses ganados', kind: 'INCOME', defaultLedgerCode: LEDGER.INTEREST_INCOME },
  { name: 'Otros ingresos', kind: 'INCOME', defaultLedgerCode: LEDGER.OTHER_INCOME },

  // ---------------------------- GASTOS ----------------------------
  { name: 'Costo de mercancía', kind: 'EXPENSE', defaultLedgerCode: LEDGER.COGS },
  { name: 'Compras de inventario', kind: 'EXPENSE', defaultLedgerCode: LEDGER.MERCHANDISE_PURCHASES },
  { name: 'Nómina', kind: 'EXPENSE', defaultLedgerCode: LEDGER.PAYROLL },
  { name: 'Seguridad social', kind: 'EXPENSE', defaultLedgerCode: '6110' },
  { name: 'Alquiler', kind: 'EXPENSE', defaultLedgerCode: LEDGER.RENT },
  { name: 'Publicidad', kind: 'EXPENSE', defaultLedgerCode: LEDGER.ADVERTISING },
  { name: 'Combustible', kind: 'EXPENSE', defaultLedgerCode: LEDGER.FUEL },
  { name: 'Transporte y delivery', kind: 'EXPENSE', defaultLedgerCode: LEDGER.DELIVERY },
  { name: 'Energía eléctrica', kind: 'EXPENSE', defaultLedgerCode: LEDGER.ELECTRICITY },
  { name: 'Agua', kind: 'EXPENSE', defaultLedgerCode: LEDGER.WATER },
  { name: 'Internet y telefonía', kind: 'EXPENSE', defaultLedgerCode: LEDGER.INTERNET },
  { name: 'Tecnología y software', kind: 'EXPENSE', defaultLedgerCode: LEDGER.TECHNOLOGY },
  { name: 'Mantenimiento', kind: 'EXPENSE', defaultLedgerCode: LEDGER.MAINTENANCE },
  { name: 'Suministros de oficina', kind: 'EXPENSE', defaultLedgerCode: LEDGER.SUPPLIES },
  { name: 'Servicios profesionales', kind: 'EXPENSE', defaultLedgerCode: LEDGER.PROFESSIONAL_SERVICES },
  { name: 'Alimentación', kind: 'EXPENSE', defaultLedgerCode: LEDGER.FOOD },
  { name: 'Aseo y limpieza', kind: 'EXPENSE', defaultLedgerCode: '6950' },
  { name: 'Seguros', kind: 'EXPENSE', defaultLedgerCode: '6960' },
  { name: 'Impuestos y tasas', kind: 'EXPENSE', defaultLedgerCode: '6970' },
  { name: 'Gastos de representación', kind: 'EXPENSE', defaultLedgerCode: '6980' },
  { name: 'Intereses pagados', kind: 'EXPENSE', defaultLedgerCode: LEDGER.INTEREST_EXPENSE },
  { name: 'Comisiones bancarias', kind: 'EXPENSE', defaultLedgerCode: LEDGER.BANK_FEES },
  { name: 'Mora y recargos', kind: 'EXPENSE', defaultLedgerCode: LEDGER.PENALTIES },
  { name: 'Otros gastos', kind: 'EXPENSE', defaultLedgerCode: LEDGER.OTHER_OPERATING_EXPENSE },
];

/** Métodos de cobro/pago reconocidos (texto libre, pero estos son los sugeridos). */
export const PAYMENT_METHODS = [
  'EFECTIVO',
  'TRANSFERENCIA',
  'TARJETA',
  'BIZUM',
  'CHEQUE',
  'DEPOSITO',
  'CREDITO',
  'OTRO',
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * UNIDADES FINANCIERAS INICIALES.
 * Se crean SIN saldos ni movimientos: el usuario introduce sus cifras reales.
 * (El spec prohíbe inventar importes y presentarlos como reales.)
 */
export const INITIAL_ENTITIES = [
  {
    code: 'FULLTECH',
    name: 'FULLTECH',
    type: 'BUSINESS' as const,
    description: 'Operaciones comerciales y servicios tecnológicos.',
  },
  {
    code: 'PHYTOEMAGRY',
    name: 'PHYTOEMAGRY',
    type: 'BUSINESS' as const,
    description: 'Comercialización y distribución de productos.',
  },
  {
    code: 'FULLPOS_CLOUD',
    name: 'FULLPOS CLOUD',
    type: 'BUSINESS' as const,
    description: 'Software de punto de venta y licencias.',
  },
  {
    code: 'PERSONAL',
    name: 'FINANZAS PERSONALES',
    type: 'PERSONAL' as const,
    description: 'Ingresos, gastos y obligaciones personales.',
  },
];
