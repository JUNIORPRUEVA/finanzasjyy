/**
 * CLIENTE DE LA API DE FINANZA
 * ----------------------------
 * · Añade el token de acceso a cada petición.
 * · Si el servidor responde 401, intenta RENOVAR la sesión una vez y repite la
 *   petición (el usuario no nota nada).
 * · Si no hay conexión, lanza `OfflineError` para que la capa de sincronización
 *   decida si la operación puede guardarse localmente.
 * · Las LECTURAS se guardan en una caché con fecha: si el servidor no puede
 *   contestar, se devuelve la última respuesta buena (ver `lib/read-cache.ts`).
 * · Nunca inventa respuestas: si el servidor no confirma, la operación queda
 *   como pendiente.
 */

import {
  avisarDatosGuardados,
  olvidarDatosGuardados,
  readCachedResponse,
  rememberResponse,
} from './read-cache';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api/v1';

const DEVICE_ID_KEY = 'finanza.deviceId';

/**
 * DÓNDE VIVE LA SESIÓN
 * --------------------
 * · El ACCESS token vive SÓLO EN MEMORIA. Si se recarga la página se pierde, y
 *   se pide otro nuevo con la cookie (renovación silenciosa): el usuario no
 *   vuelve a ver la pantalla de acceso.
 * · El REFRESH token NO se guarda aquí: va en una cookie HttpOnly que JavaScript
 *   no puede leer. Así un fallo de XSS no se lleva una sesión de 30 días.
 * · Únicamente se guarda el identificador de dispositivo (no es un secreto).
 */
let accessTokenInMemory: string | null = null;

/** Cookie legible con el token CSRF (doble envío). */
function readCsrfCookie(): string | null {
  const match = /(?:^|;\s*)finanza_csrf=([^;]+)/.exec(document.cookie);
  return match ? decodeURIComponent(match[1]) : null;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** ¿Es un error que el usuario puede corregir enviando otros datos? */
  get isUserFixable(): boolean {
    return this.status === 400 || this.status === 409 || this.status === 422;
  }

  /**
   * ¿El servidor ha dicho CLARAMENTE que la sesión ya no sirve?
   *
   * Sólo estos códigos justifican volver a la pantalla de acceso. Un 401 sin
   * código, un 403, un 500, un 502/503 o un fallo de red NO significan que el
   * usuario haya cerrado sesión: significan que no se ha podido comprobar.
   */
  get isSessionFatal(): boolean {
    return [
      'SESSION_INVALID',
      'SESSION_EXPIRED',
      'SESSION_REVOKED',
      'SESSION_MISSING',
      'SESSION_REUSE_DETECTED',
      'SESSION_IDLE_TIMEOUT',
      'SESSION_MAX_LIFETIME',
    ].includes(this.code);
  }
}

/** No hay conexión (o el servidor no responde): la operación puede encolarse. */
export class OfflineError extends Error {
  constructor(message = 'Sin conexión con el servidor') {
    super(message);
    this.name = 'OfflineError';
  }
}

/**
 * El usuario ha activado el modo tienda: NO se habla con el servidor a propósito.
 * Es distinto de «no hay red», y por eso no se recurre a la caché: las listas de
 * compras tienen su propia copia local, más completa que cualquier respuesta.
 */
export class ModoTiendaOfflineError extends OfflineError {
  constructor(message = 'Modo tienda: se guarda en el teléfono y se envía al desactivarlo.') {
    super(message);
    this.name = 'ModoTiendaOfflineError';
  }
}

/**
 * MODO TIENDA (trabajar sin conexión en el supermercado)
 * =====================================================
 * En un súper la señal va y viene. Cuando el usuario activa el modo tienda, la
 * app NO espera al servidor para lo relativo a las listas de compras: trabaja
 * contra la copia del teléfono al instante y lo deja en la cola para enviarlo
 * cuando vuelva la red.
 *
 * Se guarda con caducidad para que nadie se quede «sin conexión» para siempre
 * por haberse olvidado de apagarlo.
 */
const MODO_TIENDA_KEY = 'finanza.modoTiendaHasta';

/** Milisegundos de caducidad si no se indica otra cosa (3 horas de compra). */
export const MODO_TIENDA_HORAS = 3;

export function modoTiendaHasta(): number | null {
  try {
    const guardado = Number(localStorage.getItem(MODO_TIENDA_KEY));
    if (!Number.isFinite(guardado) || guardado <= 0) {
      return null;
    }
    if (guardado <= Date.now()) {
      localStorage.removeItem(MODO_TIENDA_KEY);
      return null;
    }
    return guardado;
  } catch {
    return null;
  }
}

export function modoTiendaActivo(): boolean {
  return modoTiendaHasta() !== null;
}

