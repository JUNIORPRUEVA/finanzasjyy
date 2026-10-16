/**
 * CLI: siembra estructural de FINANZA.
 *   npm run db:seed           (equivale a: nest build && node dist/scripts/seed.js)
 *   npx prisma db seed
 *
 * No crea importes ni movimientos: sólo estructura (catálogo contable,
 * categorías, unidades financieras, usuario propietario).
 */
import { existsSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { runStructuralSeed } from './structural-seed.js';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL && existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL no está definida. Copia apps/api/.env.example a apps/api/.env');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    const result = await runStructuralSeed(prisma);

    console.log('');
    console.log('=== Semilla estructural de FINANZA aplicada ===');
    console.log(`  Catálogo contable : ${result.ledgerAccounts} cuentas`);
    console.log(`  Categorías        : ${result.categories}`);
    console.log(`  Unidades          : ${result.entities.join(', ')}`);
    console.log(`  Usuario           : ${result.adminEmail}${result.adminCreated ? ' (creado)' : ' (ya existía)'}`);
    console.log('  Saldos iniciales  : ninguno (los introduce el usuario; no se inventan cifras)');
    if (result.generatedPassword) {
      console.log('');
      console.log('  ------------------------------------------------------------------');
      console.log('  CONTRASEÑA GENERADA (se muestra UNA sola vez, guárdala ahora):');
      console.log(`    ${result.generatedPassword}`);
      console.log('  Cámbiala al entrar en Ajustes → Perfil.');
      console.log('  ------------------------------------------------------------------');
    }
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('La semilla falló:', error);
  process.exit(1);
});
