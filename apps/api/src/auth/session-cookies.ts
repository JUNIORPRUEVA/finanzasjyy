import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

/**
 * COOKIES DE SESIÓN (modo «cookie»)
 * --------------------------------
 * El refresh token es la credencial de larga duración: si se guarda en
 * localStorage, cualquier fallo de XSS se lleva una sesión de 30 días. Por eso
 * se entrega en una cookie **HttpOnly** (invisible para JavaScript), con:
 *
 *   · HttpOnly  → no accesible desde JS
 *   · Secure    → sólo por HTTPS (configurable para desarrollo en localhost)
 *   · SameSite  → 'Lax' por defecto: el navegador NO la envía en peticiones
 *                 POST desde otro sitio, que es la base de la defensa CSRF
 *   · Path      → limitada a /api/v1/auth: no viaja en el resto de peticiones
 *
 * El access token NO se guarda en el dispositivo: vive en memoria. Al abrir la
 * aplicación se pide uno nuevo con la cookie (renovación silenciosa), así que
 * cerrar y volver a abrir NO obliga a iniciar sesión mientras la sesión siga
 * siendo válida.
 *
 * Defensa CSRF adicional (doble envío): además de SameSite, se entrega una
 * cookie legible (`finanza_csrf`) cuyo valor hay que devolver en la cabecera
 * `X-CSRF-Token`. Un sitio atacante puede provocar la petición, pero no puede
 * leer esa cookie para copiar el valor.
 */

export const REFRESH_COOKIE = 'finanza_rt';
export const CSRF_COOKIE = 'finanza_csrf';
/** Cookie legible que sólo indica «hay sesión»: evita pedir un 401 al arrancar. */
export const SESSION_HINT_COOKIE = 'finanza_sesion';
export const CSRF_HEADER = 'x-csrf-token';
export const SESSION_MODE_HEADER = 'x-session-mode';

export type SameSiteOption = 'lax' | 'strict' | 'none';

/** ¿El cliente ha pedido expresamente el modo cookie? */
export function isCookieSessionMode(req: Request): boolean {
  return String(req.headers[SESSION_MODE_HEADER] ?? '').toLowerCase() === 'cookie';
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) {
    return result;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name.length > 0) {
      result[name] = decodeURIComponent(value);
    }
  }
  return result;
}

export function readCookie(req: Request, name: string): string | null {
  const cookies = parseCookieHeader(req.headers.cookie);
  return cookies[name] ?? null;
}

/** ¿Hay indicios de sesión? Se usa para no provocar un 401 innecesario al abrir. */
export function hasSessionHint(req: Request): boolean {
  return readCookie(req, SESSION_HINT_COOKIE) === '1';
}

function sameSite(): SameSiteOption {
  const value = String(process.env.COOKIE_SAMESITE ?? 'lax').toLowerCase();
  return value === 'strict' || value === 'none' ? value : 'lax';
}

/**
 * `Secure` sólo se activa cuando de verdad hay HTTPS. Activarlo en localhost lo
 * rompería: el navegador no enviaría la cookie. En producción es obligatorio.
 */
function secureCookies(req: Request): boolean {
  if (String(process.env.COOKIE_SECURE ?? '').toLowerCase() === 'true') {
    return true;
  }
  if (String(process.env.COOKIE_SECURE ?? '').toLowerCase() === 'false') {
    return false;
  }
  return process.env.NODE_ENV === 'production' || req.protocol === 'https';
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Entrega las cookies de sesión. El `csrfToken` se reutiliza entre rotaciones
 * para que varias peticiones simultáneas no se pisen entre sí.
 */
export function setSessionCookies(
  req: Request,
  res: Response,
  params: { refreshToken: string; csrfToken: string; refreshTtlSeconds: number },
): void {
  const secure = secureCookies(req);
  const site = sameSite();
  const maxAge = params.refreshTtlSeconds * 1_000;

  res.cookie(REFRESH_COOKIE, params.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: site,
    path: '/api/v1/auth',
    maxAge,
  });

  // Legible por JS a propósito: el cliente debe poder copiarla en la cabecera.
  res.cookie(CSRF_COOKIE, params.csrfToken, {
    httpOnly: false,
    secure,
    sameSite: site,
    path: '/',
    maxAge,
  });

  res.cookie(SESSION_HINT_COOKIE, '1', {
    httpOnly: false,
    secure,
    sameSite: site,
    path: '/',
    maxAge,
  });
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
  res.clearCookie(SESSION_HINT_COOKIE, { path: '/' });
}

/**
 * Comprueba el doble envío CSRF. Se usa sólo en las rutas que dependen de la
 * cookie (renovar sesión), porque son las únicas que un tercero podría provocar.
 * Devuelve `false` cuando no cuadra; quien llama decide el error HTTP.
 */
export function csrfMatches(req: Request): boolean {
  const cookieToken = readCookie(req, CSRF_COOKIE);
  const headerToken = String(req.headers[CSRF_HEADER] ?? '');

  if (!cookieToken || !headerToken) {
    return false;
  }

  const cookieBuffer = Buffer.from(cookieToken);
  const headerBuffer = Buffer.from(headerToken);
  return cookieBuffer.length === headerBuffer.length && timingSafeEqual(cookieBuffer, headerBuffer);
}

/** Huella de un token para poder registrarlo en auditoría sin exponerlo. */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}
