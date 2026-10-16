/**
 * Carga el .env ANTES de que se importe el código de la aplicación.
 * Los imports ES se hoistean, así que asignar variables dentro de un test llega
 * demasiado tarde: este archivo se ejecuta en `setupFiles`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * CARGA MANUAL DEL .env PARA LAS PRUEBAS
 * --------------------------------------
 * GOTCHA COMPROBADO: con `--experimental-vm-modules` (obligatorio para que Jest
 * cargue NestJS 12, que es ESM-only), cada archivo de test corre en un contexto
 * de VM cuyo `process.env` es una copia. `process.loadEnvFile()` muta el
 * `process.env` real desde código nativo, así que el test NO ve las variables y
 * falla con "DATABASE_URL no está definida".
 *
 * Por eso el archivo se lee y se asigna directamente a `process.env`, que es el
 * mismo objeto que ven los tests.
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) {
      result[key] = value;
    }
  }
  return result;
}

function findEnvFile(): string | null {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '..', '.env'),
    resolve(__dirname, '..', '.env'),
    resolve(__dirname, '..', '..', '.env'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

const envPath = findEnvFile();
if (envPath) {
  const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    // El entorno real (CI, Docker) tiene prioridad sobre el archivo.
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.TZ = process.env.TZ ?? 'America/Santo_Domingo';
process.env.BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE ?? 'America/Santo_Domingo';
process.env.DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY ?? 'DOP';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret-not-for-production';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'test-refresh-secret-not-for-production';
process.env.JWT_ACCESS_TTL = process.env.JWT_ACCESS_TTL ?? '900';
process.env.JWT_REFRESH_TTL = process.env.JWT_REFRESH_TTL ?? '2592000';
process.env.ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR ?? './.datos-locales/adjuntos-test';
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? 'http://localhost:5180';

/**
 * AISLAMIENTO DE LAS PRUEBAS
 * --------------------------
 * Las pruebas de extremo a extremo CREAN movimientos, cierres, préstamos y
 * unidades financieras de verdad. Si se ejecutaran contra la base de datos de
 * trabajo, las cuentas reales quedarían mezcladas con datos de prueba: eso es
 * exactamente lo que no puede pasar.
 *
 * Por eso las pruebas usan SIEMPRE una base de datos aparte (`finanza_test`):
 *   · si existe FINANZA_TEST_DATABASE_URL, se usa esa;
 *   · si no, se deriva de DATABASE_URL cambiando el nombre de la base de datos.
 *
 * Si no se puede derivar una base de datos distinta, se aborta en lugar de
 * escribir en la de trabajo.
 */
function deriveTestDatabaseUrl(url: string): string | null {
  // postgresql://usuario:clave@host:puerto/BASE?schema=public
  const match = /^(.*\/)([^/?]+)(\?.*)?$/.exec(url);
  if (!match) {
    return null;
  }
  const [, prefix, databaseName, query = ''] = match;
  if (databaseName === 'finanza_test') {
    return url;
  }
  return `${prefix}finanza_test${query}`;
}

const declaredTestUrl = process.env.FINANZA_TEST_DATABASE_URL;
const workingUrl = process.env.DATABASE_URL;
const resolvedTestUrl = declaredTestUrl && declaredTestUrl.length > 0
  ? declaredTestUrl
  : workingUrl
    ? deriveTestDatabaseUrl(workingUrl)
    : null;

if (!resolvedTestUrl || resolvedTestUrl === workingUrl) {
  throw new Error(
    'Las pruebas de extremo a extremo necesitan una base de datos propia (finanza_test) para no\n' +
      'mezclar datos de prueba con las cuentas reales. Defina FINANZA_TEST_DATABASE_URL en .env\n' +
      'o cree la base de datos con:  .\\scripts\\create-test-db.ps1',
  );
}

process.env.DATABASE_URL = resolvedTestUrl;

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL no está definida. Copia apps/api/.env.example a apps/api/.env ' +
      '(o ejecuta scripts/sync-env.ps1) y levanta la base con: docker compose up -d db. ' +
      `Archivos buscados: ${[
        resolve(process.cwd(), '.env'),
        resolve(process.cwd(), '..', '.env'),
        resolve(__dirname, '..', '.env'),
        resolve(__dirname, '..', '..', '.env'),
      ].join(', ')}`,
  );
}
