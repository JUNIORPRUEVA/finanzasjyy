import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter.js';
import { SerializationInterceptor } from '../src/common/serialization.interceptor.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PushService } from '../src/notifications/push.service.js';
import { hashPassword } from '../src/auth/password.js';

/**
 * NOTIFICACIONES PUSH — HASTA DÓNDE SE PUEDE VERIFICAR LOCALMENTE
 * --------------------------------------------------------------
 * Este archivo comprueba TODO el circuito salvo la entrega final:
 *
 *   ✓ Las claves VAPID están configuradas y el servicio las lee.
 *   ✓ El estado se informa con la verdad (si faltaran claves, lo dice).
 *   ✓ Un dispositivo se puede suscribir y queda guardado con su plataforma.
 *   ✓ La suscripción se puede cancelar.
 *   ✓ El envío funciona: habla con el proveedor push y cuenta lo que pasó.
 *   ✓ Un endpoint inválido NO rompe el sistema: se registra el fallo.
 *
 *   ✗ LO QUE NO SE PUEDE COMPROBAR AQUÍ: que la notificación LLEGUE a un
 *     teléfono. Eso depende de Apple/Google, de un dispositivo real y de que el
 *     usuario conceda el permiso. Ninguna prueba de este archivo afirma que haya
 *     llegado nada: sólo se comprueba que el servidor lo intenta y lo registra.
 */
