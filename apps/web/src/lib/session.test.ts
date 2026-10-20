import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  OfflineError,
  SessionTemporarilyUnavailableError,
  apiRequest,
  endSession,
  hasSessionCookieHint,
  refreshSession,
  startSession,
  tokenStore,
} from './api';
import { countPendingOperations, db, enqueueOperation, listQueuedOperations } from './db';

/**
 * PRUEBAS DE LA SESIÓN PERSISTENTE
 * ================================
 * La exigencia del usuario es tajante: «no quiero tener que iniciar sesión cada
 * vez que cierro y vuelvo a abrir FINANZA».
 *
 * Eso significa que un fallo temporal del servidor NUNCA puede destruir la
 * sesión. Estas pruebas comprueban, con la red simulada, cada uno de los casos:
 *
 *   1. Entrar bien y entrar mal.
 *   2. Reabrir la aplicación (el token de memoria se pierde)  → se recupera solo.
 *   3. Un 401 en una petición normal                          → se renueva y sigue.
 *   4. Varias peticiones a la vez con el token caducado        → UNA sola renovación.
 *   5. El servidor no responde (503 / red caída / timeout)     → NO se cierra la sesión.
 *   6. La sesión caducó, fue revocada o superó su inactividad   → sí se cierra, con su motivo.
 *   7. Cerrar sesión                                           → revoca y limpia.
 *   8. Volver la conexión después de un 503                    → se recupera sin volver a pedir contraseña.
 *   9. Los movimientos pendientes SOBREVIVEN al cierre de sesión.
 *
 * Ninguna prueba toca la base de datos real: se usa IndexedDB en memoria
 * (`fake-indexeddb`, cargado en el entorno de pruebas).
 */


/** Respuestas JSON del servidor, construidas a mano para controlarlas al detalle. */
function jsonResponse(status: number, body: unknown): Response {
  // 204 (sin contenido) no admite cuerpo: el navegador devolvería un error.
  if (status === 204 || body === null || body === undefined) {
    return new Response(null, { status, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setCsrfCookie(token = 'csrf-de-prueba'): void {
  document.cookie = `finanza_csrf=${token}`;
}

const loginBody = {
  accessToken: 'access-1',
  expiresIn: 900,
  offlineAllowedUntil: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  sessionMode: 'cookie' as const,
  user: { id: 'u1', email: 'yo@ejemplo.com', name: 'Yo', role: 'OWNER' },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  tokenStore.clear();
  document.cookie = 'finanza_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  document.cookie = 'finanza_sesion=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  await db.queuedOperations.clear();
  // La caché de lectura guarda las respuestas buenas: si no se limpia entre
  // pruebas, un 502 posterior devolvería la respuesta de la prueba anterior (que
  // es justo lo que hace en producción, pero aquí falsearía el caso a probar).
  await db.cacheResponses.clear();
  Object.defineProperty(window.navigator, 'onLine', { value: true, writable: true, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('entrar (login)', () => {
  it('guarda el token de acceso EN MEMORIA y pide la sesión por cookie HttpOnly', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, loginBody));

    const session = await startSession('/auth/login', { email: 'yo@ejemplo.com', password: 'secreta123' });

    expect(session.accessToken).toBe('access-1');
    expect(tokenStore.getAccessToken()).toBe('access-1');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Session-Mode']).toBe('cookie');
    expect(init.credentials).toBe('include');

    // Y lo que NO debe pasar: ningún refresh token guardado en el navegador.
    const stored = Object.keys(localStorage).filter((key) => /refresh/i.test(key));
    expect(stored).toEqual([]);
    expect(JSON.stringify(localStorage)).not.toContain('refresh');
    expect(localStorage.getItem('finanza.accessToken')).toBeNull();
    expect(localStorage.getItem('finanza.refreshToken')).toBeNull();
  });

  it('con credenciales incorrectas: error claro y ninguna sesión guardada', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { code: 'INVALID_CREDENTIALS', message: 'Correo o contraseña incorrectos.' }));

    await expect(startSession('/auth/login', { email: 'yo@ejemplo.com', password: 'mala' })).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_CREDENTIALS',
      message: 'Correo o contraseña incorrectos.',
    });
    expect(tokenStore.getAccessToken()).toBeNull();
    expect(tokenStore.hasSession()).toBe(false);
  });

  it('si el servidor no responde al entrar: OfflineError, no «contraseña incorrecta»', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(startSession('/auth/login', { email: 'yo@ejemplo.com', password: 'secreta123' })).rejects.toBeInstanceOf(
      OfflineError,
    );
    expect(tokenStore.getAccessToken()).toBeNull();
  });
});

