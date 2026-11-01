import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter.js';
import { SerializationInterceptor } from '../src/common/serialization.interceptor.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { hashPassword } from '../src/auth/password.js';
import { businessDateToIso, businessToday } from '../src/domain/business-date.js';

/**
 * TRASPASO ENTRE DOS UNIDADES FINANCIERAS (por la vía de la app)
 * ==============================================================
 * El usuario reportó «dice que sí pero no se está pasando». Esta prueba fija el
 * comportamiento correcto por la MISMA vía que usa el teléfono (POST /sync/push):
 * el dinero sale de la cuenta de origen y entra en la de destino.
 */
describe('Traspaso entre unidades por la vía de sincronización', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token = '';
  const runId = Date.now().toString(36);
  const password = 'Diag2026!segura';
  const today = businessDateToIso(businessToday());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new SerializationInterceptor());
    await app.listen(0);
    const prisma = app.get(PrismaService);
    const email = `diag.traspaso.${runId}@finanza.test`;
    await prisma.user.create({ data: { email, name: 'Diag', passwordHash: await hashPassword(password), role: 'OWNER' } });
    http = request(app.getHttpServer());
    const login = await http.post('/api/v1/auth/login').send({ email, password, deviceId: `d-${runId}` }).expect(201);
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('mueve el dinero entre dos unidades', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const a = await http.post('/api/v1/entities').set(auth).send({ name: `Diag A ${runId}`, type: 'BUSINESS' }).expect(201);
    const b = await http.post('/api/v1/entities').set(auth).send({ name: `Diag B ${runId}`, type: 'BUSINESS' }).expect(201);

    const crear = async (entityId: string, name: string, openingBalance: string) => {
      const r = await http
        .post('/api/v1/accounts')
        .set(auth)
        .send({ entityId, name, type: 'BANK', openingBalance, openingDate: today })
        .expect(201);
      return r.body.id as string;
    };

    const origenId = await crear(a.body.id, 'Banco origen', '1000.00');
    const destinoId = await crear(b.body.id, 'Banco destino', '0.00');

    const push = await http
      .post('/api/v1/sync/push')
      .set(auth)
      .send({
        deviceId: `d-${runId}`,
        platform: 'jest',
        clientRecordedAt: new Date().toISOString(),
        operations: [
          {
            clientOperationId: `diag_${runId}`,
            clientRecordedAt: new Date().toISOString(),
            operation: {
              type: 'TRANSFER',
              payload: {
                fromAccountId: origenId,
                toAccountId: destinoId,
                amount: '250.00',
                businessDate: today,
                description: 'Traspaso de diagnostico',
              },
            },
          },
        ],
      });

    const origen = await http.get(`/api/v1/accounts/${origenId}`).set(auth).expect(200);
    const destino = await http.get(`/api/v1/accounts/${destinoId}`).set(auth).expect(200);

    expect(push.body.results?.[0]?.status).toBe('APPLIED');
    expect({ origen: origen.body.balance, destino: destino.body.balance }).toEqual({ origen: '750.00', destino: '250.00' });
  });
});
