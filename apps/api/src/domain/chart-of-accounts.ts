import { LedgerAccountType, NormalBalance } from '../generated/prisma/enums.js';

/**
 * CATÁLOGO CONTABLE DE FINANZA
 * ----------------------------
 * Se siembra UNA vez y es compartido por todas las unidades financieras, para
 * que los reportes consolidados sumen cuentas homogéneas. Cada asiento se
 * atribuye además a una unidad financiera, y los saldos se calculan por la
 * pareja (unidad financiera, cuenta contable).
 *
 * Códigos reservados:
 *   1150 CUENTAS INTERCOMPANIA — cuenta puente obligatoria en las transferencias
 *        entre unidades financieras distintas. Hace que la consolidación de
 *        resultados nunca cuente una transferencia interna como ingreso.
 *   3200 RETIROS DEL PROPIETARIO — separa el dinero que el dueño saca de un
 *        negocio de un gasto operativo del negocio.
 *   8000/8010 DIFERENCIAS DE CAJA — las diferencias del cierre diario tienen su
 *        propia cuenta: no se disfrazan de gasto operativo.
 */
export interface ChartAccountSeed {
  code: string;
  name: string;
  type: LedgerAccountType;
  normalBalance: NormalBalance;
  isPostable?: boolean;
  description?: string;
}

