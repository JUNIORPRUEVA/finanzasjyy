/**
 * CLIENTE DE LA API DE FINANZA
 * ----------------------------
 * · Añade el token de acceso a cada petición.
 * · Si el servidor responde 401, intenta RENOVAR la sesión una vez y repite la
 *   petición (el usuario no nota nada).
 * · Si no hay conexión, lanza `OfflineError` para que la capa de sincronización
 *   decida si la operación puede guardarse localmente.
 * · Nunca inventa respuestas: si el servidor no confirma, la operación queda
 *   como pendiente.
 */

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api/v1';

const ACCESS_TOKEN_KEY = 'finanza.accessToken';
const REFRESH_TOKEN_KEY = 'finanza.refreshToken';
const DEVICE_ID_KEY = 'finanza.deviceId';

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
}

/** No hay conexión (o el servidor no responde): la operación puede encolarse. */
export class OfflineError extends Error {
  constructor(message = 'Sin conexión con el servidor') {
    super(message);
    this.name = 'OfflineError';
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
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  },
  getRefreshToken(): string | null {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  },
  set(accessToken: string, refreshToken?: string): void {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    if (refreshToken) {
      localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    }
  },
  clear(): void {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
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

let refreshInFlight: Promise<boolean> | null = null;

async function tryRefreshSession(): Promise<boolean> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  const refreshToken = tokenStore.getRefreshToken();
  if (!refreshToken) {
    return false;
  }

  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken, ...deviceInfoPayload() }),
      });

      if (!response.ok) {
        tokenStore.clear();
        return false;
      }

      const data = (await response.json()) as { accessToken: string; refreshToken: string };
      tokenStore.set(data.accessToken, data.refreshToken);
      return true;
    } catch {
      // Sin conexión: no se borra la sesión, simplemente no se pudo renovar.
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

function deviceInfoPayload(): Record<string, string> {
  return {
    deviceId: deviceInfo.deviceId(),
    deviceName: deviceInfo.deviceName(),
    platform: deviceInfo.platform(),
  };
}

/** Petición cruda a la API con renovación automática de sesión. */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, skipRefresh = false, signal } = options;

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
  const timeoutMs = Number((import.meta as { env?: Record<string, string> }).env?.VITE_API_TIMEOUT_MS ?? 20_000);
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
    const refreshed = await tryRefreshSession();
    if (refreshed) {
      return apiRequest<T>(path, { ...options, skipRefresh: true });
    }
    tokenStore.clear();
    window.dispatchEvent(new CustomEvent('finanza:session-expired'));
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

/** Descarga un archivo (CSV) respetando la autenticación. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const accessToken = tokenStore.getAccessToken();
  let response: Response;

  try {
    response = await fetch(`${API_URL}${path}`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
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
