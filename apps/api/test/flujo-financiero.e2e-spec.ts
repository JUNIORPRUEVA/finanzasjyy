import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter.js';
import { SerializationInterceptor } from '../src/common/serialization.interceptor.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { hashPassword } from '../src/auth/password.js';
import { businessDateToIso, businessToday } from '../src/domain/business-date.js';
import { dec } from '../src/domain/money.js';

/**
 * PRUEBA DE INTEGRACIÓN COMPLETA (API + PostgreSQL real)
 * -----------------------------------------------------
 * Recorre los escenarios que el usuario pidió validar: ingresos, gastos,
 * transferencias (sin inflar ingresos), retiros del propietario, préstamos,
 * cuentas por cobrar, presupuestos, cierre diario con diferencias e idempotencia
 * de la sincronización offline.
 *
 * Usa datos únicos por ejecución (prefijo E2E_ + marca de tiempo) para poder
 * ejecutarse muchas veces sin limpiar la base: los registros financieros son
 * inmutables por diseño y no se borran.
 */
describe('FINANZA — flujo financiero completo (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  const runId = Date.now().toString(36);
  const password = 'PruebaE2E-2026!';
  const ownerEmail = `e2e.owner.${runId}@finanza.test`;
  const strangerEmail = `e2e.extra.${runId}@finanza.test`;

  let token = '';
  let strangerToken = '';
  let entityId = '';
  let otherEntityId = '';
  let cashAccountId = '';
  let bankAccountId = '';
  let otherCashAccountId = '';
  let fuelCategoryId = '';
  let suppliesCategoryId = '';

  const today = businessDateToIso(businessToday());

  const auth = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });
  const authStranger = (): Record<string, string> => ({ Authorization: `Bearer ${strangerToken}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new SerializationInterceptor());

    // Se escucha en un puerto libre real (no sólo app.init()): supertest necesita
    // un servidor con dirección asignada, y con `init()` a secas la resolución de
    // la dirección falla de forma intermitente ('address' of null).
    await app.listen(0);

    prisma = app.get(PrismaService);
    http = request(app.getHttpServer());

    // Usuarios de prueba creados directamente (no por el endpoint público de
    // onboarding, que sólo funciona cuando no existe ningún usuario).
    await prisma.user.create({
      data: {
        email: ownerEmail,
        name: 'E2E Owner',
        passwordHash: await hashPassword(password),
        role: 'OWNER',
      },
    });
    await prisma.user.create({
      data: {
        email: strangerEmail,
        name: 'E2E Ajeno',
        passwordHash: await hashPassword(password),
        role: 'MEMBER',
      },
    });

    const ownerLogin = await http
      .post('/api/v1/auth/login')
      .send({ email: ownerEmail, password, deviceId: `e2e-${runId}`, platform: 'jest' })
      .expect(201);
    token = ownerLogin.body.accessToken;

    const strangerLogin = await http
      .post('/api/v1/auth/login')
      .send({ email: strangerEmail, password, deviceId: `e2e-extra-${runId}` })
      .expect(201);
    strangerToken = strangerLogin.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('1. Autenticación', () => {
    it('rechaza sin token', async () => {
      await http.get('/api/v1/entities').expect(401);
    });

    it('rechaza con token inválido', async () => {
      await http.get('/api/v1/entities').set('Authorization', 'Bearer token-falso').expect(401);
    });

    it('rechaza credenciales incorrectas', async () => {
      await http.post('/api/v1/auth/login').send({ email: ownerEmail, password: 'incorrecta' }).expect(401);
    });

    it('devuelve el perfil con preferencias y la ventana offline', async () => {
      const response = await http.get('/api/v1/auth/me').set(auth()).expect(200);
      expect(response.body.user.email).toBe(ownerEmail);
      expect(response.body.preferences.currency).toBe('DOP');
      expect(response.body.session.offlineAllowedUntil).toBeTruthy();
      expect(response.body.session.offlineWindowHours).toBeGreaterThan(0);
    });
  });

  describe('2. Unidades financieras y cuentas', () => {
    it('crea una unidad financiera nueva sin tocar código', async () => {
      const response = await http
        .post('/api/v1/entities')
        .set(auth())
        .send({ name: `E2E Negocio ${runId}`, type: 'BUSINESS', description: 'Unidad de prueba' })
        .expect(201);
      entityId = response.body.id;
      expect(response.body.code).toContain('E2E_NEGOCIO');
    });

    it('crea una segunda unidad para probar transferencias entre negocios', async () => {
      const response = await http
        .post('/api/v1/entities')
        .set(auth())
        .send({ name: `E2E Personal ${runId}`, type: 'PERSONAL' })
        .expect(201);
      otherEntityId = response.body.id;

      // Las categorías por defecto son globales: se resuelven aquí, ya con la
      // unidad financiera creada.
      fuelCategoryId = await categoryByName('Combustible');
      suppliesCategoryId = await categoryByName('Suministros de oficina');
    });

    it('crea cuentas con saldo inicial documentado', async () => {
      const cash = await http
        .post('/api/v1/accounts')
        .set(auth())
        .send({
          entityId,
          name: 'Caja principal',
          type: 'CASH',
          openingBalance: '10000.00',
          openingDate: today,
        })
        .expect(201);
      cashAccountId = cash.body.id;
      expect(cash.body.balance).toBe('10000.00');

      const bank = await http
        .post('/api/v1/accounts')
        .set(auth())
        .send({
          entityId,
          name: 'Banco principal',
          type: 'BANK',
          openingBalance: '0.00',
          openingDate: today,
        })
        .expect(201);
      bankAccountId = bank.body.id;
    });

    it('exige que una tarjeta de crédito se registre como pasivo', async () => {
      const response = await http
        .post('/api/v1/accounts')
        .set(auth())
        .send({ entityId, name: 'Tarjeta mal', type: 'BANK', isCreditCard: true, openingBalance: '0', openingDate: today })
        .expect(400);
      expect(response.body.message).toMatch(/CREDIT_CARD/);
    });

    it('no permite cambiar el saldo inicial cuando ya hay movimientos', async () => {
      await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          entityId,
          kind: 'INCOME',
          accountId: cashAccountId,
          categoryId: await incomeCategory(),
          amount: '10.00',
          description: 'Movimiento para bloquear el saldo inicial',
          clientOperationId: `e2e-block-${runId}`,
        })
        .expect(201);

      const response = await http
        .patch(`/api/v1/accounts/${cashAccountId}`)
        .set(auth())
        .send({ openingBalance: '999999.00' })
        .expect(409);
      expect(response.body.message).toMatch(/saldo inicial/i);

      await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          entityId,
          kind: 'EXPENSE',
          accountId: cashAccountId,
          categoryId: suppliesCategoryId,
          amount: '10.00',
          description: 'Reverso conceptual del movimiento anterior',
          clientOperationId: `e2e-block-undo-${runId}`,
        })
        .expect(201);
    });
  });

  describe('3. Ingresos, gastos y saldos', () => {
    it('registra un ingreso y actualiza el saldo calculado', async () => {
      const categoryId = await incomeCategory();
      const response = await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          entityId,
          kind: 'INCOME',
          accountId: cashAccountId,
          categoryId,
          amount: '1000.00',
          description: 'Venta de servicios',
          method: 'EFECTIVO',
          clientOperationId: `e2e-income-${runId}`,
        })
        .expect(201);

      expect(response.body.amount).toBe('1000.00');
      expect(response.body.affectsProfitAndLoss).toBe(true);
      expect(response.body.journalEntryId).toBeTruthy();

      const account = await http.get(`/api/v1/accounts/${cashAccountId}`).set(auth()).expect(200);
      // 10.000 iniciales + 1.000 del ingreso (los ±10 de la prueba anterior se anulan).
      expect(account.body.balance).toBe('11000.00');
    });

    it('registra un gasto', async () => {
      await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          entityId,
          kind: 'EXPENSE',
          accountId: cashAccountId,
          categoryId: suppliesCategoryId,
          amount: '250.50',
          description: 'Compra de suministros',
          clientOperationId: `e2e-expense-${runId}`,
        })
        .expect(201);

      const account = await http.get(`/api/v1/accounts/${cashAccountId}`).set(auth()).expect(200);
      expect(account.body.balance).toBe('10749.50');
    });

    it('rechaza importes con más de 2 decimales', async () => {
      await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          entityId,
          kind: 'EXPENSE',
          accountId: cashAccountId,
          amount: '10.555',
          description: 'Importe inválido',
        })
        .expect(400);
    });

    it('rechaza importes negativos', async () => {
      await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          entityId,
          kind: 'EXPENSE',
          accountId: cashAccountId,
          amount: '-10.00',
          description: 'Importe inválido',
        })
        .expect(400);
    });

    it('no admite una categoría de gastos en un ingreso', async () => {
      const response = await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          entityId,
          kind: 'INCOME',
          accountId: cashAccountId,
          categoryId: suppliesCategoryId,
          amount: '100.00',
          description: 'Categoría incoherente',
        })
        .expect(400);
      expect(response.body.message).toMatch(/no se puede usar/i);
    });
  });

  describe('4. Transferencias (no inflan los ingresos)', () => {
    it('mueve dinero de la caja al banco en una sola operación', async () => {
      const transfer = await http
        .post('/api/v1/transfers')
        .set(auth())
        .send({
          fromAccountId: cashAccountId,
          toAccountId: bankAccountId,
          amount: '5000.00',
          description: 'Depósito en banco',
          clientOperationId: `e2e-transfer-${runId}`,
        });

      // Diagnóstico explícito: sin esto, un fallo sólo muestra "expected 201".
      if (transfer.status !== 201) {
        throw new Error(`La transferencia falló: ${transfer.status} ${JSON.stringify(transfer.body)}`);
      }

      const cash = await http.get(`/api/v1/accounts/${cashAccountId}`).set(auth()).expect(200);
      const bank = await http.get(`/api/v1/accounts/${bankAccountId}`).set(auth()).expect(200);

      expect(cash.body.balance).toBe('5749.50');
      expect(bank.body.balance).toBe('5000.00');
    });

    it('la transferencia no aparece como ingreso del día', async () => {
      const dashboard = await http
        .get(`/api/v1/dashboard/summary?entityId=${entityId}&preset=TODAY`)
        .set(auth())
        .expect(200);

      // Sólo los ingresos reales del día: 1.000 + los 10 de la prueba del saldo inicial.
      // La transferencia de 5.000 NO cuenta como ingreso.
      expect(dashboard.body.today.income).toBe('1010.00');
    });

    it('rechaza transferir a la misma cuenta', async () => {
      await http
        .post('/api/v1/transfers')
        .set(auth())
        .send({
          fromAccountId: cashAccountId,
          toAccountId: cashAccountId,
          amount: '10.00',
          description: 'Duplicada',
        })
        .expect(400);
    });

    it('transferencia entre unidades distintas queda cuadrada en la cuenta puente', async () => {
      const otherCash = await http
        .post('/api/v1/accounts')
        .set(auth())
        .send({ entityId: otherEntityId, name: 'Caja personal', type: 'CASH', openingBalance: '0', openingDate: today })
        .expect(201);
      otherCashAccountId = otherCash.body.id;

      await http
        .post('/api/v1/transfers')
        .set(auth())
        .send({
          fromAccountId: cashAccountId,
          toAccountId: otherCashAccountId,
          amount: '1000.00',
          description: 'Dinero para uso personal',
          clientOperationId: `e2e-cross-transfer-${runId}`,
        })
        .expect(201);

      const check = await http.get('/api/v1/transfers/intercompany-check').set(auth()).expect(200);
      expect(check.body.balanced).toBe(true);
      expect(check.body.balance).toBe('0.00');

      const cash = await http.get(`/api/v1/accounts/${cashAccountId}`).set(auth()).expect(200);
      expect(cash.body.balance).toBe('4749.50');
    });
  });

  describe('5. Retiros y aportes del propietario', () => {
    it('registra un retiro que NO es gasto del negocio', async () => {
      await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          entityId,
          kind: 'OWNER_WITHDRAWAL',
          accountId: cashAccountId,
          amount: '1000.00',
          description: 'Retiro personal del dueño',
          clientOperationId: `e2e-withdrawal-${runId}`,
        })
        .expect(201);

      const cash = await http.get(`/api/v1/accounts/${cashAccountId}`).set(auth()).expect(200);
      expect(cash.body.balance).toBe('3749.50');
    });

    it('el retiro aparece como retiro y NO como gasto en el informe', async () => {
      const report = await http
        .get(`/api/v1/reports/OWNER_WITHDRAWALS?entityId=${entityId}&from=${today}&to=${today}`)
        .set(auth())
        .expect(200);

      expect(report.body.totals.withdrawals).toBe('1000.00');

      const expenses = await http
        .get(`/api/v1/reports/EXPENSES_BY_CATEGORY?entityId=${entityId}&from=${today}&to=${today}`)
        .set(auth())
        .expect(200);

      // El retiro no puede aparecer en el total de gastos por categoría.
      const totalExpenses = expenses.body.totals.total;
      expect(Number(totalExpenses)).toBeGreaterThan(0);
      expect(totalExpenses).not.toBe('1000.00');
    });

    it('registra un aporte de capital', async () => {
      await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          entityId,
          kind: 'OWNER_CONTRIBUTION',
          accountId: cashAccountId,
          amount: '2000.00',
          description: 'Aporte de capital del dueño',
          clientOperationId: `e2e-contribution-${runId}`,
        })
        .expect(201);

      const cash = await http.get(`/api/v1/accounts/${cashAccountId}`).set(auth()).expect(200);
      expect(cash.body.balance).toBe('5749.50');
    });
  });

  describe('6. Préstamos: capital vs intereses', () => {
    let loanId = '';

    it('un préstamo recibido entra al banco y crea deuda (no es ingreso)', async () => {
      const response = await http
        .post('/api/v1/loans')
        .set(auth())
        .send({
          entityId,
          direction: 'PAYABLE',
          name: `Préstamo banco ${runId}`,
          principalAmount: '20000.00',
          annualRatePct: '24',
          interestType: 'SIMPLE',
          paymentFrequency: 'MONTHLY',
          startDate: today,
          firstDueDate: today,
          accountId: bankAccountId,
          clientOperationId: `e2e-loan-${runId}`,
        })
        .expect(201);

      loanId = response.body.id;
      expect(response.body.currentBalance).toBe('20000.00');

      const bank = await http.get(`/api/v1/accounts/${bankAccountId}`).set(auth()).expect(200);
      expect(bank.body.balance).toBe('25000.00');

      const dashboard = await http
        .get(`/api/v1/dashboard/summary?entityId=${entityId}&preset=TODAY`)
        .set(auth())
        .expect(200);
      // El préstamo NO aumenta los ingresos del día.
      expect(dashboard.body.today.income).toBe('1010.00');
      expect(dashboard.body.obligations.loanDebt).toBe('20000.00');
    });

    it('el cuadro de amortización es informativo y no modifica el saldo', async () => {
      const schedule = await http.get(`/api/v1/loans/${loanId}/schedule`).set(auth()).expect(200);
      expect(schedule.body.rows.length).toBeGreaterThan(0);
      expect(schedule.body.disclaimer).toMatch(/No genera movimientos/);

      const loan = await http.get(`/api/v1/loans/${loanId}`).set(auth()).expect(200);
      expect(loan.body.currentBalance).toBe('20000.00');
    });

    it('un pago separa capital e intereses', async () => {
      const response = await http
        .post(`/api/v1/loans/${loanId}/payments`)
        .set(auth())
        .send({
          totalAmount: '1000.00',
          accountId: bankAccountId,
          businessDate: today,
          principalAmount: '800.00',
          interestAmount: '200.00',
          clientOperationId: `e2e-loan-payment-${runId}`,
        })
        .expect(201);

      expect(response.body.allocation.principal).toBe('800.00');
      expect(response.body.allocation.interest).toBe('200.00');
      expect(response.body.currentBalance).toBe('19200.00');

      const bank = await http.get(`/api/v1/accounts/${bankAccountId}`).set(auth()).expect(200);
      expect(bank.body.balance).toBe('24000.00');
    });

    it('no permite pagar más capital que el saldo pendiente', async () => {
      await http
        .post(`/api/v1/loans/${loanId}/payments`)
        .set(auth())
        .send({ totalAmount: '29999.00', accountId: bankAccountId, businessDate: today })
        .expect(400);
    });
  });

  describe('7. Cuentas por cobrar', () => {
    let receivableId = '';

    it('registra una cuenta por cobrar y un cobro parcial', async () => {
      const created = await http
        .post('/api/v1/obligations/receivables')
        .set(auth())
        .send({
          entityId,
          description: `Factura pendiente ${runId}`,
          originalAmount: '3000.00',
          issueDate: today,
          dueDate: today,
        })
        .expect(201);
      receivableId = created.body.id;
      expect(created.body.pendingAmount).toBe('3000.00');

      await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          entityId,
          kind: 'RECEIVABLE_SETTLEMENT',
          accountId: cashAccountId,
          receivableId,
          amount: '1500.00',
          description: 'Cobro parcial de la factura',
          clientOperationId: `e2e-collect-${runId}`,
        })
        .expect(201);

      const list = await http
        .get(`/api/v1/obligations/receivables?entityId=${entityId}`)
        .set(auth())
        .expect(200);
      const row = list.body.data.find((item: { id: string }) => item.id === receivableId);
      expect(row.pendingAmount).toBe('1500.00');
      expect(row.status).toBe('PARTIAL');
    });
  });

  describe('8. Presupuestos', () => {
    it('avisa cuando se excede el presupuesto sin bloquear el gasto real', async () => {
      const budget = await http
        .post('/api/v1/budgets')
        .set(auth())
        .send({
          entityId,
          name: `Presupuesto combustible ${runId}`,
          period: 'MONTHLY',
          startDate: today,
          allocations: [{ categoryId: fuelCategoryId, limitAmount: '500.00', warnPct: 80, alertPct: 100 }],
        })
        .expect(201);

      // Gasto real por encima del límite: se registra igualmente.
      const expense = await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          entityId,
          kind: 'EXPENSE',
          accountId: cashAccountId,
          categoryId: fuelCategoryId,
          amount: '600.00',
          description: 'Combustible del mes',
          clientOperationId: `e2e-fuel-${runId}`,
        })
        .expect(201);
      expect(expense.body.status).toBe('POSTED');

      const detail = await http.get(`/api/v1/budgets/${budget.body.id}`).set(auth()).expect(200);
      expect(detail.body.totals.spent).toBe('600.00');
      expect(detail.body.health).toBe('EXCEEDED');
      expect(detail.body.allocations[0].overLimit).toBe(true);

      const alerts = await http.get(`/api/v1/budgets/alerts?entityId=${entityId}`).set(auth()).expect(200);
      expect(alerts.body.exceeded).toBeGreaterThan(0);
    });
  });

  describe('9. Cierre diario', () => {
    let expectedCash = '';
    let countedCash = '';

    it('prepara el cierre con los saldos esperados y el resumen del día', async () => {
      const response = await http
        .get(`/api/v1/closings/prepare?entityId=${entityId}&date=${today}`)
        .set(auth())
        .expect(200);

      expect(response.body.businessDateIso).toBe(today);
      // Ingresos reales del día: 1.000 + 10. Ninguna transferencia cuenta como ingreso.
      expect(response.body.daySummary.income).toBe('1010.00');
      expect(response.body.checklist.length).toBe(10);
      expect(response.body.pendingSync.total).toBe(0);

      const count = response.body.countsNeeded.find((row: { name: string }) => row.name === 'Caja principal');
      expectedCash = count.expectedBalance as string;
      // El cierre se prueba con un faltante de exactamente 100,00.
      countedCash = dec(expectedCash).minus('100.00').toFixed(2);

      expect(Number(expectedCash)).toBeGreaterThan(0);
      expect(countedCash).not.toBe(expectedCash);
    });

    it('no permite finalizar con una diferencia sin explicar', async () => {
      await http
        .post('/api/v1/closings/count')
        .set(auth())
        .send({
          entityId,
          businessDate: today,
          counts: [{ accountId: cashAccountId, countedAmount: countedCash }],
          confirmedSteps: ['income_registered', 'expenses_registered', 'account_movements', 'transfers_reviewed', 'closing_confirm'],
        })
        .expect(201);

      const response = await http
        .post('/api/v1/closings/finalize')
        .set(auth())
        .send({ entityId, businessDate: today })
        .expect(422);
      expect(response.body.code).toBe('CLOSING_STATE_ERROR');
      expect(JSON.stringify(response.body.details)).toMatch(/sin explicar/);
    });

    it('permite finalizar cuando la diferencia está explicada y genera el ajuste', async () => {
      const count = await http
        .post('/api/v1/closings/count')
        .set(auth())
        .send({
          entityId,
          businessDate: today,
          counts: [
            {
              accountId: cashAccountId,
              countedAmount: countedCash,
              explanation: 'Faltante detectado: se pagó el almuerzo del equipo sin comprobante.',
            },
          ],
          confirmedSteps: ['income_registered', 'expenses_registered', 'account_movements', 'transfers_reviewed', 'closing_confirm'],
        })
        .expect(201);

      expect(count.body.canFinalize).toBe(true);

      const finalized = await http
        .post('/api/v1/closings/finalize')
        .set(auth())
        .send({ entityId, businessDate: today, adjustDifferences: true })
        .expect(201);

      expect(finalized.body.status).toBe('WITH_DIFFERENCES');
      expect(finalized.body.totals.expected).toBe(expectedCash);
      expect(finalized.body.totals.counted).toBe(countedCash);
      expect(finalized.body.totals.difference).toBe('-100.00');
      expect(finalized.body.adjustments.length).toBe(1);

      // El ajuste deja el saldo de la cuenta igual al efectivo contado.
      const cash = await http.get(`/api/v1/accounts/${cashAccountId}`).set(auth()).expect(200);
      expect(cash.body.balance).toBe(countedCash);
    });

    it('no permite cerrar dos veces el mismo día', async () => {
      const response = await http
        .post('/api/v1/closings/finalize')
        .set(auth())
        .send({ entityId, businessDate: today })
        .expect(409);
      expect(response.body.message).toMatch(/ya está finalizado/i);
    });

    it('exige un motivo detallado para reabrir', async () => {
      await http
        .post('/api/v1/closings/reopen')
        .set(auth())
        .send({ entityId, businessDate: today, reason: 'corto' })
        .expect(400);
    });

    it('reabre dejando constancia del motivo', async () => {
      const response = await http
        .post('/api/v1/closings/reopen')
        .set(auth())
        .send({
          entityId,
          businessDate: today,
          reason: 'Apareció el comprobante del almuerzo y hay que registrarlo correctamente.',
        })
        .expect(201);

      expect(response.body.status).toBe('REOPENED');
      expect(response.body.reopenCount).toBe(1);
    });

    it('el calendario muestra el día cerrado y el semáforo queda en rojo por el día sin cerrar de la otra unidad', async () => {
      const calendar = await http
        .get(`/api/v1/closings/calendar?entityId=${entityId}&days=7`)
        .set(auth())
        .expect(200);
      expect(calendar.body.calendar.some((day: { date: string }) => day.date === today)).toBe(true);

      const discipline = await http.get(`/api/v1/closings/discipline?entityId=${entityId}`).set(auth()).expect(200);
      expect(['GREEN', 'YELLOW', 'RED']).toContain(discipline.body.level);
      expect(Array.isArray(discipline.body.entities[0].checks)).toBe(true);
    });
  });

  describe('10. Idempotencia y sincronización offline', () => {
    it('el mismo clientOperationId no duplica el movimiento', async () => {
      const payload = {
        entityId,
        kind: 'INCOME',
        accountId: cashAccountId,
        amount: '777.00',
        description: 'Cobro con reintento',
        clientOperationId: `e2e-idem-${runId}`,
      };

      const first = await http.post('/api/v1/transactions').set(auth()).send(payload).expect(201);
      const second = await http.post('/api/v1/transactions').set(auth()).send(payload).expect(201);

      expect(second.body.id).toBe(first.body.id);
      expect(second.body.duplicate).toBe(true);
    });

    it('el mismo identificador con datos distintos se rechaza', async () => {
      const response = await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          entityId,
          kind: 'INCOME',
          accountId: cashAccountId,
          amount: '888.00',
          description: 'Datos distintos con el mismo id',
          clientOperationId: `e2e-idem-${runId}`,
        })
        .expect(409);
      expect(response.body.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('aplica un lote offline, detecta el duplicado y rechaza el reloj alterado', async () => {
      const batch = {
        deviceId: `e2e-device-${runId}`,
        platform: 'android',
        operations: [
          {
            clientOperationId: `e2e-sync-offline-1-${runId}`,
            clientRecordedAt: new Date().toISOString(),
            operation: {
              type: 'TRANSACTION',
              payload: {
                entityId,
                kind: 'EXPENSE',
                accountId: cashAccountId,
                categoryId: suppliesCategoryId,
                amount: '125.00',
                businessDate: today,
                description: 'Gasto registrado sin conexión',
              },
            },
          },
          {
            clientOperationId: `e2e-sync-offline-1-${runId}`,
            operation: {
              type: 'TRANSACTION',
              payload: {
                entityId,
                kind: 'EXPENSE',
                accountId: cashAccountId,
                categoryId: suppliesCategoryId,
                amount: '125.00',
                businessDate: today,
                description: 'Gasto registrado sin conexión',
              },
            },
          },
          {
            clientOperationId: `e2e-sync-future-${runId}`,
            clientRecordedAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
            operation: {
              type: 'TRANSACTION',
              payload: {
                entityId,
                kind: 'EXPENSE',
                accountId: cashAccountId,
                amount: '50.00',
                businessDate: today,
                description: 'Reloj adelantado',
              },
            },
          },
        ],
      };

      const response = await http.post('/api/v1/sync/push').set(auth()).send(batch).expect(201);
      expect(response.body.summary.applied).toBe(1);
      expect(response.body.summary.duplicates).toBe(1);
      expect(response.body.summary.rejected).toBe(1);

      const rejected = response.body.results.find(
        (result: { status: string }) => result.status === 'REJECTED',
      );
      expect(rejected.code).toBe('CLOCK_SKEW');

      // Reintentar el mismo lote entero no vuelve a crear nada.
      const retry = await http.post('/api/v1/sync/push').set(auth()).send(batch).expect(201);
      expect(retry.body.summary.applied).toBe(0);
      expect(retry.body.summary.duplicates).toBe(2);

      const status = await http.get('/api/v1/sync/status').set(auth()).expect(200);
      expect(status.body.conflicts).toBe(0);
    });

    it('no se puede cerrar el día si hay operaciones sin confirmar', async () => {
      // Se simula una operación pendiente en el servidor para el cierre de la
      // otra unidad financiera (que sí tiene movimientos y no está cerrada).
      await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          entityId: otherEntityId,
          kind: 'INCOME',
          accountId: otherCashAccountId,
          amount: '500.00',
          description: 'Ingreso de la unidad personal',
          clientOperationId: `e2e-other-income-${runId}`,
        })
        .expect(201);

      const prepare = await http
        .get(`/api/v1/closings/prepare?entityId=${otherEntityId}&date=${today}`)
        .set(auth())
        .expect(200);
      expect(prepare.body.pendingSync.total).toBe(0);
    });
  });

  describe('11. Integridad contable y aislamiento', () => {
    it('el libro cuadra y la cuenta intercompañía queda en cero', async () => {
      const integrity = await http.get('/api/v1/ledger/integrity').set(auth()).expect(200);
      expect(integrity.body.ok).toBe(true);
      expect(integrity.body.unbalanced).toHaveLength(0);
      expect(integrity.body.transactionsWithoutEntry).toBe(0);
      expect(integrity.body.intercompanyBalance).toBe('0.00');
    });

    it('el balance de comprobación cuadra (debe = haber)', async () => {
      const trial = await http.get('/api/v1/ledger/trial-balance').set(auth()).expect(200);
      expect(trial.body.balanced).toBe(true);
      expect(trial.body.totalDebit).toBe(trial.body.totalCredit);
    });

    it('la base de datos rechaza un asiento descuadrado', async () => {
      const entity = await prisma.financialEntity.findUniqueOrThrow({ where: { id: entityId } });
      const cashLedger = await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: '1010' } });

      await expect(
        prisma.$transaction(async (tx) => {
          await tx.journalEntry.create({
            data: {
              entityId,
              businessDate: new Date(`${today}T00:00:00.000Z`),
              description: 'Asiento descuadrado de prueba',
              sourceType: 'TEST',
              status: 'POSTED',
              lines: {
                create: [
                  { ledgerAccountId: cashLedger.id, debit: '100.00', credit: '0' },
                  { ledgerAccountId: cashLedger.id, debit: '0', credit: '50.00' },
                ],
              },
            },
          });
        }),
      ).rejects.toThrow(/descuadrado|check_violation/i);

      expect(entity.id).toBe(entityId);
    });

    it('la base de datos impide borrar movimientos confirmados', async () => {
      const transaction = await prisma.financialTransaction.findFirstOrThrow({
        where: { entityId, status: 'POSTED' },
      });

      await expect(
        prisma.financialTransaction.delete({ where: { id: transaction.id } }),
      ).rejects.toThrow(/Prohibido borrar|check_violation/i);
    });

    it('anular un movimiento lo revierte sin borrarlo', async () => {
      const created = await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          entityId,
          kind: 'EXPENSE',
          accountId: cashAccountId,
          categoryId: suppliesCategoryId,
          amount: '300.00',
          description: 'Gasto que se anulará',
          clientOperationId: `e2e-void-${runId}`,
        })
        .expect(201);

      const voided = await http
        .post(`/api/v1/transactions/${created.body.id}/void`)
        .set(auth())
        .send({ reason: 'Se registró por error en la cuenta equivocada' })
        .expect(201);

      expect(voided.body.status).toBe('VOIDED');

      const detail = await http.get(`/api/v1/transactions/${created.body.id}`).set(auth()).expect(200);
      expect(detail.body.status).toBe('VOIDED');

      // El asiento original queda marcado como reversado (no borrado).
      const entry = await http
        .get(`/api/v1/ledger/entries/${created.body.journalEntryId}`)
        .set(auth())
        .expect(200);
      expect(entry.body.status).toBe('REVERSED');
      expect(entry.body.reversedBy).toBeTruthy();
    });

    it('exige un motivo para anular', async () => {
      const created = await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          entityId,
          kind: 'EXPENSE',
          accountId: cashAccountId,
          categoryId: suppliesCategoryId,
          amount: '10.00',
          description: 'Gasto para probar el motivo obligatorio',
          clientOperationId: `e2e-void-reason-${runId}`,
        })
        .expect(201);

      await http
        .post(`/api/v1/transactions/${created.body.id}/void`)
        .set(auth())
        .send({ reason: 'x' })
        .expect(400);
    });

    it('otro usuario NO puede acceder a la unidad financiera ajena', async () => {
      await http.get(`/api/v1/entities/${entityId}`).set(authStranger()).expect(403);
      await http.get(`/api/v1/accounts/${cashAccountId}`).set(authStranger()).expect(403);
      await http.get(`/api/v1/closings/prepare?entityId=${entityId}`).set(authStranger()).expect(403);
    });

    it('otro usuario no ve las cuentas ajenas en sus listados', async () => {
      const response = await http.get('/api/v1/accounts').set(authStranger()).expect(200);
      const ids = response.body.map((account: { id: string }) => account.id);
      expect(ids).not.toContain(cashAccountId);
    });
  });

  describe('12. Reportes y exportaciones', () => {
    it('genera el informe consolidado con advertencias de calidad del dato', async () => {
      const report = await http.get(`/api/v1/reports/CONSOLIDATED?from=${today}&to=${today}`).set(auth()).expect(200);
      expect(report.body.rows.length).toBeGreaterThan(0);
      expect(report.body.period.from).toBe(today);
      expect(Array.isArray(report.body.warnings)).toBe(true);
    });

    it('exporta CSV con encabezado y BOM para Excel', async () => {
      const response = await http.get(`/api/v1/reports/ACCOUNT_STATUS/csv`).set(auth()).expect(200);
      expect(response.headers['content-type']).toMatch(/text\/csv/);
      expect(response.text.charCodeAt(0)).toBe(0xfeff);
      expect(response.text).toMatch(/Saldo calculado/);
    });

    it('el estado de cuentas reporta activos y pasivos por separado', async () => {
      const report = await http
        .get(`/api/v1/reports/ACCOUNT_STATUS?entityId=${entityId}`)
        .set(auth())
        .expect(200);
      expect(report.body.totals.assets).toBeTruthy();
      expect(report.body.totals.liabilities).toBeTruthy();
    });
  });

  describe('13. Tareas pendientes y notificaciones', () => {
    it('lista las tareas financieras pendientes con datos reales', async () => {
      const response = await http.get('/api/v1/notifications/tasks').set(auth()).expect(200);
      expect(Array.isArray(response.body.tasks)).toBe(true);
      expect(['GREEN', 'YELLOW', 'RED']).toContain(response.body.level);
    });

    it('informa con honestidad si el push está desactivado', async () => {
      const response = await http.get('/api/v1/notifications/push/status').set(auth()).expect(200);
      expect(response.body.pushEnabledOnServer).toBe(false); // sin claves VAPID en las pruebas
      expect(response.body.publicKey).toBeNull();

      const test = await http.post('/api/v1/notifications/push/test').set(auth()).expect(201);
      expect(test.body.message).toMatch(/DESACTIVADO/);
    });
  });

  describe('14. Salud del sistema', () => {
    it('responde a la sonda de preparación con la base conectada', async () => {
      const response = await http.get('/api/v1/health/ready').expect(200);
      expect(response.body.database).toBe('up');
      expect(response.body.migrationsApplied).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------

  async function incomeCategory(): Promise<string> {
    return categoryByName('Servicios prestados');
  }

  /** Busca una categoría por nombre en el catálogo global de la unidad. */
  async function categoryByName(name: string): Promise<string> {
    const response = await http
      .get(`/api/v1/categories?entityId=${entityId}`)
      .set(auth())
      .expect(200);
    const category = response.body.find((row: { name: string }) => row.name === name);
    expect(category).toBeTruthy();
    return category.id as string;
  }
});
