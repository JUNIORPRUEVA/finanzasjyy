/**
 * CLI: DATOS DE DEMOSTRACIÓN de FINANZA.
 *   npm run seed:demo
 *
 * ADVERTENCIA
 * -----------
 * Este script SÍ crea importes y movimientos, pero exclusivamente dentro de una
 * unidad financiera llamada «DEMO», marcada como de prueba en su propio nombre
 * y descripción, y con todos los identificadores de operación prefijados por
 * `demo_`. Nunca escribe en las unidades reales (FULLTECH, PHYTOEMAGRY,
 * FULLPOS CLOUD, FINANZAS PERSONALES).
 *
 * Se niega a ejecutarse si:
 *   · NODE_ENV es 'production', o
 *   · DATABASE_URL apunta a un puerto que no sea el local, o
 *   · no se pasa la confirmación explícita `--confirmar-demo`.
 *
 * Uso:
 *   npm run seed:demo -- --confirmar-demo
 */
import { existsSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { postEntry, type JournalLineInput } from '../ledger/ledger-core.js';
import { buildPostingLines } from '../ledger/posting-rules.js';
import { LEDGER } from '../domain/chart-of-accounts.js';
import { toBusinessDate } from '../domain/business-date.js';

const DEMO_CODE = 'DEMO';
const DEMO_NAME = 'DEMO — unidad de prueba (se puede borrar)';
const DEMO_DESCRIPTION =
  'Unidad creada por `npm run seed:demo` únicamente para probar la aplicación. ' +
  'NO contiene datos reales y se puede eliminar sin afectar a las demás unidades.';

interface DemoMovement {
  clientOperationId: string;
  kind: 'INCOME' | 'EXPENSE' | 'OWNER_WITHDRAWAL' | 'OWNER_CONTRIBUTION';
  ledgerCode: string;
  amount: string;
  account: 'CASH' | 'BANK';
  description: string;
  categoryName: string | null;
  method: string;
  dayOffset: number;
}

/**
 * Movimientos de ejemplo: cifras redondas y evidentemente de prueba, repartidas
 * en los últimos días para que los informes y el cierre diario tengan contenido.
 */
const DEMO_MOVEMENTS: DemoMovement[] = [
  {
    clientOperationId: 'demo_ingreso_venta_equipo',
    kind: 'INCOME',
    ledgerCode: LEDGER.SALES_INCOME,
    amount: '25000.00',
    account: 'CASH',
    description: '[DEMO] Venta de equipo de cómputo',
    categoryName: 'Ventas de productos',
    method: 'EFECTIVO',
    dayOffset: -6,
  },
  {
    clientOperationId: 'demo_ingreso_servicio',
    kind: 'INCOME',
    ledgerCode: LEDGER.SERVICE_INCOME,
    amount: '8500.00',
    account: 'BANK',
    description: '[DEMO] Servicio de mantenimiento mensual',
    categoryName: 'Ingresos por servicios',
    method: 'TRANSFERENCIA',
    dayOffset: -5,
  },
  {
    clientOperationId: 'demo_gasto_combustible',
    kind: 'EXPENSE',
    ledgerCode: LEDGER.FUEL,
    amount: '3200.00',
    account: 'CASH',
    description: '[DEMO] Combustible de la semana',
    categoryName: 'Combustible',
    method: 'EFECTIVO',
    dayOffset: -4,
  },
  {
    clientOperationId: 'demo_gasto_publicidad',
    kind: 'EXPENSE',
    ledgerCode: LEDGER.ADVERTISING,
    amount: '4500.00',
    account: 'BANK',
    description: '[DEMO] Publicidad en redes',
    categoryName: 'Publicidad',
    method: 'TRANSFERENCIA',
    dayOffset: -3,
  },
  {
    clientOperationId: 'demo_retiro_propietario',
    kind: 'OWNER_WITHDRAWAL',
    ledgerCode: LEDGER.OWNER_WITHDRAWAL,
    amount: '10000.00',
    account: 'BANK',
    description: '[DEMO] Retiro del propietario',
    categoryName: null,
    method: 'TRANSFERENCIA',
    dayOffset: -2,
  },
];

function assertSafeToRun(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Los datos de demostración están prohibidos en producción. Este script sólo se ejecuta en un entorno de pruebas.',
    );
  }
  if (!process.argv.includes('--confirmar-demo')) {
    throw new Error(
      'Faltan datos de confirmación. Ejecute:  npm run seed:demo -- --confirmar-demo\n' +
        'Creará movimientos de EJEMPLO (marcados [DEMO]) en una unidad aparte.',
    );
  }
  const url = process.env.DATABASE_URL ?? '';
  const isLocal = /@(localhost|127\.0\.0\.1|db)[:/]/.test(url);
  if (!isLocal) {
    throw new Error(
      'DATABASE_URL no parece una base de datos local. Los datos de demostración sólo se cargan en la base de datos de desarrollo.',
    );
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL && existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  assertSafeToRun();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL no está definida. Copia apps/api/.env.example a apps/api/.env');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    const owner = await prisma.user.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
    if (!owner) {
      throw new Error('No hay ningún usuario. Ejecute primero la semilla estructural: npm run db:seed');
    }

    const ledger = await prisma.ledgerAccount.findMany({
      where: { code: { in: [LEDGER.CASH, LEDGER.BANK, LEDGER.OPENING_BALANCE, ...DEMO_MOVEMENTS.map((m) => m.ledgerCode)] } },
    });
    const ledgerByCode = new Map(ledger.map((account) => [account.code, account]));
    const requireLedger = (code: string) => {
      const found = ledgerByCode.get(code);
      if (!found) {
        throw new Error(`El catálogo contable no tiene la cuenta ${code}. Ejecute: npm run db:seed`);
      }
      return found;
    };

    // --------------------------- 1. Unidad DEMO ---------------------------
    const entity = await prisma.financialEntity.upsert({
      where: { code: DEMO_CODE },
      create: {
        code: DEMO_CODE,
        name: DEMO_NAME,
        type: 'BUSINESS',
        description: DEMO_DESCRIPTION,
        ownerUserId: owner.id,
        currency: 'DOP',
        timezone: 'America/Santo_Domingo',
        color: '#f59e0b',
        isActive: true,
      },
      update: { name: DEMO_NAME, description: DEMO_DESCRIPTION },
    });

    await prisma.entityMember.upsert({
      where: { entityId_userId: { entityId: entity.id, userId: owner.id } },
      create: { entityId: entity.id, userId: owner.id, role: 'OWNER' },
      update: { role: 'OWNER' },
    });

    // ----------------------- 2. Cuentas financieras ----------------------
    const openingDate = toBusinessDate(new Date(Date.now() - 30 * 24 * 3_600_000));
    const cash = await prisma.financialAccount.upsert({
      where: { entityId_name: { entityId: entity.id, name: '[DEMO] Caja' } },
      create: {
        entityId: entity.id,
        name: '[DEMO] Caja',
        type: 'CASH',
        ledgerAccountId: requireLedger(LEDGER.CASH).id,
        openingBalance: '15000.00',
        openingDate,
        notes: 'Saldo inicial de ejemplo, no es dinero real.',
      },
      update: {},
    });
    const bank = await prisma.financialAccount.upsert({
      where: { entityId_name: { entityId: entity.id, name: '[DEMO] Banco' } },
      create: {
        entityId: entity.id,
        name: '[DEMO] Banco',
        type: 'BANK',
        ledgerAccountId: requireLedger(LEDGER.BANK).id,
        openingBalance: '40000.00',
        openingDate,
        notes: 'Saldo inicial de ejemplo, no es dinero real.',
      },
      update: {},
    });

    const accounts = { CASH: cash, BANK: bank };

    // ------------------------ 3. Asiento de apertura ---------------------
    const openingEntry = await prisma.journalEntry.findFirst({
      where: { entityId: entity.id, sourceType: 'OPENING_BALANCE', description: '[DEMO] Saldos iniciales' },
    });
    if (!openingEntry) {
      await prisma.$transaction(async (tx) => {
        const entry = await postEntry(tx, {
          entityId: entity.id,
          businessDate: openingDate,
          description: '[DEMO] Saldos iniciales',
          sourceType: 'OPENING_BALANCE',
          lines: [
            {
              ledgerCode: LEDGER.CASH,
              financialAccountId: cash.id,
              debit: cash.openingBalance.toString(),
              memo: 'Saldo inicial [DEMO] Caja',
            },
            {
              ledgerCode: LEDGER.BANK,
              financialAccountId: bank.id,
              debit: bank.openingBalance.toString(),
              memo: 'Saldo inicial [DEMO] Banco',
            },
            {
              ledgerCode: LEDGER.OPENING_BALANCE,
              credit: (Number(cash.openingBalance) + Number(bank.openingBalance)).toFixed(2),
              memo: 'Contrapartida del saldo inicial',
            },
          ] as JournalLineInput[],
          createdByUserId: owner.id,
        });
        return entry;
      });
    }

    // -------------------------- 4. Movimientos ---------------------------
    let created = 0;
    for (const movement of DEMO_MOVEMENTS) {
      const existing = await prisma.financialTransaction.findUnique({
        where: { clientOperationId: movement.clientOperationId },
      });
      if (existing) {
        continue;
      }

      const account = accounts[movement.account];
      const category = movement.categoryName
        ? await prisma.transactionCategory.findFirst({
            where: { entityId: null, name: movement.categoryName },
            select: { id: true },
          })
        : null;

      const lines = buildPostingLines({
        kind: movement.kind,
        amount: movement.amount,
        financialLedgerCode: movement.account === 'CASH' ? LEDGER.CASH : LEDGER.BANK,
        categoryLedgerCode: movement.ledgerCode,
        financialAccountId: account.id,
        memo: movement.description,
      });

      const businessDate = toBusinessDate(new Date(Date.now() + movement.dayOffset * 24 * 3_600_000));

      await prisma.$transaction(async (tx) => {
        const entry = await postEntry(tx, {
          entityId: entity.id,
          businessDate,
          description: movement.description,
          sourceType: 'TRANSACTION',
          lines: lines as JournalLineInput[],
          createdByUserId: owner.id,
        });

        await tx.financialTransaction.create({
          data: {
            entityId: entity.id,
            kind: movement.kind,
            status: 'POSTED',
            accountId: account.id,
            categoryId: category?.id ?? null,
            journalEntryId: entry.id,
            amount: movement.amount,
            currency: 'DOP',
            businessDate,
            description: movement.description,
            method: movement.method,
            clientOperationId: movement.clientOperationId,
            syncStatus: 'CONFIRMED',
            createdByUserId: owner.id,
          },
        });
      });
      created += 1;
    }

    console.log('');
    console.log('=== Datos de demostración creados ===');
    console.log(`  Unidad  : ${DEMO_NAME} (código ${DEMO_CODE})`);
    console.log(`  Cuentas : ${cash.name}, ${bank.name}`);
    console.log(`  Movimientos nuevos: ${created} de ${DEMO_MOVEMENTS.length}`);
    console.log('  Todos los movimientos llevan el prefijo [DEMO] y NO son dinero real.');
    console.log('  Para borrarlos: elimine la unidad DEMO desde la propia aplicación.');
    console.log('  Las unidades reales (FULLTECH, PHYTOEMAGRY, FULLPOS CLOUD, FINANZAS PERSONALES)');
    console.log('  no se han tocado.');
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Los datos de demostración no se crearon:', error instanceof Error ? error.message : error);
  process.exit(1);
});