export function activarModoTienda(horas = MODO_TIENDA_HORAS): number {
  const hasta = Date.now() + horas * 3_600_000;
  try {
    localStorage.setItem(MODO_TIENDA_KEY, String(hasta));
  } catch {
    // Sin almacenamiento: el modo vale sólo para esta pantalla.
  }
  return hasta;
}

export function desactivarModoTienda(): void {
  try {
    localStorage.removeItem(MODO_TIENDA_KEY);
  } catch {
    // Nada que limpiar.
  }
}

/**
 * El servidor no ha podido confirmar la sesión por un problema temporal
 * (timeout, 502/503, red intermitente). NO es un cierre de sesión: se conserva el
 * estado y se reintenta.
 */
export class SessionTemporarilyUnavailableError extends Error {
  constructor(message = 'No se pudo comprobar la sesión con el servidor. Se reintentará.') {
    super(message);
    this.name = 'SessionTemporarilyUnavailableError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** No intentar renovar el token (para el propio refresh). */
  skipRefresh?: boolean;
  signal?: AbortSignal;
}

export const tokenStore = {
  getAccessToken(): string | null {
    return accessTokenInMemory;
  },
  setAccessToken(accessToken: string | null): void {
    accessTokenInMemory = accessToken;
  },
  hasSession(): boolean {
    return accessTokenInMemory !== null;
  },
  clear(): void {
    accessTokenInMemory = null;
  },
  /**
   * Identificador del dispositivo: se guarda una vez y se envía en el login y
   * en la sincronización para poder distinguir los dispositivos del usuario.
   */
  deviceId(): string {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = `web-${crypto.randomUUID()}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  },
};

export const deviceInfo = {
  deviceId: () => tokenStore.deviceId(),
  deviceName: () => {
    const ua = navigator.userAgent;
    if (/android/i.test(ua)) return 'Dispositivo Android';
    if (/iphone|ipad|ipod/i.test(ua)) return 'iPhone / iPad';
    if (/windows/i.test(ua)) return 'PC con Windows';
    if (/mac/i.test(ua)) return 'Mac';
    return 'Navegador web';
  },
  platform: () => navigator.platform || 'web',
};

/** Genera un identificador único de operación para la idempotencia del servidor. */
export function newOperationId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function deviceInfoPayload(): Record<string, string> {
  return {
    deviceId: deviceInfo.deviceId(),
    deviceName: deviceInfo.deviceName(),
    platform: deviceInfo.platform(),
  };
}

/** Cabeceras comunes: identificación del dispositivo y, si toca, CSRF. */
function baseHeaders(options: { csrf?: boolean; sessionMode?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = { 'X-Device-Id': deviceInfo.deviceId() };
  if (options.sessionMode) {
    // Pide al servidor que entregue la sesión por cookie HttpOnly.
    headers['X-Session-Mode'] = 'cookie';
  }
  if (options.csrf) {
    const csrf = readCsrfCookie();
    if (csrf) {
      headers['X-CSRF-Token'] = csrf;
    }
  }
  return headers;
}

export type RefreshOutcome =
  | { status: 'refreshed' }
  | { status: 'no-session' }
  | { status: 'temporary' }
  | { status: 'session-fatal'; code: string; message: string };

let refreshInFlight: Promise<RefreshOutcome> | null = null;

/**
 * Renueva la sesión. Varias peticiones simultáneas comparten UNA sola llamada
 * (si no, la rotación del token invalidaría unas a otras).
 *
 * Nunca borra la sesión por un fallo temporal: sólo cuando el servidor dice
 * explícitamente que la sesión ya no sirve.
 */
export async function refreshSession(): Promise<RefreshOutcome> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async (): Promise<RefreshOutcome> => {
    let response: Response;
    try {
      response = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...baseHeaders({ csrf: true, sessionMode: true }) },
        body: JSON.stringify(deviceInfoPayload()),
      });
    } catch {
      // Sin conexión: la sesión se conserva y se reintentará.
      return { status: 'temporary' };
    }

    if (response.ok) {
      const data = (await response.json()) as { accessToken: string };
      tokenStore.setAccessToken(data.accessToken);
      return { status: 'refreshed' };
    }

    if (response.status === 401 || response.status === 403) {
      let code = 'SESSION_INVALID';
      let message = 'La sesión ha terminado. Inicie sesión de nuevo.';
      try {
        const payload = (await response.json()) as { code?: string; message?: string };
        code = payload.code ?? code;
        message = payload.message ?? message;
      } catch {
        // Respuesta sin JSON: se usa el mensaje genérico.
      }
      tokenStore.clear();
      return { status: 'session-fatal', code, message };
    }

    // 5xx / 502 / 503 / 429: el servidor existe pero no puede atender ahora.
    // La sesión NO se toca.
    return { status: 'temporary' };
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

/** ¿Hay indicios de una sesión guardada en el navegador? */
export function hasSessionCookieHint(): boolean {
  return /(?:^|;\s*)finanza_sesion=1/.test(document.cookie);
}

/** Cierra la sesión en el servidor (revoca) y limpia el estado local de sesión. */
export async function endSession(): Promise<void> {
  try {
    if (tokenStore.hasSession()) {
      await fetch(`${API_URL}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...baseHeaders({ csrf: true, sessionMode: true }) },
      });
    }
  } catch {
    // Aunque el servidor no conteste, la sesión local se cierra igual: la cookie
    // se borra en la siguiente recarga y el token de memoria desaparece.
  } finally {
    tokenStore.clear();
  }
}

