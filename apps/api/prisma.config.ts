import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 NO carga el archivo .env automáticamente.
// Node >= 20.12 expone process.loadEnvFile(), que evita depender de dotenv.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

/**
 * Dirección de la base de datos.
 *
 * Se lee de `process.env` en lugar de usar `env('DATABASE_URL')` porque `env()`
 * LANZA un error si la variable no existe, y eso rompía la compilación de la
 * imagen de Docker: `prisma generate` no necesita conectarse a ninguna base de
 * datos (sólo genera el cliente), pero se negaba a arrancar sin la variable.
 *
 * Con este valor de reserva, `prisma generate` funciona en cualquier sitio
 * (también dentro de un contenedor sin secretos) y los comandos que SÍ tocan la
 * base de datos (`migrate deploy`, `migrate status`, `db:seed`) siguen usando la
 * dirección real en cuanto existe. Si falta en el servidor, la API no arranca y
 * lo dice con claridad (ver `src/main.ts`).
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://sin-configurar:sin-configurar@localhost:5432/sin-configurar?schema=public';

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
    url: DATABASE_URL,
  },
});