export const CHART_OF_ACCOUNTS: ChartAccountSeed[] = [
  // ---------------------------- ACTIVO ----------------------------
  { code: '1000', name: 'Efectivo y equivalentes', type: 'ASSET', normalBalance: 'DEBIT', isPostable: false },
  { code: '1010', name: 'Caja general', type: 'ASSET', normalBalance: 'DEBIT' },
  { code: '1020', name: 'Caja de negocio', type: 'ASSET', normalBalance: 'DEBIT' },
  { code: '1100', name: 'Bancos', type: 'ASSET', normalBalance: 'DEBIT' },
  { code: '1101', name: 'Cuenta corriente', type: 'ASSET', normalBalance: 'DEBIT' },
  { code: '1102', name: 'Cuenta de ahorro', type: 'ASSET', normalBalance: 'DEBIT' },
  { code: '1110', name: 'Billeteras digitales', type: 'ASSET', normalBalance: 'DEBIT' },
  { code: '1120', name: 'Procesador de pagos / adquirente', type: 'ASSET', normalBalance: 'DEBIT' },
  {
    code: '1130',
    name: 'Efectivo de la empresa en poder del propietario',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    description:
      'Dinero de la empresa que está físicamente en una cuenta personal del propietario, pendiente de liquidar. Enfrente está la 2150 de la unidad que lo custodia.',
  },
  {
    code: '1150',
    name: 'Cuentas intercompañía (transferencias internas)',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    description:
      'Cuenta puente para transferencias entre unidades financieras distintas. Debe quedar en cero al consolidar.',
  },
  { code: '1200', name: 'Cuentas por cobrar', type: 'ASSET', normalBalance: 'DEBIT' },
  { code: '1210', name: 'Cuentas por cobrar a clientes', type: 'ASSET', normalBalance: 'DEBIT' },
  { code: '1250', name: 'Préstamos otorgados', type: 'ASSET', normalBalance: 'DEBIT' },
  { code: '1300', name: 'Inventario de mercancía', type: 'ASSET', normalBalance: 'DEBIT' },
  { code: '1400', name: 'Activos fijos', type: 'ASSET', normalBalance: 'DEBIT' },
  { code: '1410', name: 'Equipos y tecnología', type: 'ASSET', normalBalance: 'DEBIT' },
  { code: '1420', name: 'Vehículos', type: 'ASSET', normalBalance: 'DEBIT' },
  { code: '1500', name: 'Depósitos y anticipos entregados', type: 'ASSET', normalBalance: 'DEBIT' },

  // ---------------------------- PASIVO ----------------------------
  { code: '2000', name: 'Pasivos', type: 'LIABILITY', normalBalance: 'CREDIT', isPostable: false },
  { code: '2100', name: 'Cuentas por pagar a proveedores', type: 'LIABILITY', normalBalance: 'CREDIT' },
  { code: '2200', name: 'Préstamos por pagar', type: 'LIABILITY', normalBalance: 'CREDIT' },
  { code: '2201', name: 'Préstamos bancarios por pagar', type: 'LIABILITY', normalBalance: 'CREDIT' },
  { code: '2202', name: 'Préstamos personales por pagar', type: 'LIABILITY', normalBalance: 'CREDIT' },
  { code: '2210', name: 'Tarjetas de crédito por pagar', type: 'LIABILITY', normalBalance: 'CREDIT' },
  {
    code: '2150',
    name: 'Fondos de empresas bajo custodia (por liquidar)',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    description:
      'En la unidad que CUSTODIA: dinero que está en su cuenta pero pertenece a otra empresa. Sube al recibir el cobro y baja al liquidarlo o al pagar un gasto de esa empresa.',
  },
  {
    code: '2350',
    name: 'Deuda con el propietario (reembolso por pagar)',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    description:
      'Gastos de una empresa pagados con dinero propio del propietario. No son fondos en custodia: la empresa le debe el reembolso.',
  },
  { code: '2300', name: 'Impuestos por pagar', type: 'LIABILITY', normalBalance: 'CREDIT' },
  { code: '2400', name: 'Obligaciones recurrentes por pagar', type: 'LIABILITY', normalBalance: 'CREDIT' },
  { code: '2500', name: 'Nómina por pagar', type: 'LIABILITY', normalBalance: 'CREDIT' },
  { code: '2600', name: 'Anticipos de clientes', type: 'LIABILITY', normalBalance: 'CREDIT' },

  // --------------------------- PATRIMONIO -------------------------
  { code: '3000', name: 'Patrimonio', type: 'EQUITY', normalBalance: 'CREDIT', isPostable: false },
  { code: '3100', name: 'Aportes de capital', type: 'EQUITY', normalBalance: 'CREDIT' },
  { code: '3200', name: 'Retiros del propietario', type: 'EQUITY', normalBalance: 'DEBIT' },
  { code: '3300', name: 'Resultados acumulados', type: 'EQUITY', normalBalance: 'CREDIT' },
  { code: '3400', name: 'Saldo de apertura', type: 'EQUITY', normalBalance: 'CREDIT' },

  // ---------------------------- INGRESOS --------------------------
  { code: '4000', name: 'Ingresos operativos', type: 'INCOME', normalBalance: 'CREDIT', isPostable: false },
  { code: '4100', name: 'Ingresos por ventas', type: 'INCOME', normalBalance: 'CREDIT' },
  { code: '4200', name: 'Ingresos por servicios', type: 'INCOME', normalBalance: 'CREDIT' },
  { code: '4300', name: 'Ingresos por licencias y suscripciones', type: 'INCOME', normalBalance: 'CREDIT' },
  { code: '4400', name: 'Ingresos por alquileres', type: 'INCOME', normalBalance: 'CREDIT' },
  { code: '4500', name: 'Comisiones ganadas', type: 'INCOME', normalBalance: 'CREDIT' },
  { code: '4900', name: 'Otros ingresos', type: 'INCOME', normalBalance: 'CREDIT' },
  { code: '4910', name: 'Intereses ganados', type: 'INCOME', normalBalance: 'CREDIT' },
  { code: '4920', name: 'Sobrantes de caja', type: 'INCOME', normalBalance: 'CREDIT' },
  { code: '4990', name: 'Otros ingresos no operativos', type: 'INCOME', normalBalance: 'CREDIT' },

  // ----------------------------- COSTOS ---------------------------
  { code: '5000', name: 'Costo de mercancía vendida', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '5100', name: 'Compras para reventa', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '5200', name: 'Fletes y transporte de mercancía', type: 'EXPENSE', normalBalance: 'DEBIT' },

  // ---------------------------- GASTOS ----------------------------
  { code: '6000', name: 'Gastos operativos', type: 'EXPENSE', normalBalance: 'DEBIT', isPostable: false },
  { code: '6100', name: 'Nómina y salarios', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6110', name: 'Seguridad social y prestaciones', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6200', name: 'Alquiler de locales', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6300', name: 'Publicidad y promoción', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6350', name: 'Combustible', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6360', name: 'Transporte y delivery', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6400', name: 'Energía eléctrica', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6410', name: 'Agua potable', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6420', name: 'Internet y telecomunicaciones', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6500', name: 'Software y servicios tecnológicos', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6600', name: 'Mantenimiento y reparaciones', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6700', name: 'Suministros y materiales de oficina', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6800', name: 'Servicios profesionales', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6900', name: 'Alimentación', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6950', name: 'Aseo y limpieza', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6960', name: 'Seguros', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6970', name: 'Impuestos y tasas', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6980', name: 'Gastos de representación', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '6990', name: 'Otros gastos operativos', type: 'EXPENSE', normalBalance: 'DEBIT' },

  // ------------------- GASTOS FINANCIEROS Y DIFERENCIAS -----------
  { code: '7000', name: 'Gastos financieros', type: 'EXPENSE', normalBalance: 'DEBIT', isPostable: false },
  { code: '7100', name: 'Intereses pagados', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '7110', name: 'Comisiones bancarias', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '7120', name: 'Mora y recargos', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '8000', name: 'Diferencias de caja', type: 'EXPENSE', normalBalance: 'DEBIT', isPostable: false },
  { code: '8010', name: 'Faltantes de caja', type: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '8020', name: 'Ajustes por redondeo y diferencias', type: 'EXPENSE', normalBalance: 'DEBIT' },
];

/** Códigos que el código de la aplicación referencia explícitamente. */
export const LEDGER = {
  CASH: '1010',
  BUSINESS_CASH: '1020',
  BANK: '1100',
  CHECKING: '1101',
  SAVINGS: '1102',
  DIGITAL_WALLET: '1110',
  MERCHANT: '1120',
  COMPANY_CASH_WITH_OWNER: '1130',
  INTERCOMPANY: '1150',
  RECEIVABLE: '1210',
  LOAN_GIVEN: '1250',
  INVENTORY: '1300',
  PAYABLE: '2100',
  LOAN_PAYABLE: '2200',
  LOAN_PAYABLE_BANK: '2201',
  LOAN_PAYABLE_PERSONAL: '2202',
  CREDIT_CARD: '2210',
  CUSTODY_FUNDS: '2150',
  OWNER_REIMBURSEMENT: '2350',
  TAXES_PAYABLE: '2300',
  RECURRING_PAYABLE: '2400',
  OWNER_CONTRIBUTION: '3100',
  OWNER_WITHDRAWAL: '3200',
  RETAINED_EARNINGS: '3300',
  OPENING_BALANCE: '3400',
  SALES_INCOME: '4100',
  SERVICE_INCOME: '4200',
  SUBSCRIPTION_INCOME: '4300',
  RENTAL_INCOME: '4400',
  OTHER_INCOME: '4900',
  INTEREST_INCOME: '4910',
  CASH_OVERAGE: '4920',
  COGS: '5000',
  MERCHANDISE_PURCHASES: '5100',
  PAYROLL: '6100',
  RENT: '6200',
  ADVERTISING: '6300',
  FUEL: '6350',
  DELIVERY: '6360',
  ELECTRICITY: '6400',
  WATER: '6410',
  INTERNET: '6420',
  TECHNOLOGY: '6500',
  MAINTENANCE: '6600',
  SUPPLIES: '6700',
  PROFESSIONAL_SERVICES: '6800',
  FOOD: '6900',
  OTHER_OPERATING_EXPENSE: '6990',
  INTEREST_EXPENSE: '7100',
  BANK_FEES: '7110',
  PENALTIES: '7120',
  CASH_SHORTAGE: '8010',
  ROUNDING_ADJUSTMENT: '8020',
} as const;

/** Cuenta contable por defecto según el tipo de cuenta financiera. */
export const ACCOUNT_TYPE_LEDGER: Record<string, string> = {
  CASH: LEDGER.CASH,
  BUSINESS_CASH: LEDGER.BUSINESS_CASH,
  BANK: LEDGER.BANK,
  CHECKING: LEDGER.CHECKING,
  SAVINGS: LEDGER.SAVINGS,
  DIGITAL_WALLET: LEDGER.DIGITAL_WALLET,
  MERCHANT: LEDGER.MERCHANT,
  CREDIT_CARD: LEDGER.CREDIT_CARD,
  OTHER: LEDGER.CASH,
};

export function chartAccountByCode(code: string): ChartAccountSeed | undefined {
  return CHART_OF_ACCOUNTS.find((account) => account.code === code);
}