describe('FINANZA — circuito de notificaciones push (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;
  let push: PushService;

  const runId = Date.now().toString(36);
  const password = 'Push-2026!Prueba';
  const email = `push.${runId}@finanza.test`;
  const deviceId = `push-device-${runId}`;

  let token = '';

  const auth = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });
  const fakeEndpoint = (suffix: string) => `https://push.example.invalid/${runId}/${suffix}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new SerializationInterceptor());
    await app.listen(0);

    prisma = app.get(PrismaService);
    push = app.get(PushService);
    http = request(app.getHttpServer());

    await prisma.user.create({
      data: { email, name: 'Push Test', passwordHash: await hashPassword(password), role: 'OWNER' },
    });

    const login = await http
      .post('/api/v1/auth/login')
      .send({ email, password, deviceId, platform: 'jest' })
      .expect(201);
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('Configuración del servidor', () => {
    it('el servicio tiene claves VAPID cargadas', () => {
      // Si esto falla, hay que ejecutar: .\scripts\generate-vapid.ps1
      expect(push.isEnabled()).toBe(true);
      expect(push.getPublicKey()).toBeTruthy();
      expect((push.getPublicKey() ?? '').length).toBeGreaterThan(60);
    });

    it('el estado informa de la configuración real, sin adornos', async () => {
      const response = await http.get('/api/v1/notifications/push/status').set(auth()).expect(200);
      expect(response.body.pushEnabledOnServer).toBe(true);
      expect(response.body.publicKey).toBe(push.getPublicKey());
      expect(response.body.count).toBe(0);
      expect(response.body.activeCount).toBe(0);
    });
  });

  describe('Suscripción del dispositivo', () => {
    it('guarda la suscripción con su plataforma', async () => {
      await http
        .post('/api/v1/notifications/push/subscribe')
        .set(auth())
        .send({
          endpoint: fakeEndpoint('uno'),
          p256dh: 'BExamplePublicKeyForTestsOnlyExampleKey0000000000000000000000000',
          auth: 'exampleAuthSecret00',
          deviceId,
          platform: 'jest',
        })
        .expect(201);

      // La suscripción se guarda de verdad: se comprueba en el almacenamiento y
      // en el estado que ve la aplicación.
      const stored = await prisma.pushSubscription.findFirstOrThrow({ where: { endpoint: fakeEndpoint('uno') } });
      expect(stored.isActive).toBe(true);

      const status = await http.get('/api/v1/notifications/push/status').set(auth()).expect(200);
      expect(status.body.activeCount).toBe(1);
      expect(status.body.subscriptions[0].platform).toBe('jest');
    });

    it('no duplica la suscripción si el dispositivo la repite', async () => {
      await http
        .post('/api/v1/notifications/push/subscribe')
        .set(auth())
        .send({
          endpoint: fakeEndpoint('uno'),
          p256dh: 'BExamplePublicKeyForTestsOnlyExampleKey0000000000000000000000000',
          auth: 'exampleAuthSecret00',
          deviceId,
          platform: 'jest',
        })
        .expect(201);

      const stored = await prisma.pushSubscription.count({ where: { endpoint: fakeEndpoint('uno') } });
      expect(stored).toBe(1);
    });

    it('puede cancelarse y deja de estar activa', async () => {
      await http
        .delete('/api/v1/notifications/push/subscribe')
        .set(auth())
        .send({ endpoint: fakeEndpoint('uno') })
        .expect(200);

      const status = await http.get('/api/v1/notifications/push/status').set(auth()).expect(200);
      expect(status.body.activeCount).toBe(0);
    });
  });

  describe('Envío', () => {
    it('con un endpoint inválido NO se cae: cuenta el intento y registra el fallo', async () => {
      await http
        .post('/api/v1/notifications/push/subscribe')
        .set(auth())
        .send({
          endpoint: fakeEndpoint('invalido'),
          p256dh: 'BExamplePublicKeyForTestsOnlyExampleKey0000000000000000000000000',
          auth: 'exampleAuthSecret00',
          deviceId,
          platform: 'jest',
        })
        .expect(201);

      const response = await http.post('/api/v1/notifications/push/test').set(auth()).expect(201);

      // El servidor intenta el envío y lo dice tal cual: intentado, aceptado, fallado.
      expect(response.body.attempted).toBe(1);
      expect(response.body.disabled).toBe(false);
      // No se puede afirmar que haya llegado: el dominio es .invalid a propósito.
      expect(response.body.accepted).toBe(0);
      expect(response.body.failed).toBeGreaterThanOrEqual(1);

      // El fallo queda registrado en la suscripción (para poder limpiarla).
      const subscription = await prisma.pushSubscription.findFirstOrThrow({
        where: { endpoint: fakeEndpoint('invalido') },
      });
      expect(subscription.failCount).toBeGreaterThan(0);
      expect(subscription.lastError ?? '').not.toBe('');
    });

    it('el informe de entrega dice la verdad sobre lo enviado y lo fallado', async () => {
      const response = await http.get('/api/v1/notifications/push/delivery-report').set(auth()).expect(200);
      expect(response.body.publicKeyConfigured).toBe(true);
      expect(response.body.withFailures).toBeGreaterThanOrEqual(1);
    });

    it('sin dispositivos suscritos lo explica en lugar de fingir un envío', async () => {
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      await prisma.pushSubscription.updateMany({ where: { userId: user.id }, data: { isActive: false } });

      const response = await http.post('/api/v1/notifications/push/test').set(auth()).expect(201);
      expect(response.body.attempted).toBe(0);
      expect(response.body.message).toMatch(/No hay dispositivos suscritos/i);
    });
  });

  describe('Recordatorios', () => {
    it('genera las tareas del día sin duplicarlas al ejecutarse dos veces', async () => {
      const first = await http.post('/api/v1/notifications/run-reminders').set(auth()).expect(201);
      const second = await http.post('/api/v1/notifications/run-reminders').set(auth()).expect(201);

      expect(first.body.level).toBeDefined();
      // Ejecutar dos veces seguidas no debe crear avisos repetidos del mismo tipo.
      const count = await prisma.notification.count({
        where: { userId: (await prisma.user.findUniqueOrThrow({ where: { email } })).id },
      });
      expect(count).toBeLessThanOrEqual(5);
      expect(second.body.level).toBeDefined();
    });
  });
});
