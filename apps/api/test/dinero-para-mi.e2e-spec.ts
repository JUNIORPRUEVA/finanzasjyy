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
 * «DINERO PARA MÍ» — SACAR DINERO DE LA EMPRESA A MI CUENTA
 * ========================================================
 * El problema real que resuelve: el retiro bajaba el banco de la empresa y el
 * dinero «desaparecía» de FINANZA, porque no entraba en ninguna cuenta del
 * propietario. Y moverlo con un traspaso estaba (con razón) bloqueado.
 *
 * Lo que se comprueba aquí:
 *
 *  1. Sin decir qué es el dinero, **sigue bloqueado** (no se adivina).
 *  2. «Es mi dinero»: baja el banco de la empresa y **sube el banco personal**,
 *     sin ningún ingreso ni gasto, y **sin cambiar el patrimonio personal**.
 *  3. «Es un préstamo»: nace la deuda en los dos lados y **exige documento**.
 *  4. El reintento no duplica.
 *  5. Sólo aplica de una empresa hacia las finanzas personales.
 */
describe('Dinero para mí: de la empresa a mi cuenta personal', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token = '';
  const runId = Date.now().toString(36);
  const password = 'DineroParaMi2026!segura';
  const today = businessDateToIso(businessToday());

  const auth = () => ({ Authorization: `Bearer ${token}` });

  let empresaId = '';
  let personalId = '';
  let srlId = '';
  let bancoEmpresa = '';
  let bancoPersonal = '';

  const saldo = async (accountId: string) => {
    const r = await http.get(`/api/v1/accounts/${accountId}`).set(auth()).expect(200);
    return r.body.balance as string;
  };

  /** Suma de un grupo de cuentas contables de una unidad (debe − haber). */
  const saldoContable = async (entityId: string, prefijo: string) => {
    const prisma = app.get(PrismaService);
    const filas = await prisma.journalLine.findMany({
      where: {
        entry: { entityId, status: { in: ['POSTED', 'REVERSED'] } },
        ledgerAccount: { code: { startsWith: prefijo } },
      },
      select: { debit: true, credit: true },
    });
    return filas.reduce((total, fila) => total + Number(fila.debit) - Number(fila.credit), 0).toFixed(2);
  };

  const mover = (cuerpo: Record<string, unknown>) =>
    http.post('/api/v1/transfers').set(auth()).send({
      fromAccountId: bancoEmpresa,
      toAccountId: bancoPersonal,
      amount: '5000.00',
      businessDate: today,
      description: 'Dinero para mí',
      ...cuerpo,
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new SerializationInterceptor());
    await app.listen(0);

    const prisma = app.get(PrismaService);
    const email = `dineroparami.${runId}@finanza.test`;
    await prisma.user.create({ data: { email, name: 'Retiro', passwordHash: await hashPassword(password), role: 'OWNER' } });
    http = request(app.getHttpServer());
    const login = await http.post('/api/v1/auth/login').send({ email, password, deviceId: `d-${runId}` }).expect(201);
    token = login.body.accessToken;

    const srl = await http.post('/api/v1/entities/legal-entities').set(auth()).send({ name: `SRL DPM ${runId}`, kind: 'COMPANY' }).expect(201);
    const persona = await http.post('/api/v1/entities/legal-entities').set(auth()).send({ name: `Persona DPM ${runId}`, kind: 'INDIVIDUAL' }).expect(201);

    const empresa = await http.post('/api/v1/entities').set(auth()).send({ name: `Empresa DPM ${runId}`, type: 'BUSINESS' }).expect(201);
    const personal = await http.post('/api/v1/entities').set(auth()).send({ name: `Personal DPM ${runId}`, type: 'PERSONAL' }).expect(201);
    empresaId = empresa.body.id;
    personalId = personal.body.id;
    srlId = srl.body.id;

    await http.patch(`/api/v1/entities/${empresaId}/structure`).set(auth()).send({ legalEntityId: srl.body.id }).expect(200);
    await http.patch(`/api/v1/entities/${personalId}/structure`).set(auth()).send({ legalEntityId: persona.body.id }).expect(200);

    bancoEmpresa = (
      await http
        .post('/api/v1/accounts')
        .set(auth())
        .send({ entityId: empresaId, name: 'Banco empresa', type: 'BANK', openingBalance: '20000.00', openingDate: today })
        .expect(201)
    ).body.id;

    bancoPersonal = (
      await http
        .post('/api/v1/accounts')
        .set(auth())
        .send({ entityId: personalId, name: 'Banco personal', type: 'BANK', openingBalance: '1000.00', openingDate: today })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('sin decir qué es el dinero, sigue bloqueado', async () => {
    const r = await mover({}).expect(400);
    expect(String(r.body.message)).toMatch(/clasificar/i);
    expect(await saldo(bancoPersonal)).toBe('1000.00');
  });

  it('«es mi dinero»: llega a la cuenta personal sin ingreso y sin cambiar el patrimonio', async () => {
    const r = await mover({ nature: 'WITHDRAWAL', clientOperationId: `dpm_${runId}` }).expect(201);
    expect(r.body.isCrossEntity).toBe(true);

    // Los dos bancos, como dice el extracto.
    expect(await saldo(bancoEmpresa)).toBe('15000.00');
    expect(await saldo(bancoPersonal)).toBe('6000.00');

    // Empresa: retiro del propietario (patrimonio), no gasto.
    expect(await saldoContable(empresaId, '3200')).toBe('5000.00');
    expect(await saldoContable(empresaId, '6')).toBe('0.00');

    // Personal: entra el dinero y baja la participación en la empresa.
    expect(await saldoContable(personalId, '1230')).toBe('-5000.00');
    // Y NO hay ningún ingreso ni gasto personal.
    expect(await saldoContable(personalId, '4')).toBe('0.00');
    expect(await saldoContable(personalId, '6')).toBe('0.00');
    // El puente intercompañía no se usa: esto no es un traslado interno.
    expect(await saldoContable(personalId, '1150')).toBe('0.00');
  });

  it('el reintento del mismo movimiento no duplica nada', async () => {
    await mover({ nature: 'WITHDRAWAL', clientOperationId: `dpm_${runId}` }).expect(201);
    expect(await saldo(bancoPersonal)).toBe('6000.00');
    expect(await saldo(bancoEmpresa)).toBe('15000.00');
  });

  it('un préstamo exige documento', async () => {
    const r = await mover({ nature: 'LOAN' }).expect(400);
    expect(String(r.body.message)).toMatch(/documentado|referencia/i);
    expect(await saldo(bancoPersonal)).toBe('6000.00');
  });

  it('un préstamo documentado crea deuda en los dos lados, sin ingreso', async () => {
    await mover({ nature: 'LOAN', documentRef: 'CONTRATO-2026-01' }).expect(201);

    expect(await saldo(bancoPersonal)).toBe('11000.00');
    expect(await saldo(bancoEmpresa)).toBe('10000.00');
    // Empresa: préstamo otorgado (activo), no gasto.
    expect(await saldoContable(empresaId, '1250')).toBe('5000.00');
    expect(await saldoContable(empresaId, '6')).toBe('0.00');
    // Personal: deuda por pagar, no ingreso.
    expect(await saldoContable(personalId, '2202')).toBe('-5000.00');
    expect(await saldoContable(personalId, '4')).toBe('0.00');
  });

  it('no se puede usar «dinero para mí» dentro de la misma persona jurídica', async () => {
    const hermana = await http.post('/api/v1/entities').set(auth()).send({ name: `Hermana DPM ${runId}`, type: 'BUSINESS' }).expect(201);
    // Otra marca de la MISMA sociedad: aquí el dinero no cambia de dueño.
    await http
      .patch(`/api/v1/entities/${hermana.body.id}/structure`)
      .set(auth())
      .send({ legalEntityId: srlId, parentEntityId: empresaId })
      .expect(200);
    const bancoHermana = await http
      .post('/api/v1/accounts')
      .set(auth())
      .send({ entityId: hermana.body.id, name: 'Banco hermana', type: 'BANK', openingBalance: '0.00', openingDate: today })
      .expect(201);

    const r = await http
      .post('/api/v1/transfers')
      .set(auth())
      .send({
        fromAccountId: bancoEmpresa,
        toAccountId: bancoHermana.body.id,
        amount: '100.00',
        businessDate: today,
        description: 'Intento inválido',
        nature: 'WITHDRAWAL',
      })
      .expect(400);
    expect(String(r.body.message)).toMatch(/misma persona jurídica/i);
  });

  it('no se puede sacar «dinero para mí» desde las finanzas personales', async () => {
    const otraPersonal = await http.post('/api/v1/entities').set(auth()).send({ name: `Personal 2 DPM ${runId}`, type: 'PERSONAL' }).expect(201);
    const bancoOtra = await http
      .post('/api/v1/accounts')
      .set(auth())
      .send({ entityId: otraPersonal.body.id, name: 'Banco otra personal', type: 'BANK', openingBalance: '0.00', openingDate: today })
      .expect(201);

    const r = await http
      .post('/api/v1/transfers')
      .set(auth())
      .send({
        fromAccountId: bancoPersonal,
        toAccountId: bancoOtra.body.id,
        amount: '100.00',
        businessDate: today,
        description: 'Intento inválido',
        nature: 'WITHDRAWAL',
      })
      .expect(400);
    expect(String(r.body.message)).toMatch(/no de sus finanzas personales|no está confirmada/i);
  });
});
