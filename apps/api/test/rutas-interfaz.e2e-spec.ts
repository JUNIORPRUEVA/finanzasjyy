import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter.js';
import { SerializationInterceptor } from '../src/common/serialization.interceptor.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { hashPassword } from '../src/auth/password.js';

/**
 * LAS RUTAS QUE OFRECE LA INTERFAZ EXISTEN DE VERDAD
 * =================================================
 * Esta suite nace de un fallo real: el menú lateral ofrecía **Auditoría**, la
 * pantalla estaba escrita, el servicio de auditoría funcionaba y los registros se
 * guardaban... pero `GET /audit` respondía 404, porque el controlador no estaba
 * declarado en su módulo. La pantalla existía y no servía para nada.
 *
 * Es un tipo de fallo que ninguna prueba de lógica detecta: todo está bien por
 * dentro y lo que falta es el enchufe. Aquí se comprueba el enchufe: cada ruta
 * que la aplicación ofrece responde, y las que exigen permiso lo exigen de
 * verdad.
 */

describe('FINANZA — rutas que ofrece la interfaz (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  const runId = Date.now().toString(36);
  const password = 'PruebaE2E-2026!';
  const ownerEmail = `rutas.owner.${runId}@finanza.test`;
  const memberEmail = `rutas.member.${runId}@finanza.test`;

  let token = '';
  let memberToken = '';

  const auth = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });
  const authMember = (): Record<string, string> => ({ Authorization: `Bearer ${memberToken}` });

  /**
   * Rutas que la PWA pide al abrirse o al entrar en una pantalla. Si alguna
   * desapareciera, el usuario vería un aviso de error en esa pantalla.
   */
  const RUTAS_DE_LA_INTERFAZ = [
    '/api/v1/auth/me',
    '/api/v1/auth/preferences',
    '/api/v1/auth/sessions',
    '/api/v1/shopping-lists',
    '/api/v1/shopping-lists/summary',
    '/api/v1/dashboard/summary?preset=TODAY',
    '/api/v1/dashboard/charts?days=30',
    '/api/v1/daily-control',
    '/api/v1/notifications/tasks',
    '/api/v1/notifications/push/status',
    '/api/v1/accounts',
    '/api/v1/categories',
    '/api/v1/ledger/integrity',
    '/api/v1/audit?page=1&limit=40',
  ];

  const login = async (email: string) =>
    (
      await http
        .post('/api/v1/auth/login')
        .send({ email, password, deviceId: `e2e-rutas-${email}-${runId}`, platform: 'jest' })
        .expect(201)
    ).body.accessToken as string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new SerializationInterceptor());
    await app.listen(0);

    prisma = app.get(PrismaService);
    http = request(app.getHttpServer());

    await prisma.user.create({
      data: { email: ownerEmail, name: 'Rutas Owner', passwordHash: await hashPassword(password), role: 'OWNER' },
    });
    await prisma.user.create({
      data: { email: memberEmail, name: 'Rutas Member', passwordHash: await hashPassword(password), role: 'MEMBER' },
    });

    token = await login(ownerEmail);
    memberToken = await login(memberEmail);
  });

  afterAll(async () => {
    await app.close();
  });

  it('cada ruta que ofrece la interfaz existe (ninguna responde 404)', async () => {
    const missing: string[] = [];

    for (const route of RUTAS_DE_LA_INTERFAZ) {
      const response = await http.get(route).set(auth());
      if (response.status === 404) {
        missing.push(route);
      }
    }

    // Si alguna falta, el mensaje dice cuál y por qué importa.
    if (missing.length > 0) {
      throw new Error(
        `Estas rutas las pide la aplicación y no existen:\n${missing.join('\n')}\n` +
          'Una pantalla que las use mostrará un error y el usuario no sabrá por qué.',
      );
    }
    expect(missing).toEqual([]);
  });

  it('las rutas clave responden con datos (no basta con que existan)', async () => {
    for (const route of [
      '/api/v1/audit?page=1&limit=40',
      '/api/v1/shopping-lists',
      '/api/v1/shopping-lists/summary',
      '/api/v1/dashboard/summary?preset=TODAY',
      '/api/v1/daily-control',
      '/api/v1/notifications/tasks',
    ]) {
      await http.get(route).set(auth()).expect(200);
    }
  });

  it('una ruta inventada SÍ responde 404 (control positivo)', async () => {
    // Sin esta comprobación, la prueba anterior podría pasar por accidente si el
    // servidor respondiera 200 a cualquier cosa.
    await http.get('/api/v1/ruta-que-no-existe').set(auth()).expect(404);
  });

  it('la auditoría es sólo para propietarios y administradores', async () => {
    await http.get('/api/v1/audit?page=1&limit=40').set(auth()).expect(200);
    await http.get('/api/v1/audit?page=1&limit=40').set(authMember()).expect(403);
  });

  it('las rutas de la interfaz exigen sesión', async () => {
    for (const route of [
      '/api/v1/audit?page=1&limit=40',
      '/api/v1/shopping-lists',
      '/api/v1/shopping-lists/summary',
      '/api/v1/daily-control',
    ]) {
      await http.get(route).expect(401);
    }
  });
});