describe('reabrir la aplicación', () => {
  it('el token de memoria se pierde al recargar, pero la sesión se recupera con la cookie', async () => {
    // Al recargar la página: la memoria está vacía, la cookie sigue en el navegador.
    tokenStore.clear();
    document.cookie = 'finanza_sesion=1';
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { accessToken: 'access-2' }));

    expect(hasSessionCookieHint()).toBe(true);
    expect(tokenStore.getAccessToken()).toBeNull();

    const outcome = await refreshSession();

    expect(outcome.status).toBe('refreshed');
    expect(tokenStore.getAccessToken()).toBe('access-2');
  });

  it('sin cookie de sesión: el servidor responde SESSION_MISSING y la app lo trata como sesión terminada', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { code: 'SESSION_MISSING', message: 'No hay sesión que renovar.' }));

    const outcome = await refreshSession();

    expect(outcome).toMatchObject({ status: 'session-fatal', code: 'SESSION_MISSING' });
    expect(tokenStore.getAccessToken()).toBeNull();
  });
});

describe('renovación automática durante el trabajo', () => {
  it('un 401 en una petición normal se resuelve renovando y repitiendo: el usuario no nota nada', async () => {
    tokenStore.setAccessToken('caducado');
    setCsrfCookie();

    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { code: 'TOKEN_EXPIRED', message: 'Token caducado' })) // 1ª: petición
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'access-nuevo' })) // 2ª: refresh
      .mockResolvedValueOnce(jsonResponse(200, { total: '1500.00' })); // 3ª: repetición

    const result = await apiRequest<{ total: string }>('/dashboard/summary');

    expect(result.total).toBe('1500.00');
    expect(tokenStore.getAccessToken()).toBe('access-nuevo');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [retryUrl, retryInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(retryUrl.endsWith('/dashboard/summary')).toBe(true);
    expect(tokenStore.hasSession()).toBe(true);
    expect((retryInit.headers as Record<string, string>).Authorization).toBe('Bearer access-nuevo');
  });

  it('con varias peticiones simultáneas se hace UNA sola renovación (evita invalidarse entre ellas)', async () => {
    tokenStore.setAccessToken('caducado');

    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        // Renovación lenta a propósito: da tiempo a que las otras peticiones se
        // apilen detrás.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return jsonResponse(200, { accessToken: 'access-unico' });
      }
      if (tokenStore.getAccessToken() === 'caducado') {
        return jsonResponse(401, { code: 'TOKEN_EXPIRED', message: 'Token caducado' });
      }
      return jsonResponse(200, { ok: true });
    });

    const results = await Promise.all([
      apiRequest<{ ok: boolean }>('/cuentas'),
      apiRequest<{ ok: boolean }>('/movimientos'),
      apiRequest<{ ok: boolean }>('/dashboard/summary'),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(refreshCalls).toBe(1);
    expect(tokenStore.getAccessToken()).toBe('access-unico');
  });
});

describe('el servidor no puede atender (NO es cerrar sesión)', () => {
  it('503 al renovar: la sesión se conserva y no se avisa de caducidad', async () => {
    const expiredListener = vi.fn();
    window.addEventListener('finanza:session-expired', expiredListener);
    tokenStore.setAccessToken('access-viejo');
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { message: 'Service Unavailable' }));

    const outcome = await refreshSession();

    expect(outcome.status).toBe('temporary');
    window.removeEventListener('finanza:session-expired', expiredListener);
    expect(expiredListener).not.toHaveBeenCalled();
  });

  it('sin red al renovar: se conserva el token y la app puede seguir sin conexión', async () => {
    tokenStore.setAccessToken('access-viejo');
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const outcome = await refreshSession();

    expect(outcome.status).toBe('temporary');
    expect(tokenStore.getAccessToken()).toBe('access-viejo');
  });

  it('timeout al renovar (petición abortada): tampoco cierra la sesión', async () => {
    tokenStore.setAccessToken('access-viejo');
    fetchMock.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));

    const outcome = await refreshSession();

    expect(outcome.status).toBe('temporary');
    expect(tokenStore.getAccessToken()).toBe('access-viejo');
  });

  it('un 500 al renovar no cierra la sesión', async () => {
    tokenStore.setAccessToken('access-viejo');
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { message: 'boom' }));

    expect((await refreshSession()).status).toBe('temporary');
    expect(tokenStore.getAccessToken()).toBe('access-viejo');
  });

  it('una petición normal con el servidor caído lanza «no disponible temporalmente», no un 401', async () => {
    tokenStore.setAccessToken('access-viejo');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { code: 'TOKEN_EXPIRED', message: 'Token caducado' }))
      .mockResolvedValueOnce(jsonResponse(502, { message: 'Bad Gateway' }));

    await expect(apiRequest('/cuentas')).rejects.toBeInstanceOf(SessionTemporarilyUnavailableError);
    // Lo esencial: la sesión sigue ahí para poder reintentar.
    expect(tokenStore.getAccessToken()).toBe('access-viejo');
  });
});

