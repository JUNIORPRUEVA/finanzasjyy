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
 * FASE 2 — ESTRUCTURA JURÍDICA
 * ============================
 * Se comprueba lo que de verdad puede romper la contabilidad:
 *
 *  A · dos cuentas de la misma unidad      → un asiento
 *  B · FULLTECH y APPYRA (misma sociedad)  → traslado interno, puente 1150 a cero
 *  C · sociedad y propietario              → RECHAZADO hasta clasificar
 *  D · unidad sin relación confirmada      → RECHAZADO, se pide confirmarla
 *
 * Y que la jerarquía no admite vínculos imposibles (ciclos, finanzas personales
 * dentro de una sociedad, padres de otra persona jurídica).
 */
describe('Estructura jurídica de las unidades', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token = '';
  const runId = Date.now().toString(36);
  const password = 'Estructura2026!segura';
  const today = businessDateToIso(businessToday());

  const auth = () => ({ Authorization: `Bearer ${token}` });

  const crearUnidad = async (nombre: string, type: 'BUSINESS' | 'PERSONAL') => {
    const r = await http.post('/api/v1/entities').set(auth()).send({ name: nombre, type }).expect(201);
    return r.body.id as string;
  };

  const crearCuenta = async (entityId: string, name: string, openingBalance: string) => {
    const r = await http
      .post('/api/v1/accounts')
      .set(auth())
      .send({ entityId, name, type: 'BANK', openingBalance, openingDate: today })
      .expect(201);
    return r.body.id as string;
  };

  const saldo = async (accountId: string) => {
    const r = await http.get(`/api/v1/accounts/${accountId}`).set(auth()).expect(200);
    return r.body.balance as string;
  };

  const traspasar = (fromAccountId: string, toAccountId: string, amount = '250.00') =>
    http
      .post('/api/v1/transfers')
      .set(auth())
      .send({ fromAccountId, toAccountId, amount, businessDate: today, description: 'Traslado de prueba' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new SerializationInterceptor());
    await app.listen(0);
    const prisma = app.get(PrismaService);
    const email = `estructura.${runId}@finanza.test`;
    await prisma.user.create({ data: { email, name: 'Estructura', passwordHash: await hashPassword(password), role: 'OWNER' } });
    http = request(app.getHttpServer());
    const login = await http.post('/api/v1/auth/login').send({ email, password, deviceId: `d-${runId}` }).expect(201);
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('B · mueve dinero entre dos unidades de la MISMA sociedad sin generar deuda externa', async () => {
    const srl = await http
      .post('/api/v1/entities/legal-entities')
      .set(auth())
      .send({ name: `SRL Prueba ${runId}`, kind: 'COMPANY' })
      .expect(201);

    const fulltech = await crearUnidad(`Fulltech ${runId}`, 'BUSINESS');
    const appyra = await crearUnidad(`Appyra ${runId}`, 'BUSINESS');

    // APPYRA es una MARCA de FULLTECH: misma sociedad y colgando de la principal.
    await http.patch(`/api/v1/entities/${fulltech}/structure`).set(auth()).send({ legalEntityId: srl.body.id }).expect(200);
    await http
      .patch(`/api/v1/entities/${appyra}/structure`)
      .set(auth())
      .send({ legalEntityId: srl.body.id, parentEntityId: fulltech })
      .expect(200);

    const cajaOrigen = await crearCuenta(fulltech, 'Caja principal', '1000.00');
    const bancoDestino = await crearCuenta(appyra, 'Banco marca', '0.00');

    // La pantalla puede preguntar la relación ANTES de registrar.
    const preview = await http
      .post('/api/v1/transfers/relation')
      .set(auth())
      .send({ fromAccountId: cajaOrigen, toAccountId: bancoDestino })
      .expect(201);
    expect(preview.body.relation).toBe('SAME_LEGAL_ENTITY');
    expect(preview.body.allowed).toBe(true);
    expect(preview.body.posting).toBe('TWO_ENTRIES_BRIDGE');

    await traspasar(cajaOrigen, bancoDestino).expect(201);

    expect(await saldo(cajaOrigen)).toBe('750.00');
    expect(await saldo(bancoDestino)).toBe('250.00');

    // El puente 1150 es INTERNO: al consolidar esa sociedad queda en CERO.
    const check = await http.get('/api/v1/transfers/intercompany-check').set(auth()).expect(200);
    expect(check.body.balance).toBe('0.00');
    const deLaSociedad = check.body.byLegalEntity.find(
      (row: { legalEntityCode: string | null }) => row.legalEntityCode === srl.body.code,
    );
    expect(deLaSociedad?.balance).toBe('0.00');
    expect(deLaSociedad?.balanced).toBe(true);
  });

  it('C · RECHAZA mover dinero entre la sociedad y el propietario sin clasificar', async () => {
    const srl = await http
      .post('/api/v1/entities/legal-entities')
      .set(auth())
      .send({ name: `SRL Dos ${runId}`, kind: 'COMPANY' })
      .expect(201);
    const persona = await http
      .post('/api/v1/entities/legal-entities')
      .set(auth())
      .send({ name: `Persona ${runId}`, kind: 'INDIVIDUAL' })
      .expect(201);

    const empresa = await crearUnidad(`Empresa C ${runId}`, 'BUSINESS');
    const personal = await crearUnidad(`Personal C ${runId}`, 'PERSONAL');
    await http.patch(`/api/v1/entities/${empresa}/structure`).set(auth()).send({ legalEntityId: srl.body.id }).expect(200);
    await http.patch(`/api/v1/entities/${personal}/structure`).set(auth()).send({ legalEntityId: persona.body.id }).expect(200);

    const bancoEmpresa = await crearCuenta(empresa, 'Banco empresa', '5000.00');
    const bancoPersonal = await crearCuenta(personal, 'Banco personal', '0.00');

    const preview = await http
      .post('/api/v1/transfers/relation')
      .set(auth())
      .send({ fromAccountId: bancoEmpresa, toAccountId: bancoPersonal })
      .expect(201);
    expect(preview.body.relation).toBe('DIFFERENT_LEGAL_ENTITY');
    expect(preview.body.allowed).toBe(false);

    const rechazo = await traspasar(bancoEmpresa, bancoPersonal).expect(400);
    expect(String(rechazo.body.message)).toMatch(/clasificar/i);

    // Y no se movió nada.
    expect(await saldo(bancoEmpresa)).toBe('5000.00');
    expect(await saldo(bancoPersonal)).toBe('0.00');
  });

  it('D · RECHAZA mover dinero hacia una unidad sin relación jurídica confirmada', async () => {
    const srl = await http
      .post('/api/v1/entities/legal-entities')
      .set(auth())
      .send({ name: `SRL Tres ${runId}`, kind: 'COMPANY' })
      .expect(201);
    const conocida = await crearUnidad(`Conocida D ${runId}`, 'BUSINESS');
    const desconocida = await crearUnidad(`Sin confirmar D ${runId}`, 'BUSINESS');
    await http.patch(`/api/v1/entities/${conocida}/structure`).set(auth()).send({ legalEntityId: srl.body.id }).expect(200);

    const bancoConocido = await crearCuenta(conocida, 'Banco conocido', '800.00');
    const bancoDesconocido = await crearCuenta(desconocida, 'Banco sin confirmar', '0.00');

    const rechazo = await traspasar(bancoConocido, bancoDesconocido).expect(400);
    expect(String(rechazo.body.message)).toMatch(/no está confirmada/i);
    expect(await saldo(bancoConocido)).toBe('800.00');
  });

  it('no admite un ciclo entre unidades', async () => {
    const padre = await crearUnidad(`Padre ciclo ${runId}`, 'BUSINESS');
    const hijo = await crearUnidad(`Hijo ciclo ${runId}`, 'BUSINESS');

    await http.patch(`/api/v1/entities/${hijo}/structure`).set(auth()).send({ parentEntityId: padre }).expect(200);

    // El padre no puede acabar dependiendo de su propio hijo.
    const rechazo = await http
      .patch(`/api/v1/entities/${padre}/structure`)
      .set(auth())
      .send({ parentEntityId: hijo })
      .expect(400);
    expect(String(rechazo.body.message)).toMatch(/ciclo/i);
  });

  it('no admite que una unidad dependa de sí misma', async () => {
    const unidad = await crearUnidad(`Autociclo ${runId}`, 'BUSINESS');
    const rechazo = await http
      .patch(`/api/v1/entities/${unidad}/structure`)
      .set(auth())
      .send({ parentEntityId: unidad })
      .expect(400);
    expect(String(rechazo.body.message)).toMatch(/de sí misma/i);
  });

  it('no admite finanzas personales dentro de una sociedad', async () => {
    const srl = await http
      .post('/api/v1/entities/legal-entities')
      .set(auth())
      .send({ name: `SRL Cuatro ${runId}`, kind: 'COMPANY' })
      .expect(201);
    const personal = await crearUnidad(`Personal incompatible ${runId}`, 'PERSONAL');

    const rechazo = await http
      .patch(`/api/v1/entities/${personal}/structure`)
      .set(auth())
      .send({ legalEntityId: srl.body.id })
      .expect(400);
    expect(String(rechazo.body.message)).toMatch(/persona física/i);
  });

  it('no admite que un negocio dependa de las finanzas personales', async () => {
    const persona = await http
      .post('/api/v1/entities/legal-entities')
      .set(auth())
      .send({ name: `Persona colgado ${runId}`, kind: 'INDIVIDUAL' })
      .expect(201);
    const personal = await crearUnidad(`Personal colgado ${runId}`, 'PERSONAL');
    await http.patch(`/api/v1/entities/${personal}/structure`).set(auth()).send({ legalEntityId: persona.body.id }).expect(200);

    const negocio = await crearUnidad(`Negocio colgado ${runId}`, 'BUSINESS');
    const rechazo = await http
      .patch(`/api/v1/entities/${negocio}/structure`)
      .set(auth())
      .send({ parentEntityId: personal })
      .expect(400);
    expect(String(rechazo.body.message)).toMatch(/finanzas personales/i);
  });

  it('lista las personas jurídicas y las unidades sin confirmar', async () => {
    const srl = await http
      .post('/api/v1/entities/legal-entities')
      .set(auth())
      .send({ name: `SRL Listado ${runId}`, kind: 'COMPANY' })
      .expect(201);
    const dentro = await crearUnidad(`Dentro ${runId}`, 'BUSINESS');
    const fuera = await crearUnidad(`Fuera ${runId}`, 'BUSINESS');
    await http.patch(`/api/v1/entities/${dentro}/structure`).set(auth()).send({ legalEntityId: srl.body.id }).expect(200);

    const r = await http.get('/api/v1/entities/legal-entities').set(auth()).expect(200);

    const listada = r.body.legalEntities.find((row: { id: string }) => row.id === srl.body.id);
    expect(listada).toBeTruthy();
    expect(listada.entities.map((e: { id: string }) => e.id)).toContain(dentro);

    // La unidad a la que no se le confirmó nada aparece aparte, no dentro de una
    // sociedad inventada.
    expect(r.body.unconfirmed.map((e: { id: string }) => e.id)).toContain(fuera);
    expect(r.body.explanation).toMatch(/no tienen la relación jurídica confirmada/i);
  });
});