/**
 * Avisa a la aplicación de que la sesión ha terminado DE VERDAD.
 * Sólo se llama cuando el servidor lo dice con un código explícito: nunca por un
 * fallo de red, un timeout ni un 502/503.
 */
export function dispatchSessionExpired(message: string, code: string): void {
  tokenStore.clear();
  window.dispatchEvent(new CustomEvent('finanza:session-expired', { detail: { message, code } }));
}

export interface AuthSessionResponse {
  accessToken: string;
  expiresIn: number;
  offlineAllowedUntil: string;
  sessionMode?: 'cookie' | 'token';
  user: { id: string; email: string; name: string; role: string };
}

/**
 * Inicia sesión o crea el primer usuario pidiendo la entrega de la sesión por
 * cookie HttpOnly. El access token se queda en memoria y el refresh token nunca
 * pasa por JavaScript.
 */
export async function startSession(
  path: '/auth/login' | '/auth/register',
  body: Record<string, unknown>,
): Promise<AuthSessionResponse> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...baseHeaders({ sessionMode: true }) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new OfflineError(
      'No se pudo conectar con el servidor. Compruebe su conexión e inténtelo de nuevo.',
    );
  }

  if (!response.ok) {
    let code = 'HTTP_ERROR';
    let message = `Error ${response.status}`;
    let details: unknown;
    try {
      const payload = (await response.json()) as { code?: string; message?: string; details?: unknown };
      code = payload.code ?? code;
      message = payload.message ?? message;
      details = payload.details;
    } catch {
      // Respuesta sin JSON.
    }
    throw new ApiError(response.status, code, message, details);
  }

  const data = (await response.json()) as AuthSessionResponse;
  tokenStore.setAccessToken(data.accessToken);
  return data;
}

/** Petición cruda a la API con renovación automática de sesión. */
async function apiRequestDirect<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, skipRefresh = false, signal } = options;

  // SIN SEÑAL NO SE ESPERA: si el teléfono dice que no hay red, se falla al
  // instante y la capa de compras trabaja con la copia del teléfono. Antes se
  // intentaba igual y la pantalla se quedaba «cargando» hasta el límite.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new OfflineError();
  }

  // MODO TIENDA: sólo afecta a las listas de compras (lo que se usa en la
  // tienda). El resto de la app sigue hablando con el servidor como siempre.
  if (path.startsWith('/shopping-lists') && modoTiendaActivo()) {
    throw new ModoTiendaOfflineError();
  }

  const headers: Record<string, string> = {
    'X-Device-Id': deviceInfo.deviceId(),
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const accessToken = tokenStore.getAccessToken();
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  let response: Response;
  // TIEMPO DE ESPERA: en un móvil con cobertura mala, una petición puede quedarse
  // colgada indefinidamente. Sin límite, la pantalla se queda «cargando» para
  // siempre y el usuario no sabe si el movimiento se registró. Con límite, falla
  // rápido, se conserva en la cola y se reintenta.
  const timeoutMs = Number((import.meta as { env?: Record<string, string> }).env?.VITE_API_TIMEOUT_MS ?? 8_000);
  const controller = signal ? null : new AbortController();
  const effectiveSignal = signal ?? controller?.signal;
  let timedOut = false;
  const timer = controller
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : null;

  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: effectiveSignal,
      // La cookie HttpOnly de sesión viaja en las peticiones al mismo origen.
      credentials: 'include',
    });
  } catch (error) {
    if (timedOut) {
      throw new ApiError(
        408,
        'TIMEOUT',
        'El servidor tardó demasiado en responder. El movimiento no se ha perdido: se reintentará.',
      );
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new OfflineError();
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }

  if (response.status === 401 && !skipRefresh) {
    const outcome = await refreshSession();

    if (outcome.status === 'refreshed') {
      return apiRequestDirect<T>(path, { ...options, skipRefresh: true });
    }

    if (outcome.status === 'session-fatal') {
      // El servidor ha dicho claramente que la sesión terminó.
      dispatchSessionExpired(outcome.message, outcome.code);
    } else {
      // Fallo TEMPORAL (sin red, timeout, 502/503): la sesión NO se cierra.
      // Se avisa para que la interfaz muestre «sin conexión» y siga mostrando lo
      // último conocido, en vez de tirar al usuario a la pantalla de acceso.
      throw new SessionTemporarilyUnavailableError();
    }
  }

  if (!response.ok) {
    let code = 'HTTP_ERROR';
    let message = `Error ${response.status}`;
    let details: unknown;

    try {
      const payload = (await response.json()) as { code?: string; message?: string; details?: unknown };
      code = payload.code ?? code;
      message = payload.message ?? message;
      details = payload.details;
    } catch {
      // Respuesta sin JSON: se conserva el mensaje genérico.
    }

    throw new ApiError(response.status, code, message, details);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return (await response.text()) as unknown as T;
  }

  return (await response.json()) as T;
}

