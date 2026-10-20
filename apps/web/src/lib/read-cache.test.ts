import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, OfflineError, tokenStore } from './api';
import { db, pruneCachedResponses, putCachedResponse } from './db';
import { CADUCIDAD_CACHE_MS, readCachedResponse, rememberResponse } from './read-cache';
import { RUTAS_ESENCIALES } from './prewarm';

/**
 * CACHÉ DE LECTURA: SIN CONEXIÓN LA APP SIGUE MOSTRANDO CIFRAS REALES
 * ===================================================================
 * La exigencia del usuario es clara: «que la app funcione completamente sin
 * internet, por lo menos 24 horas, con caché y de forma inteligente».
 *
 * Lo que se comprueba aquí, con IndexedDB real (en memoria) y la red simulada:
 *
 *  1. Con servidor se pregunta SIEMPRE al servidor (la caché no tapa lo nuevo).
 *  2. Sin servidor se devuelve la última respuesta buena de esa misma consulta.
 *  3. Si no hay copia, se avisa con un error: nunca se inventa un cero.
 *  4. Las ESCRITURAS (POST/PATCH/DELETE) jamás se sirven de la caché.
 *  5. Lo que depende de saldos del momento (preparar un cierre) tampoco.
 *  6. La caché caduca y no crece sin límite.
 */

const setOnline = (online: boolean) => {
  Object.defineProperty(window.navigator, 'onLine', { value: online, writable: true, configurable: true });
};

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await db.cacheResponses.clear();
  tokenStore.setAccessToken('token-de-prueba');
  setOnline(true);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

describe('caché de lectura', () => {
  it('guarda la respuesta y la devuelve con su hora', async () => {
    await rememberResponse('/cuentas', { total: '125800.00' });

    const guardado = await readCachedResponse<{ total: string }>('/cuentas');
    expect(guardado?.data.total).toBe('125800.00');
    expect(Number.isNaN(new Date(guardado!.cachedAt).getTime())).toBe(false);
  });

  it('una copia más vieja que la caducidad ya no se usa', async () => {
    await putCachedResponse('/cuentas', JSON.stringify({ total: '1.00' }));
    await db.cacheResponses.update('/cuentas', {
      cachedAt: new Date(Date.now() - CADUCIDAD_CACHE_MS - 60_000).toISOString(),
    });

    expect(await readCachedResponse('/cuentas')).toBeNull();
  });

  it('el recorte borra lo viejo y respeta el tope de entradas', async () => {
    await putCachedResponse('/viejo', JSON.stringify({ ok: true }));
    await db.cacheResponses.update('/viejo', { cachedAt: '2020-01-01T00:00:00.000Z' });
    for (const ruta of ['/a', '/b', '/c']) {
      await putCachedResponse(ruta, JSON.stringify({ ok: true }));
    }

    await pruneCachedResponses(CADUCIDAD_CACHE_MS, 2);

    expect(await db.cacheResponses.get('/viejo')).toBeUndefined();
    expect(await db.cacheResponses.count()).toBe(2);
  });
});

describe('consultas con la red caída', () => {
  it('con servidor se pregunta al servidor y se guarda la copia', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ availableCash: '74000.00' }));

    const resumen = await apiRequest<{ availableCash: string }>('/dashboard/summary?preset=TODAY');

    expect(resumen.availableCash).toBe('74000.00');
    expect(await db.cacheResponses.get('/dashboard/summary?preset=TODAY')).toBeDefined();
  });

  it('sin conexión devuelve la última copia buena en vez de romper la pantalla', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ availableCash: '74000.00' }));
    await apiRequest('/dashboard/summary?preset=TODAY');

    // Se pierde la señal: ni siquiera se intenta la petición (falla al instante).
    setOnline(false);
    fetchMock.mockClear();

    const resumen = await apiRequest<{ availableCash: string }>('/dashboard/summary?preset=TODAY');

    expect(resumen.availableCash).toBe('74000.00');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('si el servidor contesta 502 también se usa la copia (no es «sin datos»)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ deudas: 3 }));
    await apiRequest('/loans?limit=100');

    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Bad Gateway' }, 502));
    const deudas = await apiRequest<{ deudas: number }>('/loans?limit=100');

    expect(deudas.deudas).toBe(3);
  });

  it('sin copia guardada se avisa con un error: no se inventa un cero', async () => {
    setOnline(false);

    await expect(apiRequest('/loans/summary')).rejects.toBeInstanceOf(OfflineError);
  });

  it('un error que el usuario puede corregir (400) NO se tapa con la caché', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ total: '10.00' }));
    await apiRequest('/cuentas');

    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'VALIDATION_ERROR', message: 'Filtro inválido' }, 400));

    await expect(apiRequest('/cuentas')).rejects.toMatchObject({ status: 400 });
  });
});

describe('lo que NUNCA se sirve de la caché', () => {
  it('las escrituras (POST) fallan sin conexión aunque haya una copia de esa ruta', async () => {
    await rememberResponse('/categories', { data: [] });
    setOnline(false);

    await expect(apiRequest('/categories', { method: 'POST', body: { name: 'Comida' } })).rejects.toBeInstanceOf(
      OfflineError,
    );
  });

  it('preparar un cierre se calcula con los saldos de ahora: no se reutiliza una copia', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ expectedBalance: '100.00' }));
    await apiRequest('/closings/prepare?entityId=e1&date=2026-10-20');

    // Deja de poder guardarse (es una ruta excluida).
    expect(await db.cacheResponses.get('/closings/prepare?entityId=e1&date=2026-10-20')).toBeUndefined();

    setOnline(false);
    await expect(apiRequest('/closings/prepare?entityId=e1&date=2026-10-20')).rejects.toBeInstanceOf(OfflineError);
  });

  it('las listas de compras tienen su propia copia local: no se mezclan con esta caché', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'l1' }] }));
    await apiRequest('/shopping-lists?status=ACTIVE');

    expect(await db.cacheResponses.get('/shopping-lists?status=ACTIVE')).toBeUndefined();
  });

  it('el resumen de compras del panel sí se guarda (es una cifra de sólo lectura)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ openLists: 2 }));
    await apiRequest('/shopping-lists/summary');

    expect(await db.cacheResponses.get('/shopping-lists/summary')).toBeDefined();
  });
});

describe('copia preparada de antemano', () => {
  it('incluye las pantallas principales y ninguna escritura ni cierre', () => {
    expect(RUTAS_ESENCIALES).toContain('/dashboard/summary?preset=TODAY');
    expect(RUTAS_ESENCIALES).toContain('/accounts?includeClosed=true');
    expect(RUTAS_ESENCIALES).toContain('/loans?limit=100');
    expect(RUTAS_ESENCIALES.some((ruta) => ruta.startsWith('/closings'))).toBe(false);
    expect(RUTAS_ESENCIALES.every((ruta) => !ruta.startsWith('/sync'))).toBe(true);
  });
});
