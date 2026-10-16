import { createHash, randomBytes } from 'node:crypto';
import type { UserRole } from '../generated/prisma/enums.js';

/**
 * GESTIÓN DE TOKENS
 * -----------------
 *  - El ACCESS TOKEN es un JWT de vida corta (15 min por defecto) que lleva,
 *    además del usuario, el identificador de sesión, el dispositivo y el
 *    instante hasta el que la app puede operar SIN CONEXIÓN.
 *  - El REFRESH TOKEN es un valor aleatorio de 64 bytes. En la base de datos
 *    sólo se guarda su hash SHA-256: si alguien obtiene un volcado de la tabla
 *    de sesiones no puede suplantar al usuario.
 */

export interface AccessTokenPayload {
  sub: string;
  email: string;
  name: string;
  role: UserRole;
  /** Identificador de la sesión (permite revocarla). */
  sid: string;
  /** Identificador del dispositivo, si el cliente lo informó. */
  did?: string;
  /** Epoch en segundos: fin de la ventana de operación offline. */
  offlineUntil: number;
}

export function generateRefreshToken(): string {
  return randomBytes(64).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Hash de un valor con sal, usado para detectar cambios de contenido (idempotencia). */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/** JSON determinista: el mismo objeto siempre produce la misma cadena. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