/**
 * CONSULTAS CON CACHÉ: PARA SEGUIR LEYENDO SIN CONEXIÓN
 * ====================================================
 * Todas las consultas de la app pasan por aquí. El comportamiento es sencillo a
 * propósito:
 *
 *  · Con servidor: se pregunta SIEMPRE al servidor y, si contesta bien, se guarda
 *    una copia con su hora. La caché nunca sustituye a una respuesta real.
 *  · Sin servidor (sin red, timeout, 5xx, sesión no comprobable): se devuelve la
 *    última respuesta buena de ESA misma consulta y se avisa a la interfaz para
 *    que lo diga con la hora que tiene.
 *  · Si no hay copia: se lanza el error de siempre, y la pantalla explica que
 *    hace falta conexión. Nunca se inventa un cero.
 *
 * Sólo se cachean LECTURAS. Un POST/PATCH/DELETE jamás se sirve de la caché: el
 * dinero no se mueve con una copia.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';

  if (method !== 'GET' || !rutaCacheable(path)) {
    return apiRequestDirect<T>(path, options);
  }

  try {
    const data = await apiRequestDirect<T>(path, options);
    void rememberResponse(path, data);
    // El servidor ha respondido: lo que hubiera guardado ya no hace falta decirlo.
    olvidarDatosGuardados();
    return data;
  } catch (error) {
    if (!esFalloDeConexion(error)) {
      throw error;
    }
    const guardado = await readCachedResponse<T>(path);
    if (guardado) {
      avisarDatosGuardados(guardado.cachedAt, path);
      return guardado.data;
    }
    throw error;
  }
}

/**
 * ¿Se puede guardar una copia de esta consulta?
 *
 * Quedan fuera, a propósito:
 *  · las listas de compras (tienen su propia copia local, más completa y con los
 *    cambios hechos en el teléfono), salvo el resumen que se ve en el panel;
 *  · la sincronización y la cola de envíos (son estado vivo de este dispositivo);
 *  · la preparación de cierres (un cierre se calcula con los saldos de AHORA:
 *    reutilizar uno viejo daría una diferencia falsa);
 *  · el estado de la sesión y el inicio/cierre de sesión.
 */
function rutaCacheable(path: string): boolean {
  if (path.startsWith('/closings/prepare')) return false;
  if (path.startsWith('/shopping-lists') && !path.startsWith('/shopping-lists/summary')) return false;
  if (path.startsWith('/sync')) return false;
  if (path.startsWith('/auth/login') || path.startsWith('/auth/register')) return false;
  if (path.startsWith('/auth/logout') || path.startsWith('/auth/refresh')) return false;
  return true;
}

/** ¿El fallo significa «no se pudo hablar con el servidor» (y no otra cosa)? */
function esFalloDeConexion(error: unknown): boolean {
  if (error instanceof ModoTiendaOfflineError) return false;
  if (error instanceof OfflineError) return true;
  if (error instanceof SessionTemporarilyUnavailableError) return true;
  if (error instanceof ApiError) {
    // 408 = tardó demasiado; 5xx = el servidor no puede atender ahora.
    return error.status === 408 || error.status >= 500;
  }
  return false;
}

/** Descarga un archivo (CSV) respetando la autenticación. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const accessToken = tokenStore.getAccessToken();
  let response: Response;

  try {
    response = await fetch(`${API_URL}${path}`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      credentials: 'include',
    });
  } catch {
    throw new OfflineError('No se puede descargar el informe sin conexión');
  }

  if (!response.ok) {
    throw new ApiError(response.status, 'DOWNLOAD_FAILED', 'No se pudo generar el archivo');
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, { method: 'GET', signal }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'DELETE', body }),
};
