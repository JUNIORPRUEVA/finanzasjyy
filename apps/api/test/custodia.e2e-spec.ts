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
 * FONDOS EN CUSTODIA — PRUEBA DE PUNTA A PUNTA (API + PostgreSQL real)
 * ===================================================================
 * Reproduce EXACTAMENTE el caso del propietario:
 *
 *   · FULLTECH y APPYRA son empresas; PERSONAL es su unidad personal.
 *   · En el BHD personal hay 50.000 reales, de los cuales 20.000 son de FULLTECH
 *     y 5.000 de APPYRA desde ANTES de usar FINANZA (apertura, no ventas).
 *   · Un cliente de FULLTECH paga 5.000 que caen en el Banreservas personal.
 *   · Después se liquida: parcial, completa y agrupada.
 *
 * Lo que se exige en cada paso:
 *   1. El saldo del banco coincide SIEMPRE con el dinero que hay de verdad.
 *   2. El ingreso de la empresa se reconoce UNA sola vez (nunca dos).
 *   3. La apertura NO crea ingresos ni vuelve a cobrar facturas.
 *   4. El propietario no aparece ganando el dinero de las empresas.
 *   5. Todo cuadra en partida doble y el informe de integridad sale limpio.
 */

describe('FINANZA — fondos de empresas en cuentas personales (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  const runId = Date.now().toString(36);
  const password = 'PruebaCustodia-2026!';
  const email = `e2e.custodia.${runId}@finanza.test`;

  let token = '';
  let fulltechId = '';
  let appyraId = '';
  let personalId = '';
  let bhdId = '';
  let banreservasId = '';
  let fulltechBankId = '';
  let appyraBankId = '';
  let incomeCategoryId = '';
  let expenseCategoryId = '';

  const today = businessDateToIso(businessToday());
  const auth = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });

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
      data: { email, name: 'E2E Custodia', passwordHash: await hashPassword(password), role: 'OWNER' },
    });

    const login = await http
      .post('/api/v1/auth/login')
      .send({ email, password, deviceId: `e2e-custodia-${runId}`, platform: 'jest' })
      .expect(201);
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  // -------------------------------------------------------------------------
  // Preparación: tres unidades y sus cuentas reales
  // -------------------------------------------------------------------------
  describe('1. Preparación (dos empresas y la unidad personal)', () => {
    it('crea las unidades FULLTECH, APPYRA y PERSONAL', async () => {
      const fulltech = await http
        .post('/api/v1/entities')
        .set(auth())
        .send({ name: `FULLTECH ${runId}`, type: 'BUSINESS' })
        .expect(201);
      fulltechId = fulltech.body.id;

      const appyra = await http
        .post('/api/v1/entities')
        .set(auth())
        .send({ name: `APPYRA ${runId}`, type: 'BUSINESS' })
        .expect(201);
      appyraId = appyra.body.id;

      const personal = await http
        .post('/api/v1/entities')
        .set(auth())
        .send({ name: `PERSONAL ${runId}`, type: 'PERSONAL' })
        .expect(201);
      personalId = personal.body.id;

      expect(new Set([fulltechId, appyraId, personalId]).size).toBe(3);
    });

    it('crea BHD y Banreservas personales con el saldo REAL del extracto, y un banco por empresa', async () => {
      const bhd = await http
        .post('/api/v1/accounts')
        .set(auth())
        .send({ entityId: personalId, name: 'BHD personal', type: 'BANK', openingBalance: '50000.00', openingDate: today })
        .expect(201);
      bhdId = bhd.body.id;
      expect(bhd.body.balance).toBe('50000.00');

      const banreservas = await http
        .post('/api/v1/accounts')
        .set(auth())
        .send({ entityId: personalId, name: 'Banreservas personal', type: 'BANK', openingBalance: '20000.00', openingDate: today })
        .expect(201);
      banreservasId = banreservas.body.id;

      const fulltechBank = await http
        .post('/api/v1/accounts')
        .set(auth())
        .send({ entityId: fulltechId, name: 'Banco FULLTECH', type: 'BANK', openingBalance: '0.00', openingDate: today })
        .expect(201);
      fulltechBankId = fulltechBank.body.id;

      const appyraBank = await http
        .post('/api/v1/accounts')
        .set(auth())
        .send({ entityId: appyraId, name: 'Banco APPYRA', type: 'BANK', openingBalance: '0.00', openingDate: today })
        .expect(201);
      appyraBankId = appyraBank.body.id;

      // Categorías del catálogo por defecto (una de ingreso y una de gasto).
      incomeCategoryId = await categoryByName('Servicios prestados');
      expenseCategoryId = await categoryByName('Suministros de oficina');
    });

    it('el panel arranca sin custodia: todo el dinero es personal', async () => {
      const response = await http.get('/api/v1/custody/summary').set(auth()).expect(200);
      const bhd = accountRow(response.body.accounts, bhdId);
      expect(bhd.realBalance).toBe('50000.00');
      expect(bhd.custody).toBe('0.00');
      expect(bhd.personalNet).toBe('50000.00');
    });
  });

  // -------------------------------------------------------------------------
  // Apertura: dinero que YA estaba depositado antes de FINANZA
  // -------------------------------------------------------------------------
  describe('2. Apertura de fondos que ya estaban en el banco', () => {
    it('declara 20.000 de FULLTECH en el BHD sin crear ningún ingreso ni tocar el saldo del banco', async () => {
      const response = await http
        .post('/api/v1/custody/opening')
        .set(auth())
        .send({
          beneficiaryEntityId: fulltechId,
          holdingAccountId: bhdId,
          amount: '20000.00',
          businessDate: today,
          description: 'Cobros de FULLTECH ya depositados antes de FINANZA',
          clientOperationId: `e2e-open-fulltech-${runId}`,
        })
        .expect(201);

      expect(response.body.custodyFundId).toBeTruthy();
      expect(response.body.pending).toBe('20000.00');

      // El banco NO se mueve: sigue con los 50.000 del extracto.
      const bhd = await http.get(`/api/v1/accounts/${bhdId}`).set(auth()).expect(200);
      expect(bhd.body.balance).toBe('50000.00');

      // Y NO hay ingreso reconocido en FULLTECH por la apertura.
      expect(await incomeLinesOf(fulltechId)).toBe(0);
    });

    it('declara 5.000 de APPYRA en el MISMO BHD: conviven dos empresas en una cuenta', async () => {
      await http
        .post('/api/v1/custody/opening')
        .set(auth())
        .send({
          beneficiaryEntityId: appyraId,
          holdingAccountId: bhdId,
          amount: '5000.00',
          businessDate: today,
          description: 'Fondos de APPYRA ya depositados',
          clientOperationId: `e2e-open-appyra-${runId}`,
        })
        .expect(201);

      const response = await http.get(`/api/v1/custody/summary?holdingAccountId=${bhdId}`).set(auth()).expect(200);
      const bhd = accountRow(response.body.accounts, bhdId);
      expect(bhd.realBalance).toBe('50000.00');
      expect(bhd.custody).toBe('25000.00');
      expect(bhd.personalNet).toBe('25000.00');
      expect(byBeneficiary(bhd.custodyByBeneficiary, fulltechId)).toBe('20000.00');
      expect(byBeneficiary(bhd.custodyByBeneficiary, appyraId)).toBe('5000.00');
    });

    it('rechaza declarar más custodia que dinero libre hay en la cuenta (no se inventa saldo)', async () => {
      const response = await http
        .post('/api/v1/custody/opening')
        .set(auth())
        .send({
          beneficiaryEntityId: fulltechId,
          holdingAccountId: bhdId,
          amount: '30000.00',
          description: 'Intento de declarar más de lo que hay',
          clientOperationId: `e2e-open-excess-${runId}`,
        })
        .expect(400);

      expect(response.body.message).toMatch(/sólo quedan 25000\.00/i);
    });

    it('es idempotente: reintentar la misma apertura no duplica el pendiente', async () => {
      const payload = {
        beneficiaryEntityId: appyraId,
        holdingAccountId: bhdId,
        amount: '5000.00',
        businessDate: today,
        description: 'Fondos de APPYRA ya depositados',
        clientOperationId: `e2e-open-appyra-${runId}`,
      };
      const response = await http.post('/api/v1/custody/opening').set(auth()).send(payload).expect(201);
      expect(response.body.duplicate).toBe(true);
      expect(response.body.pending).toBe('5000.00');
    });

    it('no permite usar la cuenta de la propia empresa como cuenta que custodia', async () => {
      const response = await http
        .post('/api/v1/custody/opening')
        .set(auth())
        .send({
          beneficiaryEntityId: fulltechId,
          holdingAccountId: fulltechBankId,
          amount: '100.00',
          description: 'Cuenta de la misma unidad',
          clientOperationId: `e2e-open-same-${runId}`,
        })
        .expect(400);
      expect(response.body.message).toMatch(/de la propia unidad/i);
    });
  });

  // -------------------------------------------------------------------------
  // Cobro nuevo: un cliente de FULLTECH paga en el Banreservas personal
  // -------------------------------------------------------------------------
  describe('3. Cobro nuevo de FULLTECH que entra en el Banreservas personal', () => {
    let collectTransactionId = '';

    it('registra el cobro: sube el banco personal y el ingreso de FULLTECH, una sola vez', async () => {
      const response = await http
        .post('/api/v1/custody/collect')
        .set(auth())
        .send({
          beneficiaryEntityId: fulltechId,
          holdingAccountId: banreservasId,
          kind: 'INCOME',
          categoryId: incomeCategoryId,
          amount: '5000.00',
          businessDate: today,
          description: 'Venta de equipos cobrada en Banreservas personal',
          method: 'TRANSFERENCIA',
          clientOperationId: `e2e-collect-${runId}`,
        })
        .expect(201);

      collectTransactionId = response.body.transactionId;
      expect(collectTransactionId).toBeTruthy();
      expect(response.body.pending).toBe('5000.00');

      const banreservas = await http.get(`/api/v1/accounts/${banreservasId}`).set(auth()).expect(200);
      expect(banreservas.body.balance).toBe('25000.00');

      // El ingreso existe UNA vez.
      expect(await incomeLinesOf(fulltechId)).toBe(1);
    });

    it('el propietario NO aparece con ingresos: su dinero ajeno es una deuda, no un beneficio', async () => {
      expect(await incomeLinesOf(personalId)).toBe(0);

      const summary = await http.get(`/api/v1/custody/summary?holdingAccountId=${banreservasId}`).set(auth()).expect(200);
      const banreservas = accountRow(summary.body.accounts, banreservasId);
      expect(banreservas.realBalance).toBe('25000.00');
      expect(banreservas.custody).toBe('5000.00');
      expect(banreservas.personalNet).toBe('20000.00');
    });

    it('reintentar el mismo cobro devuelve el mismo movimiento y no duplica nada', async () => {
      const payload = {
        beneficiaryEntityId: fulltechId,
        holdingAccountId: banreservasId,
        kind: 'INCOME',
        categoryId: incomeCategoryId,
        amount: '5000.00',
        businessDate: today,
        description: 'Venta de equipos cobrada en Banreservas personal',
        clientOperationId: `e2e-collect-${runId}`,
      };
      const response = await http.post('/api/v1/custody/collect').set(auth()).send(payload).expect(201);
      expect(response.body.duplicate).toBe(true);
      expect(response.body.transactionId).toBe(collectTransactionId);

      expect(await incomeLinesOf(fulltechId)).toBe(1);
      const banreservas = await http.get(`/api/v1/accounts/${banreservasId}`).set(auth()).expect(200);
      expect(banreservas.body.balance).toBe('25000.00');
    });

    it('FULLTECH acumula 25.000 pendientes (20.000 de apertura + 5.000 del cobro)', async () => {
      const response = await http.get('/api/v1/custody/pending').set(auth()).expect(200);
      const fulltechTotal = (response.body.rows as Array<{ beneficiaryEntityId: string; pending: string }>)
        .filter((row) => row.beneficiaryEntityId === fulltechId)
        .reduce((acc, row) => acc + Number(row.pending), 0);
      expect(fulltechTotal).toBe(25000);
    });
  });

  // -------------------------------------------------------------------------
  // Liquidaciones: parcial, completa y agrupada
  // -------------------------------------------------------------------------
  describe('4. Liquidaciones (parcial, completa y agrupada)', () => {
    it('liquidación PARCIAL de 12.000 desde el BHD: sale del banco personal y entra en el de FULLTECH', async () => {
      const response = await http
        .post('/api/v1/custody/settle')
        .set(auth())
        .send({
          beneficiaryEntityId: fulltechId,
          holdingAccountId: bhdId,
          targetAccountId: fulltechBankId,
          amount: '12000.00',
          businessDate: today,
          description: 'Liquidación parcial',
          clientOperationId: `e2e-settle-partial-${runId}`,
        })
        .expect(201);
      expect(response.body.pendingAfter).toBe('8000.00');

      const bhd = await http.get(`/api/v1/accounts/${bhdId}`).set(auth()).expect(200);
      expect(bhd.body.balance).toBe('38000.00');

      const fulltechBank = await http.get(`/api/v1/accounts/${fulltechBankId}`).set(auth()).expect(200);
      expect(fulltechBank.body.balance).toBe('12000.00');

      // Liquidar no es vender: el ingreso de FULLTECH sigue siendo 1.
      expect(await incomeLinesOf(fulltechId)).toBe(1);
      expect(await expenseLinesOf(fulltechId)).toBe(0);
      expect(await incomeLinesOf(personalId)).toBe(0);
    });

    it('liquidación COMPLETA de los 8.000 restantes del BHD deja FULLTECH en cero ahí', async () => {
      const response = await http
        .post('/api/v1/custody/settle')
        .set(auth())
        .send({
          beneficiaryEntityId: fulltechId,
          holdingAccountId: bhdId,
          targetAccountId: fulltechBankId,
          amount: '8000.00',
          businessDate: today,
          description: 'Liquidación completa del resto',
          clientOperationId: `e2e-settle-full-${runId}`,
        })
        .expect(201);
      expect(response.body.pendingAfter).toBe('0.00');

      const summary = await http.get(`/api/v1/custody/summary?holdingAccountId=${bhdId}`).set(auth()).expect(200);
      const bhd = accountRow(summary.body.accounts, bhdId);
      expect(bhd.realBalance).toBe('30000.00');
      // En el BHD sólo queda lo de APPYRA: FULLTECH ya no tiene nada ahí.
      expect(bhd.custody).toBe('5000.00');
      expect(bhd.personalNet).toBe('25000.00');
      expect(byBeneficiary(bhd.custodyByBeneficiary, fulltechId)).toBe('0.00');
      expect(byBeneficiary(bhd.custodyByBeneficiary, appyraId)).toBe('5000.00');
    });

    it('liquidación AGRUPADA: 15.000 cubren los 5.000 de Banreservas y los 5.000 de APPYRA… y sobran 5.000 imposibles', async () => {
      // Primero: agrupar el cobro de Banreservas (5.000) con el resto de APPYRA en
      // el BHD no se puede hacer en UNA operación porque son cuentas distintas y la
      // API liquida por cuenta. Se comprueba que el sistema lo dice con claridad.
      const imposible = await http
        .post('/api/v1/custody/settle')
        .set(auth())
        .send({
          beneficiaryEntityId: appyraId,
          holdingAccountId: bhdId,
          targetAccountId: appyraBankId,
          amount: '15000.00',
          businessDate: today,
          description: 'Se intenta liquidar más de lo que hay en esa cuenta',
          clientOperationId: `e2e-settle-excess-${runId}`,
        })
        .expect(400);
      expect(imposible.body.message).toMatch(/sólo hay 5000\.00 pendiente/i);

      // Agrupada de verdad: una sola liquidación que cubre varios cobros abiertos.
      const abrir1 = await http
        .post('/api/v1/custody/opening')
        .set(auth())
        .send({
          beneficiaryEntityId: appyraId,
          holdingAccountId: bhdId,
          amount: '1000.00',
          businessDate: today,
          description: 'Segundo fondo de APPYRA',
          clientOperationId: `e2e-appyra-2-${runId}`,
        })
        .expect(201);
      expect(abrir1.body.pending).toBe('6000.00');

      const agrupada = await http
        .post('/api/v1/custody/settle')
        .set(auth())
        .send({
          beneficiaryEntityId: appyraId,
          holdingAccountId: bhdId,
          targetAccountId: appyraBankId,
          amount: '6000.00',
          businessDate: today,
          description: 'Liquidación agrupada de dos fondos',
          clientOperationId: `e2e-settle-grouped-${runId}`,
        })
        .expect(201);
      expect(agrupada.body.pendingAfter).toBe('0.00');

      const appyraBank = await http.get(`/api/v1/accounts/${appyraBankId}`).set(auth()).expect(200);
      expect(appyraBank.body.balance).toBe('6000.00');

      // La liquidación agrupada cubrió los DOS cobros.
      const historial = await http.get(`/api/v1/custody/movements?beneficiaryEntityId=${appyraId}`).set(auth()).expect(200);
      const movimiento = (historial.body.movements as Array<{ id: string; fundsCovered: number; type: string }>).find(
        (row) => row.id === agrupada.body.settlementId,
      );
      expect(movimiento?.fundsCovered).toBe(2);
      expect(movimiento?.type).toBe('SETTLEMENT');
    });

    it('liquida el cobro de Banreservas y el banco personal queda con lo que dice el extracto', async () => {
      const response = await http
        .post('/api/v1/custody/settle')
        .set(auth())
        .send({
          beneficiaryEntityId: fulltechId,
          holdingAccountId: banreservasId,
          targetAccountId: fulltechBankId,
          amount: '5000.00',
          businessDate: today,
          description: 'Liquidación del cobro cobrado en Banreservas',
          clientOperationId: `e2e-settle-banreservas-${runId}`,
        })
        .expect(201);
      expect(response.body.pendingAfter).toBe('0.00');

      const banreservas = await http.get(`/api/v1/accounts/${banreservasId}`).set(auth()).expect(200);
      expect(banreservas.body.balance).toBe('20000.00'); // exactamente el saldo inicial real

      const fulltechBank = await http.get(`/api/v1/accounts/${fulltechBankId}`).set(auth()).expect(200);
      expect(fulltechBank.body.balance).toBe('25000.00');
    });

    it('no permite liquidar más de lo pendiente (nunca deja un pendiente negativo)', async () => {
      const response = await http
        .post('/api/v1/custody/settle')
        .set(auth())
        .send({
          beneficiaryEntityId: fulltechId,
          holdingAccountId: bhdId,
          targetAccountId: fulltechBankId,
          amount: '1.00',
          businessDate: today,
          description: 'No queda nada pendiente',
          clientOperationId: `e2e-settle-empty-${runId}`,
        })
        .expect(400);
      expect(response.body.message).toMatch(/pendiente de liquidar/i);
    });

    it('sólo deja liquidar en una cuenta de la MISMA empresa dueña del dinero', async () => {
      const response = await http
        .post('/api/v1/custody/settle')
        .set(auth())
        .send({
          beneficiaryEntityId: appyraId,
          holdingAccountId: bhdId,
          targetAccountId: fulltechBankId,
          amount: '1.00',
          businessDate: today,
          description: 'Cuenta de otra empresa',
          clientOperationId: `e2e-settle-wrong-${runId}`,
        })
        .expect(400);
      expect(response.body.message).toMatch(/sólo puede liquidarse en una cuenta de/i);
    });
  });

  // -------------------------------------------------------------------------
  // Anulación y trazabilidad
  // -------------------------------------------------------------------------
  describe('5. Anulación (reversa, nunca borrado)', () => {
    it('anular una liquidación devuelve el pendiente y el dinero al banco personal, sin borrar el histórico', async () => {
      const bhdAntes = await http.get(`/api/v1/accounts/${bhdId}`).set(auth()).expect(200);
      const bancoFulltechAntes = await http.get(`/api/v1/accounts/${fulltechBankId}`).set(auth()).expect(200);

      // Se abre un fondo nuevo y se liquida, para anular esa liquidación concreta.
      const apertura = await http
        .post('/api/v1/custody/opening')
        .set(auth())
        .send({
          beneficiaryEntityId: fulltechId,
          holdingAccountId: bhdId,
          amount: '2000.00',
          businessDate: today,
          description: 'Fondo para probar la anulación',
          clientOperationId: `e2e-void-open-${runId}`,
        })
        .expect(201);
      expect(apertura.body.pending).toBe('2000.00');

      const liquidacion = await http
        .post('/api/v1/custody/settle')
        .set(auth())
        .send({
          beneficiaryEntityId: fulltechId,
          holdingAccountId: bhdId,
          targetAccountId: fulltechBankId,
          amount: '2000.00',
          businessDate: today,
          description: 'Liquidación que se anulará',
          clientOperationId: `e2e-void-settle-${runId}`,
        })
        .expect(201);

      await http
        .post(`/api/v1/custody/movements/${liquidacion.body.settlementId}/void`)
        .set(auth())
        .send({ reason: 'Se transfirió dos veces por error' })
        .expect(201);

      const bhdDespues = await http.get(`/api/v1/accounts/${bhdId}`).set(auth()).expect(200);
      expect(bhdDespues.body.balance).toBe(bhdAntes.body.balance);

      const bancoFulltechDespues = await http.get(`/api/v1/accounts/${fulltechBankId}`).set(auth()).expect(200);
      expect(bancoFulltechDespues.body.balance).toBe(bancoFulltechAntes.body.balance);

      const pendiente = await http.get('/api/v1/custody/pending').set(auth()).expect(200);
      const fila = (pendiente.body.rows as Array<{ beneficiaryEntityId: string; holdingAccountId: string; pending: string }>).find(
        (row) => row.beneficiaryEntityId === fulltechId && row.holdingAccountId === bhdId,
      );
      expect(fila?.pending).toBe('2000.00');

      // El movimiento sigue en el historial, marcado como anulado.
      const historial = await http.get(`/api/v1/custody/movements?beneficiaryEntityId=${fulltechId}`).set(auth()).expect(200);
      const anulado = (historial.body.movements as Array<{ id: string; status: string; voidReason: string | null }>).find(
        (row) => row.id === liquidacion.body.settlementId,
      );
      expect(anulado?.status).toBe('VOIDED');
      expect(anulado?.voidReason).toMatch(/dos veces/);
    });

    it('no permite anular dos veces la misma operación', async () => {
      const pending = await http.get('/api/v1/custody/movements').set(auth()).expect(200);
      const anulado = (pending.body.movements as Array<{ id: string; status: string }>).find((row) => row.status === 'VOIDED');
      expect(anulado).toBeTruthy();
      await http
        .post(`/api/v1/custody/movements/${anulado!.id}/void`)
        .set(auth())
        .send({ reason: 'Intento repetido de anulación' })
        .expect(409);
    });

    it('exige un motivo para anular', async () => {
      const historial = await http.get('/api/v1/custody/movements').set(auth()).expect(200);
      const vigente = (historial.body.movements as Array<{ id: string; status: string }>).find((row) => row.status === 'POSTED');
      expect(vigente).toBeTruthy();
      await http.post(`/api/v1/custody/movements/${vigente!.id}/void`).set(auth()).send({ reason: 'no' }).expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // Gastos de la empresa pagados con el dinero en custodia
  // -------------------------------------------------------------------------
  describe('6. Gasto de la empresa pagado con dinero en custodia', () => {
    it('paga un gasto de FULLTECH con el dinero que estaba en el BHD, bajando la custodia', async () => {
      const bhdAntes = await http.get(`/api/v1/accounts/${bhdId}`).set(auth()).expect(200);

      await http
        .post('/api/v1/custody/expense')
        .set(auth())
        .send({
          beneficiaryEntityId: fulltechId,
          holdingAccountId: bhdId,
          categoryId: expenseCategoryId,
          amount: '500.00',
          businessDate: today,
          description: 'Suministros de FULLTECH pagados con el dinero en custodia',
          clientOperationId: `e2e-custody-expense-${runId}`,
        })
        .expect(201);

      const bhdDespues = await http.get(`/api/v1/accounts/${bhdId}`).set(auth()).expect(200);
      expect(Number(bhdDespues.body.balance)).toBe(Number(bhdAntes.body.balance) - 500);

      // El gasto es de la EMPRESA, no del propietario.
      expect(await expenseLinesOf(fulltechId)).toBe(1);
      expect(await expenseLinesOf(personalId)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Integridad contable y coherencia final
  // -------------------------------------------------------------------------
  describe('7. Integridad contable y coherencia final', () => {
    it('el informe de integridad sale limpio en las tres unidades', async () => {
      for (const entityId of [fulltechId, appyraId, personalId]) {
        const response = await http.get(`/api/v1/ledger/integrity?entityId=${entityId}`).set(auth()).expect(200);
        expect(response.body.ok).toBe(true);
      }
    });

    it('cada cuenta sigue coincidiendo con su extracto real y el panel explica de quién es el dinero', async () => {
      const summary = await http.get('/api/v1/custody/summary').set(auth()).expect(200);

      const bhd = accountRow(summary.body.accounts, bhdId);
      const banreservas = accountRow(summary.body.accounts, banreservasId);

      // BHD: 50.000 − 12.000 − 8.000 (FULLTECH) − 6.000 (APPYRA) − 2.000 + 2.000 (anulación) − 500 (gasto) = 23.500
      expect(bhd.realBalance).toBe('23500.00');
      // Lo único que sigue en custodia en el BHD son los 2.000 de FULLTECH menos 500 ya gastados.
      expect(bhd.custody).toBe('1500.00');
      expect(bhd.personalNet).toBe('22000.00');
      expect(Number(bhd.personalNet)).toBe(Number(bhd.realBalance) - Number(bhd.custody));
      expect(banreservas.realBalance).toBe('20000.00');
      expect(banreservas.custody).toBe('0.00');
      expect(banreservas.personalNet).toBe('20000.00');

      // El total del panel cuadra con la suma de las cuentas.
      const sumaReal = (summary.body.accounts as Array<{ realBalance: string }>).reduce(
        (acc, row) => acc + Number(row.realBalance),
        0,
      );
      expect(Number(summary.body.totals.realBalance)).toBeCloseTo(sumaReal, 2);
    });

    it('ningún asiento de custodia toca ingresos o gastos del propietario', async () => {
      expect(await incomeLinesOf(personalId)).toBe(0);
      expect(await expenseLinesOf(personalId)).toBe(0);

      // Y el único ingreso de FULLTECH es el cobro real de 5.000.
      const ingresos = await prisma.journalLine.aggregate({
        where: {
          entry: { entityId: fulltechId, status: { in: ['POSTED', 'REVERSED'] } },
          ledgerAccount: { code: { startsWith: '4' } },
        },
        _sum: { credit: true },
      });
      expect(Number(ingresos._sum.credit ?? 0)).toBe(5000);
    });
  });

  // ---------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------

  async function categoryByName(name: string): Promise<string> {
    const response = await http.get(`/api/v1/categories?entityId=${personalId}`).set(auth()).expect(200);
    const category = response.body.find((row: { name: string }) => row.name === name);
    expect(category).toBeTruthy();
    return category.id as string;
  }

  /** Cuántas líneas de ingreso (4xxx) tiene una unidad. */
  async function incomeLinesOf(entityId: string): Promise<number> {
    return prisma.journalLine.count({
      where: {
        entry: { entityId, status: { in: ['POSTED', 'REVERSED'] } },
        ledgerAccount: { code: { startsWith: '4' } },
      },
    });
  }

  /** Cuántas líneas de gasto (5xxx/6xxx) tiene una unidad. */
  async function expenseLinesOf(entityId: string): Promise<number> {
    return prisma.journalLine.count({
      where: {
        entry: { entityId, status: { in: ['POSTED', 'REVERSED'] } },
        ledgerAccount: { OR: [{ code: { startsWith: '5' } }, { code: { startsWith: '6' } }] },
      },
    });
  }

  function accountRow(
    accounts: Array<{ accountId: string; realBalance: string; custody: string; personalNet: string; custodyByBeneficiary: Array<{ entityId: string; pending: string }> }>,
    accountId: string,
  ) {
    const row = accounts.find((account) => account.accountId === accountId);
    expect(row).toBeTruthy();
    return row!;
  }

  function byBeneficiary(rows: Array<{ entityId: string; pending: string }>, entityId: string): string {
    return rows.find((row) => row.entityId === entityId)?.pending ?? '0.00';
  }
});