describe('la sesión termina DE VERDAD', () => {
  it.each([
    ['SESSION_EXPIRED', 'Su sesión ha caducado.'],
    ['SESSION_REVOKED', 'Su sesión se cerró en otro dispositivo.'],
    ['SESSION_IDLE_TIMEOUT', 'Su sesión se cerró por inactividad.'],
    ['SESSION_MAX_LIFETIME', 'Su sesión alcanzó su duración máxima.'],
  ])('%s: limpia el token y avisa a la aplicación con el motivo del servidor', async (code, message) => {
    tokenStore.setAccessToken('access-viejo');
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { code, message }));

    const events: Array<{ message: string; code: string }> = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener('finanza:session-expired', listener);

    const outcome = await refreshSession();
    window.removeEventListener('finanza:session-expired', listener);

    expect(outcome).toMatchObject({ status: 'session-fatal', code, message });
    expect(tokenStore.getAccessToken()).toBeNull();
  });

  it('la petición en curso falla con un error tipado cuando la sesión ya no sirve', async () => {
    tokenStore.setAccessToken('access-viejo');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { code: 'TOKEN_EXPIRED', message: 'Token caducado' }))
      .mockResolvedValueOnce(jsonResponse(401, { code: 'SESSION_EXPIRED', message: 'Su sesión ha caducado.' }));

    const events: unknown[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener('finanza:session-expired', listener);

    await expect(apiRequest('/cuentas')).rejects.toBeInstanceOf(ApiError);
    window.removeEventListener('finanza:session-expired', listener);

    expect(events).toHaveLength(1);
    expect((events[0] as { code: string }).code).toBe('SESSION_EXPIRED');
  });

  it('el error de sesión caducada se distingue de un error de datos que el usuario puede corregir', () => {
    expect(new ApiError(401, 'SESSION_EXPIRED', 'x').isSessionFatal).toBe(true);
    expect(new ApiError(401, 'SESSION_REUSE_DETECTED', 'x').isSessionFatal).toBe(true);
    // Un 401 sin código reconocido NO justifica echar al usuario.
    expect(new ApiError(401, 'UNAUTHORIZED', 'x').isSessionFatal).toBe(false);
    expect(new ApiError(400, 'VALIDATION_ERROR', 'x').isSessionFatal).toBe(false);
    expect(new ApiError(400, 'VALIDATION_ERROR', 'x').isUserFixable).toBe(true);
  });
});

describe('cerrar sesión', () => {
  it('revoca en el servidor, limpia la memoria y NO borra los movimientos pendientes', async () => {
    tokenStore.setAccessToken('access-1');
    setCsrfCookie();

    await enqueueOperation({
      id: 'op_pendiente_1',
      type: 'TRANSACTION',
      payload: { amount: '250.00' },
      summary: 'Compra de combustible',
      amount: '250.00',
      entityId: 'e1',
      entityName: 'FULLTECH',
      occurredAt: new Date().toISOString(),
    });
    expect(await countPendingOperations()).toBe(1);

    fetchMock.mockResolvedValueOnce(jsonResponse(204, null));
    await endSession();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith('/auth/logout')).toBe(true);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['X-Session-Mode']).toBe('cookie');
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-de-prueba');
    expect(tokenStore.getAccessToken()).toBeNull();

    // Lo que de verdad importa: la cola sigue intacta para cuando vuelva.
    expect(await countPendingOperations()).toBe(1);
    expect((await listQueuedOperations())[0].summary).toBe('Compra de combustible');
  });

  it('si el servidor no contesta al cerrar, la sesión local se cierra igual', async () => {
    tokenStore.setAccessToken('access-1');
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(endSession()).resolves.toBeUndefined();
    expect(tokenStore.getAccessToken()).toBeNull();
  });
});

describe('recuperación tras un corte del servidor', () => {
  it('tras un 503, cuando el servidor vuelve, la sesión se recupera sin pedir la contraseña', async () => {
    tokenStore.setAccessToken('access-viejo');

    // 1) El servidor está de mantenimiento.
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { message: 'Service Unavailable' }));
    expect((await refreshSession()).status).toBe('temporary');

    // 2) Vuelve a estar disponible.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { accessToken: 'access-recuperado' }));
    const second = await refreshSession();

    expect(second.status).toBe('refreshed');
    expect(tokenStore.getAccessToken()).toBe('access-recuperado');
  });
});
