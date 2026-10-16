import { existsSync } from 'node:fs';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 NO carga el archivo .env automáticamente.
// Node >= 20.12 expone process.loadEnvFile(), que evita depender de dotenv.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // El seed es ESTRUCTURAL (catálogo contable, categorías, unidades financieras,
    // usuario propietario). NO inserta saldos ni movimientos inventados.
    // Se ejecuta sobre el código compilado porque los imports de TypeScript
    // usan la extensión .js (resolución `nodenext`).
    seed: 'npm run db:seed',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
