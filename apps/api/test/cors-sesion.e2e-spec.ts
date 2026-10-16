import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { buildCorsOptions } from '../src/common/cors.js';

/**
 * PRUEBA: LA API DEBE ACEPTAR LAS CABECERAS DE LA SESIÓN POR COOKIE
 * ================================================================
 * Esta prueba existe por un fallo real que dejó la aplicación imposible de usar
 * en el navegador, y que ninguna otra prueba detectó:
 *
 *   El navegador pregunta antes de cada petición que lleva cabeceras propias
 *   («preflight»). La API sólo autorizaba `Content-Type`, `Authorization`,
 *   `X-Device-Id` y `X-Client-Operation-Id`. Al añadir la sesión por cookie, la
 *   PWA empezó a enviar `X-Session-Mode` y `X-CSRF-Token`, que NO estaban en la
 *   lista. Resultado: el navegador bloqueaba el acceso con un error de CORS que
 *   en la pantalla se veía como «No se pudo contactar con el servidor», así que
 *   parecía un problema de red o de contraseña cuando era de configuración.
 *
 * Las pruebas de navegador no lo vieron porque se ejecutan en el MISMO origen que
 * la API (a través del proxy del servidor de desarrollo), y sin cambio de origen
 * no hay preflight. Esta prueba cierra ese hueco de verdad: comprueba la
 * respuesta de CORS que el navegador exige.
 *
 * La configuración NO se copia aquí: se importa `buildCorsOptions()`, la misma
 * que usa la API al arrancar. Así, quitar una cabecera de verdad hace fallar
 * esta prueba.
 */
describe('FINANZA — CORS y cabeceras de sesión (e2e)', () => {
  let app: INestApplication;

  /** Cabeceras propias que la PWA envía y que el navegador pregunta antes. */
  const CABECERAS_DE_LA_PWA = [
    'content-type',
    'authorization',
    'x-device-id',
    'x-client-operation-id',
    'x-session-mode',
    'x-csrf-token',
  ];

  const ORIGEN_PWA = 'http://localhost:5180';

  beforeAll(async () => {
    // El origen permitido se lee del entorno, como en la aplicación real.
    process.env.CORS_ORIGINS = ORIGEN_PWA;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.enableCors(buildCorsOptions());
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
    delete process.env.CORS_ORIGINS;
  });

  it('el «preflight» del acceso autoriza X-Session-Mode y X-CSRF-Token', async () => {
    const response = await request(app.getHttpServer())
      .options('/api/v1/auth/login')
      .set('Origin', ORIGEN_PWA)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', CABECERAS_DE_LA_PWA.join(','))
      .expect(204);

    const permitidas = String(response.headers['access-control-allow-headers'] ?? '')
      .toLowerCase()
      .split(',')
      .map((header) => header.trim());

    // Se informa de TODAS las que faltan de una vez, con la instrucción exacta de
    // dónde arreglarlo: un error de CORS es difícil de leer de otra manera.
    const faltan = CABECERAS_DE_LA_PWA.filter((cabecera) => !permitidas.includes(cabecera));
    if (faltan.length > 0) {
      throw new Error(
        `La API no autoriza estas cabeceras que la PWA envía: ${faltan.join(', ')}.\n` +
          'El navegador bloqueará las peticiones con un error de CORS y en la pantalla se verá\n' +
          'como «no se pudo contactar con el servidor».\n' +
          'Añádalas a ALLOWED_REQUEST_HEADERS en apps/api/src/common/cors.ts',
      );
    }
    expect(faltan).toEqual([]);
  });

  it('el «preflight» de la renovación de sesión también las autoriza', async () => {
    const response = await request(app.getHttpServer())
      .options('/api/v1/auth/refresh')
      .set('Origin', ORIGEN_PWA)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', CABECERAS_DE_LA_PWA.join(','))
      .expect(204);

    const permitidas = String(response.headers['access-control-allow-headers'] ?? '').toLowerCase();
    expect(permitidas).toContain('x-session-mode');
    expect(permitidas).toContain('x-csrf-token');
  });

  it('la respuesta identifica el origen de la PWA y admite cookies', async () => {
    const response = await request(app.getHttpServer())
      .options('/api/v1/auth/login')
      .set('Origin', ORIGEN_PWA)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-session-mode')
      .expect(204);

    expect(response.headers['access-control-allow-origin']).toBe(ORIGEN_PWA);
    // Sin esto, el navegador no enviaría la cookie HttpOnly de la sesión.
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });
});
