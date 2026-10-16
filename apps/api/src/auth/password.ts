import { randomBytes } from 'node:crypto';
import { argon2id, hash, verify, type HashOptions } from 'argon2';

/**
 * Hash de contraseñas con Argon2id (recomendación OWASP).
 * Parámetros deliberadamente moderados para que el login siga siendo rápido
 * en un servidor pequeño, pero muy por encima del mínimo recomendado.
 * (argon2 v0.45 exporta el tipo como `HashOptions`.)
 */
const ARGON2_OPTIONS: HashOptions = {
  type: argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw new Error('La contraseña debe tener al menos 8 caracteres');
  }
  // Sin `raw: true` argon2 devuelve string, que es lo que se guarda en la BD.
  return hash(plain, { ...ARGON2_OPTIONS, raw: false });
}

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}

/** Fuerza mínima exigida por FINANZA para una contraseña de acceso. */
export function isPasswordStrongEnough(plain: string): { ok: boolean; reason?: string } {
  if (plain.length < 10) {
    return { ok: false, reason: 'La contraseña debe tener al menos 10 caracteres' };
  }
  if (!/[A-Za-z]/.test(plain)) {
    return { ok: false, reason: 'La contraseña debe incluir al menos una letra' };
  }
  if (!/[0-9]/.test(plain)) {
    return { ok: false, reason: 'La contraseña debe incluir al menos un número' };
  }
  return { ok: true };
}

/** Contraseña aleatoria para el usuario inicial (se muestra una sola vez). */
export function generateRandomPassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%*+-';
  const buffer = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += alphabet[buffer[i] % alphabet.length];
  }
  return result;
}
