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
 * FASE 4 — REEMBOLSOS («pagué algo del negocio con mi dinero»)
 * ===========================================================
 * Las tres cosas que esta prueba defiende, y que son las que cuestan dinero:
 *
 *  1. El gasto se reconoce UNA vez: en la empresa. En las finanzas personales NO
 *     hay gasto (si lo hubiera, el mismo dinero se restaría dos veces).
 *  2. El patrimonio personal no baja al pagar: cambia de forma (efectivo →
 *     derecho de cobro).
 *  3. La devolución no es un gasto ni un ingreso: cierra la deuda y el derecho.
 *
 * Además: idempotencia (el mismo envío no duplica) y anulación con asientos
 * contrarios.
 */
describe('Reembolsos: el propietario paga un gasto de la empresa', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token = '';
  const runId = Date.now().toString(36);
  const password = 'Reembolso2026!segura';
  const today = businessDateToIso(businessToday());

  const auth = () => ({ Authorization: `Bearer ${token}` });

  let empresaId = '';
  let personalId = '';
  let bancoEmpresa = '';
  let tarjetaPersonal = '';
  let categoriaGasto = '';

  const saldo = async (accountId: string) => {
    const r = await http.get(`/api/v1/accounts/${accountId}`).set(auth()).expect(200);
    return r.body.balance as string;
  };

  /** Suma de un grupo de cuentas contables dentro de una unidad. */
  const saldoContable = async (entityId: string, prefijo: string) => {
    const prisma = app.get(PrismaService);
    const rows = await prisma.journalLine.findMany({
      where: { entry: { entityId, status: { in: ['POSTED', 'REVERSED'] } }, ledgerAccount: { code: { startsWith: prefijo } } },
      select: { debit: true, credit: true },
    });
    const total = rows.reduce((acc, row) => acc + Number(row.debit) - Number(row.credit), 0);
    return total.toFixed(2);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new SerializationInterceptor());
    await app.listen(0);
    const prisma = app.get(PrismaService);

    const email = `reembolso.${runId}@finanza.test`;
    await prisma.user.create({ data: { email, name: 'Reembolso', passwordHash: await hashPassword(password), role: 'OWNER' } });
    http = request(app.getHttpServer());
    const login = await http.post('/api/v1/auth/login').send({ email, password, deviceId: `d-${runId}` }).expect(201);
    token = login.body.accessToken;

    // Empresa (sociedad) y propietario (persona física): sujetos distintos.
    const srl = await http
      .post('/api/v1/entities/legal-entities')
      .set(auth())
      .send({ name: `SRL Reembolso ${runId}`, kind: 'COMPANY' })
      .expect(201);
    const persona = await http
      .post('/api/v1/entities/legal-entities')
      .set(auth())
      .send({ name: `Persona Reembolso ${runId}`, kind: 'INDIVIDUAL' })
      .expect(201);

    const empresa = await http.post('/api/v1/entities').set(auth()).send({ name: `Empresa ${runId}`, type: 'BUSINESS' }).expect(201);
    const personal = await http.post('/api/v1/entities').set(auth()).send({ name: `Personal ${runId}`, type: 'PERSONAL' }).expect(201);
    empresaId = empresa.body.id;
    personalId = personal.body.id;

    await http.patch(`/api/v1/entities/${empresaId}/structure`).set(auth()).send({ legalEntityId: srl.body.id }).expect(200);
    await http.patch(`/api/v1/entities/${personalId}/structure`).set(auth()).send({ legalEntityId: persona.body.id }).expect(200);

    bancoEmpresa = (
      await http
        .post('/api/v1/accounts')
        .set(auth())
        .send({ entityId: empresaId, name: 'Banco empresa', type: 'BANK', openingBalance: '10000.00', openingDate: today })
        .expect(201)
    ).body.id;

    tarjetaPersonal = (
      await http
        .post('/api/v1/accounts')
        .set(auth())
        .send({ entityId: personalId, name: 'Tarjeta personal', type: 'CASH', openingBalance: '3000.00', openingDate: today })
        .expect(201)
    ).body.id;

    const categorias = await http.get(`/api/v1/categories?entityId=${empresaId}&kind=EXPENSE`).set(auth()).expect(200);
    const lista = categorias.body as Array<{ id: string; name: string; defaultLedgerCode?: string }>;
    const elegida = lista.find((c) => c.defaultLedgerCode?.startsWith('6')) ?? lista[0];
    categoriaGasto = elegida.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registra el gasto una sola vez y no lo convierte en gasto personal', async () => {
    const antesPersonal = await saldo(tarjetaPersonal);

    const r = await http
      .post('/api/v1/reimbursements')
      .set(auth())
      .send({
        companyEntityId: empresaId,
        ownerAccountId: tarjetaPersonal,
        categoryId: categoriaGasto,
        amount: '1200.00',
        description: 'Hosting del servidor',
        businessDate: today,
        clientOperationId: `rmb_test_${runId}`,
      })
      .expect(201);

    expect(r.body.status).toBe('OPEN');
    expect(r.body.originalAmount).toBe('1200.00');
    expect(r.body.pending).toBe('1200.00');
    expect(r.body.affectsPersonalResult).toBe(false);

    // La empresa reconoce el gasto y queda debiendo (2350).
    expect(await saldoContable(empresaId, '6')).toBe('1200.00');
    expect(await saldoContable(empresaId, '2350')).toBe('-1200.00');

    // El propietario NO tiene gasto: tiene un derecho de cobro (1200).
    expect(await saldoContable(personalId, '1200')).toBe('1200.00');
    expect(await saldoContable(personalId, '6')).toBe('0.00');

    // Y su dinero salió de la cuenta.
    expect(antesPersonal).toBe('3000.00');
    expect(await saldo(tarjetaPersonal)).toBe('1800.00');
  });

  it('el mismo envío repetido NO duplica el reembolso', async () => {
    const r = await http
      .post('/api/v1/reimbursements')
      .set(auth())
      .send({
        companyEntityId: empresaId,
        ownerAccountId: tarjetaPersonal,
        categoryId: categoriaGasto,
        amount: '1200.00',
        description: 'Hosting del servidor',
        businessDate: today,
        clientOperationId: `rmb_test_${runId}`,
      })
      .expect(201);

    expect(r.body.duplicate).toBe(true);
    expect(await saldo(tarjetaPersonal)).toBe('1800.00');
    expect(await saldoContable(empresaId, '6')).toBe('1200.00');
  });

  it('la devolución cierra la deuda sin crear gasto ni ingreso', async () => {
    const lista = await http.get(`/api/v1/reimbursements?companyEntityId=${empresaId}`).set(auth()).expect(200);
    const abierto = (lista.body.data as Array<{ id: string; pending: string }>).find((row) => row.pending === '1200.00');
    expect(abierto).toBeTruthy();

    expect(lista.body.meta.pendingTotal).toBe('1200.00');

    const pago = await http
      .post(`/api/v1/reimbursements/${abierto!.id}/pay`)
      .set(auth())
      .send({ companyAccountId: bancoEmpresa, businessDate: today })
      .expect(201);

    expect(pago.body.status).toBe('SETTLED');
    expect(pago.body.pending).toBe('0.00');

    // Ni la deuda ni el derecho de cobro existen ya.
    expect(await saldoContable(empresaId, '2350')).toBe('0.00');
    expect(await saldoContable(personalId, '1200')).toBe('0.00');

    // El gasto sigue siendo 1200 (no se duplicó con la devolución).
    expect(await saldoContable(empresaId, '6')).toBe('1200.00');
    expect(await saldoContable(personalId, '6')).toBe('0.00');

    // El dinero se movió de verdad: empresa −1200, propietario +1200.
    expect(await saldo(bancoEmpresa)).toBe('8800.00');
    expect(await saldo(tarjetaPersonal)).toBe('3000.00');
  });

  it('no permite devolver más de lo que se debe', async () => {
    const r = await http
      .post('/api/v1/reimbursements')
      .set(auth())
      .send({
        companyEntityId: empresaId,
        ownerAccountId: tarjetaPersonal,
        categoryId: categoriaGasto,
        amount: '500.00',
        description: 'Material de oficina',
        businessDate: today,
      })
      .expect(201);

    const exceso = await http
      .post(`/api/v1/reimbursements/${r.body.id}/pay`)
      .set(auth())
      .send({ companyAccountId: bancoEmpresa, amount: '900.00', businessDate: today })
      .expect(400);
    expect(String(exceso.body.message)).toMatch(/pendientes/i);
  });

  it('anula con asientos contrarios y deja el rastro', async () => {
    const r = await http
      .post('/api/v1/reimbursements')
      .set(auth())
      .send({
        companyEntityId: empresaId,
        ownerAccountId: tarjetaPersonal,
        categoryId: categoriaGasto,
        amount: '300.00',
        description: 'Gasto equivocado',
        businessDate: today,
      })
      .expect(201);

    const anulado = await http
      .post(`/api/v1/reimbursements/${r.body.id}/void`)
      .set(auth())
      .send({ reason: 'Se registró en la unidad equivocada' })
      .expect(201);
    expect(anulado.body.status).toBe('VOIDED');

    // Ese gasto ya no cuenta: quedan el de 1200 (devuelto) y el de 500 (abierto).
    expect(await saldoContable(empresaId, '6')).toBe('1700.00');
    // Y la deuda con el propietario vuelve a ser sólo la del reembolso abierto.
    const lista = await http.get(`/api/v1/reimbursements?companyEntityId=${empresaId}`).set(auth()).expect(200);
    expect(lista.body.meta.pendingTotal).toBe('500.00');
  });

  it('rechaza un reembolso si la cuenta de la que sale el dinero no es personal', async () => {
    const r = await http
      .post('/api/v1/reimbursements')
      .set(auth())
      .send({
        companyEntityId: empresaId,
        ownerAccountId: bancoEmpresa,
        amount: '100.00',
        description: 'Prueba inválida',
        businessDate: today,
      })
      .expect(400);
    // Sale de la MISMA unidad que debe el reembolso: ni siquiera es un pago a
    // terceros, así que se rechaza antes de mirar si es personal o no.
    expect(String(r.body.message)).toMatch(/misma unidad/i);
  });

  it('rechaza un reembolso si la «cuenta personal» es de otra empresa', async () => {
    const otra = await http.post('/api/v1/entities').set(auth()).send({ name: `Otra ${runId}`, type: 'BUSINESS' }).expect(201);
    const cuentaOtra = await http
      .post('/api/v1/accounts')
      .set(auth())
      .send({ entityId: otra.body.id, name: 'Banco otra', type: 'BANK', openingBalance: '0.00', openingDate: today })
      .expect(201);

    const r = await http
      .post('/api/v1/reimbursements')
      .set(auth())
      .send({
        companyEntityId: empresaId,
        ownerAccountId: cuentaOtra.body.id,
        amount: '100.00',
        description: 'Prueba inválida',
        businessDate: today,
      })
      .expect(400);
    expect(String(r.body.message)).toMatch(/finanzas personales/i);
  });

  // -------------------------------------------------------------------------
  // Pagos parciales y coherencia con los informes
  // -------------------------------------------------------------------------
  describe('pagos parciales', () => {
    let reembolsoId = '';

    it('registra un gasto de 1.000 pendiente', async () => {
      const r = await http
        .post('/api/v1/reimbursements')
        .set(auth())
        .send({
          companyEntityId: empresaId,
          ownerAccountId: tarjetaPersonal,
          categoryId: categoriaGasto,
          amount: '1000.00',
          description: 'Licencia anual',
          businessDate: today,
          clientOperationId: `rmb_parcial_${runId}`,
        })
        .expect(201);

      reembolsoId = r.body.id;
      expect(r.body.pending).toBe('1000.00');
    });

    it('devuelve 400 y queda a medias, sin cerrar la deuda', async () => {
      const r = await http
        .post(`/api/v1/reimbursements/${reembolsoId}/pay`)
        .set(auth())
        .send({ companyAccountId: bancoEmpresa, amount: '400.00', businessDate: today })
        .expect(201);

      expect(r.body.status).toBe('PARTIAL');
      expect(r.body.settledAmount).toBe('400.00');
      expect(r.body.pending).toBe('600.00');

      // Deuda total = este reembolso (600 pendientes) + el de 500 de una prueba
      // anterior. El derecho de cobro es su espejo exacto.
      expect(await saldoContable(empresaId, '2350')).toBe('-1100.00');
      expect(await saldoContable(personalId, '1200')).toBe('1100.00');

      // Y el dinero se movió en los dos sentidos.
      expect(await saldo(bancoEmpresa)).toBe('8400.00');
      expect(await saldo(tarjetaPersonal)).toBe('1900.00');
    });

    it('un segundo pago deja 200 pendientes y el reintento del mismo pago no duplica', async () => {
      await http
        .post(`/api/v1/reimbursements/${reembolsoId}/pay`)
        .set(auth())
        .send({ companyAccountId: bancoEmpresa, amount: '400.00', businessDate: today, clientOperationId: `pago_dup_${runId}` })
        .expect(201);

      // Reintento idéntico del MISMO pago: no crea otro.
      const reintento = await http
        .post(`/api/v1/reimbursements/${reembolsoId}/pay`)
        .set(auth())
        .send({ companyAccountId: bancoEmpresa, amount: '400.00', businessDate: today, clientOperationId: `pago_dup_${runId}` })
        .expect(201);
      expect(reintento.body.duplicate).toBe(true);
      expect(reintento.body.pending).toBe('200.00');

      // Sólo se movió UNA vez.
      expect(await saldo(bancoEmpresa)).toBe('8000.00');
      expect(await saldo(tarjetaPersonal)).toBe('2300.00');
    });

    it('el último pago cierra la deuda por completo', async () => {
      const r = await http
        .post(`/api/v1/reimbursements/${reembolsoId}/pay`)
        .set(auth())
        .send({ companyAccountId: bancoEmpresa, businessDate: today })
        .expect(201);

      expect(r.body.status).toBe('SETTLED');
      expect(r.body.pending).toBe('0.00');
      // Sigue abierto el reembolso de 500 de una prueba anterior: la deuda baja
      // exactamente lo devuelto y el derecho de cobro lo refleja.
      expect(await saldoContable(empresaId, '2350')).toBe('-500.00');
      expect(await saldoContable(personalId, '1200')).toBe('500.00');

      // El dinero personal vuelve a su sitio: los 3000 iniciales menos los 500
      // del reembolso que sigue pendiente.
      expect(await saldo(bancoEmpresa)).toBe('7800.00');
      expect(await saldo(tarjetaPersonal)).toBe('2500.00');
      // Y no hay ningún gasto personal por estas operaciones.
      expect(await saldoContable(personalId, '6')).toBe('0.00');
    });

    it('no se puede anular un reembolso que ya tiene devoluciones', async () => {
      const r = await http
        .post(`/api/v1/reimbursements/${reembolsoId}/void`)
        .set(auth())
        .send({ reason: 'Intento de anular algo ya devuelto' })
        .expect(409);
      expect(String(r.body.message)).toMatch(/devuelto|devoluciones/i);
    });
  });

  it('el informe de gastos refleja el reembolso UNA vez y coincide con el libro', async () => {
    const informe = await http
      .get(`/api/v1/reports/EXPENSES_BY_CATEGORY?entityId=${empresaId}&from=${today}&to=${today}`)
      .set(auth())
      .expect(200);

    const totalLibro = await saldoContable(empresaId, '6');
    expect(Number(informe.body.totals.total).toFixed(2)).toBe(totalLibro);

    // Y en las finanzas personales no hay ningún gasto por estas operaciones.
    expect(await saldoContable(personalId, '6')).toBe('0.00');
  });
});
