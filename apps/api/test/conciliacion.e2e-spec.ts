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
 * FASE 5 — CONCILIACIÓN Y CONTROL DE FONDOS
 * =========================================
 * Lo que se defiende aquí:
 *
 *  1. **Mirar no cambia nada**: `preview` no escribe ni un céntimo.
 *  2. **Corregir es un asiento**, no un saldo escrito a mano, y su sentido lo
 *     decide el SIGNO de la diferencia (faltante 8010 / sobrante 4920).
 *  3. **Se puede no ajustar**: la diferencia se anota sin tocar saldos.
 *  4. **El disponible no es el saldo**: los fondos en custodia no son del
 *     propietario y la conciliación lo dice.
 *  5. **Política de sobregiro por cuenta**: con la política estricta, el servidor
 *     rechaza el gasto que deja la cuenta en negativo; sin ella, avisa pero no
 *     bloquea (el saldo del libro puede no coincidir con el banco).
 */
describe('Conciliación de cuentas y control de fondos', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token = '';
  const runId = Date.now().toString(36);
  const password = 'Concilia2026!segura';
  const today = businessDateToIso(businessToday());

  const auth = () => ({ Authorization: `Bearer ${token}` });

  let entityId = '';
  let cajaId = '';
  let estrictaId = '';

  const saldo = async (accountId: string) => {
    const r = await http.get(`/api/v1/accounts/${accountId}`).set(auth()).expect(200);
    return r.body.balance as string;
  };

  const preview = (accountId: string, informedBalance: string) =>
    http.post(`/api/v1/accounts/${accountId}/reconciliation/preview`).set(auth()).send({ informedBalance });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new SerializationInterceptor());
    await app.listen(0);

    const prisma = app.get(PrismaService);
    const email = `concilia.${runId}@finanza.test`;
    await prisma.user.create({ data: { email, name: 'Concilia', passwordHash: await hashPassword(password), role: 'OWNER' } });
    http = request(app.getHttpServer());
    const login = await http.post('/api/v1/auth/login').send({ email, password, deviceId: `d-${runId}` }).expect(201);
    token = login.body.accessToken;

    const entidad = await http
      .post('/api/v1/entities')
      .set(auth())
      .send({ name: `Concilia ${runId}`, type: 'BUSINESS' })
      .expect(201);
    entityId = entidad.body.id;

    const caja = await http
      .post('/api/v1/accounts')
      .set(auth())
      .send({ entityId, name: 'Caja conciliable', type: 'CASH', openingBalance: '1000.00', openingDate: today })
      .expect(201);
    cajaId = caja.body.id;

    const estricta = await http
      .post('/api/v1/accounts')
      .set(auth())
      .send({ entityId, name: 'Banco estricto', type: 'BANK', openingBalance: '100.00', openingDate: today })
      .expect(201);
    estrictaId = estricta.body.id;
    await http.patch(`/api/v1/accounts/${estrictaId}`).set(auth()).send({ allowOverdraft: false }).expect(200);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('mirar NO cambia el saldo ni crea movimientos', async () => {
    const r = await preview(cajaId, '900.00').expect(201);

    expect(r.body.ledgerBalance).toBe('1000.00');
    expect(r.body.informedBalance).toBe('900.00');
    expect(r.body.difference).toBe('-100.00');
    expect(r.body.direction).toBe('SHORTAGE');
    expect(r.body.proposal.debitCode).toBe('8010');
    expect(r.body.proposal.creditCode).toBe('1010');
    expect(r.body.explanations.length).toBeGreaterThan(1);

    // Nada se ha movido.
    expect(await saldo(cajaId)).toBe('1000.00');
  });

  it('confirmar un faltante crea un asiento y deja la cuenta igual que el banco', async () => {
    const prisma = app.get(PrismaService);
    const antes = await prisma.financialTransaction.count({ where: { accountId: cajaId } });

    const r = await http
      .post(`/api/v1/accounts/${cajaId}/reconciliation/confirm`)
      .set(auth())
      .send({
        informedBalance: '900.00',
        cause: 'AUTHORIZED_CASH_DIFFERENCE',
        authorized: true,
        reason: 'Comisión del banco no registrada',
      })
      .expect(201);

    expect(r.body.adjusted).toBe(true);
    expect(r.body.reconciliation.changedBalances).toBe(true);
    expect(r.body.reconciliation.journalEntryId).toBeTruthy();
    expect(await saldo(cajaId)).toBe('900.00');

    // Se creó UN movimiento de ajuste (no se editó nada existente).
    const despues = await prisma.financialTransaction.count({ where: { accountId: cajaId } });
    expect(despues).toBe(antes + 1);

    const ajuste = await prisma.financialTransaction.findFirst({
      where: { accountId: cajaId, kind: 'ADJUSTMENT' },
      include: { journalEntry: { include: { lines: { include: { ledgerAccount: { select: { code: true } } } } } } },
    });
    expect(ajuste).toBeTruthy();
    // El asiento está cuadrado y va a la cuenta de faltantes.
    const lineas = ajuste!.journalEntry!.lines;
    const debe = lineas.reduce((total, linea) => total + Number(linea.debit), 0);
    const haber = lineas.reduce((total, linea) => total + Number(linea.credit), 0);
    expect(debe).toBe(haber);
    expect(lineas.some((linea) => linea.ledgerAccount.code === '8010' && Number(linea.debit) === 100)).toBe(true);
  });

  it('confirmar un sobrante sube el saldo y usa la cuenta de sobrantes', async () => {
    const vista = await preview(cajaId, '950.00').expect(201);
    expect(vista.body.direction).toBe('OVERAGE');
    expect(vista.body.proposal.creditCode).toBe('4920');

    await http
      .post(`/api/v1/accounts/${cajaId}/reconciliation/confirm`)
      .set(auth())
      .send({
        informedBalance: '950.00',
        cause: 'AUTHORIZED_CASH_DIFFERENCE',
        authorized: true,
        reason: 'Cobro pequeño que no se apuntó',
      })
      .expect(201);

    expect(await saldo(cajaId)).toBe('950.00');
  });

  it('cuando cuadra, confirmar no genera ningún ajuste', async () => {
    const prisma = app.get(PrismaService);
    const antes = await prisma.financialTransaction.count({ where: { accountId: cajaId } });

    const r = await http
      .post(`/api/v1/accounts/${cajaId}/reconciliation/confirm`)
      .set(auth())
      .send({ informedBalance: '950.00' })
      .expect(201);

    expect(r.body.adjusted).toBe(false);
    expect(await saldo(cajaId)).toBe('950.00');
    const despues = await prisma.financialTransaction.count({ where: { accountId: cajaId } });
    expect(despues).toBe(antes);
  });

  it('se puede revisar una diferencia SIN ajustarla', async () => {
    await http
      .post(`/api/v1/accounts/${cajaId}/reconciliation/dismiss`)
      .set(auth())
      .send({
        informedBalance: '800.00',
        cause: 'UNIDENTIFIED',
        notes: 'Falta un movimiento del banco que aún no aparece',
      })
      .expect(201);

    expect(await saldo(cajaId)).toBe('950.00');

    const historial = await http.get(`/api/v1/accounts/${cajaId}/reconciliation`).set(auth()).expect(200);
    const descartada = historial.body.data.find((fila: { status: string }) => fila.status === 'DISMISSED');
    expect(descartada).toBeTruthy();
    expect(descartada.difference).toBe('-150.00');
    expect(descartada.changedBalances).toBe(false);
    expect(descartada.cause).toBe('UNIDENTIFIED');
  });

  // -------------------------------------------------------------------------
  // Blindaje: una diferencia NO se convierte en gasto o ingreso por existir
  // -------------------------------------------------------------------------
  describe('prevención del ajuste injustificado', () => {
    const confirmar = (cause: string, authorized: boolean) =>
      http
        .post(`/api/v1/accounts/${cajaId}/reconciliation/confirm`)
        .set(auth())
        .send({ informedBalance: '900.00', cause, authorized, reason: 'Intento de ajuste sin causa válida' });

    it('sin causa, rechaza el ajuste', async () => {
      const r = await http
        .post(`/api/v1/accounts/${cajaId}/reconciliation/confirm`)
        .set(auth())
        .send({ informedBalance: '900.00', reason: 'Sin causa declarada' })
        .expect(400);
      expect(String(r.body.message)).toMatch(/por qué existe la diferencia/i);
    });

    it('«falta apuntar un movimiento» NO genera asiento: hay que apuntarlo', async () => {
      const r = await confirmar('UNRECORDED_MOVEMENT', true).expect(400);
      expect(String(r.body.message)).toMatch(/apúntelo en Movimientos/i);
      expect(await saldo(cajaId)).toBe('950.00');
    });

    it('«movimiento duplicado» NO genera asiento: hay que anular el duplicado', async () => {
      const r = await confirmar('DUPLICATE_MOVEMENT', true).expect(400);
      expect(String(r.body.message)).toMatch(/anule el duplicado/i);
      expect(await saldo(cajaId)).toBe('950.00');
    });

    it('«no lo sé» NO genera asiento', async () => {
      const r = await confirmar('UNIDENTIFIED', true).expect(400);
      expect(String(r.body.message)).toMatch(/no se toca ningún saldo/i);
      expect(await saldo(cajaId)).toBe('950.00');
    });

    it('con causa «diferencia autorizada» pero SIN la autorización explícita, tampoco', async () => {
      await confirmar('AUTHORIZED_CASH_DIFFERENCE', false).expect(400);
      expect(await saldo(cajaId)).toBe('950.00');
    });
  });

  it('en una tarjeta el saldo es deuda: el sentido del aviso y del asiento se invierte', async () => {
    const tarjeta = await http
      .post('/api/v1/accounts')
      .set(auth())
      .send({ entityId, name: 'Tarjeta de prueba', type: 'CREDIT_CARD', openingBalance: '500.00', openingDate: today })
      .expect(201);

    // El banco dice que se debe 100 más de lo registrado.
    const vista = await http
      .post(`/api/v1/accounts/${tarjeta.body.id}/reconciliation/preview`)
      .set(auth())
      .send({ informedBalance: '600.00' })
      .expect(201);

    expect(vista.body.account.isLiability).toBe(true);
    expect(vista.body.direction).toBe('MORE_DEBT');
    // No puede usar la cuenta de «sobrantes» (eso sería tratar deuda como ingreso).
    expect(vista.body.proposal.creditCode).toBe('2210');
    expect(vista.body.proposal.debitCode).toBe('8020');
    expect(vista.body.explanations.join(' ')).toMatch(/deuda/i);

    // Al informar correctamente, cuadra.
    const cuadra = await http
      .post(`/api/v1/accounts/${tarjeta.body.id}/reconciliation/preview`)
      .set(auth())
      .send({ informedBalance: '500.00' })
      .expect(201);
    expect(cuadra.body.matches).toBe(true);
  });

  it('el disponible descuenta el dinero de empresas (custodia)', async () => {
    // Se declara dinero de una empresa que ya estaba en la caja.
    const empresa = await http
      .post('/api/v1/entities')
      .set(auth())
      .send({ name: `Empresa custodia ${runId}`, type: 'BUSINESS' })
      .expect(201);
    const personal = await http
      .post('/api/v1/entities')
      .set(auth())
      .send({ name: `Personal custodia ${runId}`, type: 'PERSONAL' })
      .expect(201);
    const cuentaPersonal = await http
      .post('/api/v1/accounts')
      .set(auth())
      .send({ entityId: personal.body.id, name: 'Banco personal', type: 'BANK', openingBalance: '5000.00', openingDate: today })
      .expect(201);

    await http
      .post('/api/v1/custody/opening')
      .set(auth())
      .send({
        beneficiaryEntityId: empresa.body.id,
        holdingAccountId: cuentaPersonal.body.id,
        amount: '2000.00',
        businessDate: today,
        description: 'Cobros ya depositados',
      })
      .expect(201);

    const vista = await http
      .post(`/api/v1/accounts/${cuentaPersonal.body.id}/reconciliation/preview`)
      .set(auth())
      .send({ informedBalance: '5000.00' })
      .expect(201);

    expect(vista.body.ledgerBalance).toBe('5000.00');
    expect(vista.body.custody).toBe('2000.00');
    expect(vista.body.available).toBe('3000.00');
    expect(vista.body.matches).toBe(true);
    expect(vista.body.explanations.join(' ')).toMatch(/no es suyo/i);

    // Y la lista de cuentas devuelve los tres números distintos.
    const lista = await http.get(`/api/v1/accounts?entityId=${personal.body.id}`).set(auth()).expect(200);
    const fila = (lista.body as Array<{ id: string; balance: string; custody: string; available: string }>).find(
      (cuenta) => cuenta.id === cuentaPersonal.body.id,
    );
    expect(fila).toEqual(
      expect.objectContaining({ balance: '5000.00', custody: '2000.00', available: '3000.00' }),
    );
  });

  describe('política de sobregiro', () => {
    const gastar = (accountId: string, amount: string) =>
      http
        .post('/api/v1/transactions')
        .set(auth())
        .send({ entityId, kind: 'EXPENSE', accountId, amount, description: 'Gasto de prueba' });

    it('con la política estricta, rechaza el gasto que deja la cuenta en negativo', async () => {
      const r = await gastar(estrictaId, '150.00').expect(400);
      expect(String(r.body.message)).toMatch(/no permite saldo negativo/i);
      expect(await saldo(estrictaId)).toBe('100.00');
    });

    it('con la política estricta, deja gastar hasta el saldo disponible', async () => {
      await gastar(estrictaId, '100.00').expect(201);
      expect(await saldo(estrictaId)).toBe('0.00');
    });

    it('sin política estricta avisa pero no bloquea (el saldo del libro puede no coincidir con el banco)', async () => {
      // La caja tiene 950 y se permite descubierto: se puede dejar en negativo.
      await gastar(cajaId, '1000.00').expect(201);
      expect(await saldo(cajaId)).toBe('-50.00');
    });

    it('el ingreso siempre se puede registrar', async () => {
      await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({ entityId, kind: 'INCOME', accountId: estrictaId, amount: '40.00', description: 'Cobro' })
        .expect(201);
      expect(await saldo(estrictaId)).toBe('40.00');
    });
  });
});
