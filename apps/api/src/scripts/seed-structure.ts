/**
 * CLI: crea la LÍNEA BASE contable y nada más.
 *
 *   node dist/scripts/seed-structure.js
 *
 * Qué hace: catálogo contable (partida doble) y categorías por defecto.
 * Qué NO hace: usuarios, unidades financieras, saldos ni movimientos.
 *
 * Cuándo hace falta: la API lo ejecuta sola al arrancar (ver `Dockerfile.api`),
 * así que en el uso normal no hay que llamarlo. Sirve para una base restaurada a
 * mano, para comprobarlo y para reparar una instalación a la que le faltara la
 * estructura (fue justo lo que pasó en producción: 0 cuentas contables y, con
 * ellas, ningún alta de cuenta podía funcionar).
 *
 * Es idempotente: se puede ejecutar mil veces.
 */
import { existsSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { runLedgerBaseline } from './structural-seed.js';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL && existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL no está definida.');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const result = await runLedgerBaseline(prisma);
    console.log(
      `[seed-structure] catálogo contable listo: ${result.ledgerAccounts} cuentas, ${result.categories} categorías.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('');
  console.error('[seed-structure] No se pudo crear la estructura contable:');
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  console.error('');
  process.exit(1);
});
