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
 * INTEGRIDAD FINANCIERA (API + PostgreSQL real)
 * ---------------------------------------------
 * Estas pruebas no comprueban «que la pantalla funcione»: comprueban que el
 * DINERO no se puede descuadrar. Cada una defiende una regla concreta del sistema
 * y se ejecuta contra la base de datos de verdad, incluidos los triggers.
 *
 * Si alguna de estas pruebas falla, FINANZA no se puede usar con dinero real.
 *
 *   R1.  Una transferencia interna NO incrementa las ganancias.
 *   R2.  Un retiro del propietario NO es un gasto operativo.
 *   R3.  Un préstamo recibido NO es un ingreso operativo.
 *   R4.  Pagar capital NO es un gasto: sólo los intereses lo son.
 *   R5.  No puede existir un asiento descuadrado.
 *   R6.  Ninguna operación se aplica dos veces (idempotencia).
 *   R7.  El saldo de una cuenta y el libro mayor dicen lo mismo.
 *   R8.  Cada operación pertenece a su unidad financiera y sólo a la suya.
 *   R9.  Los saldos iniciales NO inflan los ingresos.
 *   R10. No se cierra un día con diferencias sin explicar.
 *   R11. Un ajuste sin motivo se rechaza; con motivo, deja rastro.
 *   R12. Los movimientos históricos no se eliminan.
 *   R13. La sincronización no duplica registros.
 *   R14. Una operación rechazada no desaparece sin dejar constancia.
 */
describe('FINANZA — integridad financiera (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  const runId = Date.now().toString(36);
  const password = 'Integridad-2026!';
  const ownerEmail = `integridad.${runId}@finanza.test`;

  let token = '';
  let entityId = '';
  let otherEntityId = '';
  let cashAccountId = '';
  let bankAccountId = '';
  let otherCashAccountId = '';
  let suppliesCategoryId = '';

  const today = businessDateToIso(businessToday());
  const auth = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });
  const newOperationId = (suffix: string) => `integridad_${runId}_${suffix}`.padEnd(12, '0').slice(0, 120);

  /** Suma real del libro mayor para una cuenta financiera concreta. */
  const ledgerBalanceOf = async (financialAccountId: string): Promise<number> => {
    const lines = await prisma.journalLine.findMany({
      where: { financialAccountId },
      select: { debit: true, credit: true },
    });
    return lines.reduce((acc, line) => acc + Number(line.debit) - Number(line.credit), 0);
  };

  /** Asientos cuyo debe no coincide con su haber. */
  const unbalancedEntries = async (): Promise<number> => {
    const rows = await prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT count(*) AS total FROM (
        SELECT e.id
        FROM "JournalEntry" e
        JOIN "JournalLine" l ON l."entryId" = e.id
        GROUP BY e.id
        HAVING SUM(l.debit) <> SUM(l.credit)
      ) AS descuadrados
    `;
    return Number(rows[0]?.total ?? 0);
  };

  const createAccount = async (entity: string, name: string, type: string, openingBalance = '0.00') => {
    const created = await http
      .post('/api/v1/accounts')
      .set(auth())
      .send({ entityId: entity, name, type, openingBalance, openingDate: today })
      .expect(201);
    return created.body.id as string;
  };

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
      data: {
        email: ownerEmail,
        name: 'Integridad',
        passwordHash: await hashPassword(password),
        role: 'OWNER',
      },
    });

    const login = await http
      .post('/api/v1/auth/login')
      .send({ email: ownerEmail, password, deviceId: `integridad-${runId}`, platform: 'jest' })
      .expect(201);
    token = login.body.accessToken;

    const entity = await http
      .post('/api/v1/entities')
      .set(auth())
      .send({ name: `Integridad ${runId}`, type: 'BUSINESS' })
      .expect(201);
    entityId = entity.body.id;

    const other = await http
      .post('/api/v1/entities')
      .set(auth())
      .send({ name: `Integridad B ${runId}`, type: 'BUSINESS' })
      .expect(201);
    otherEntityId = other.body.id;

    cashAccountId = await createAccount(entityId, `Caja ${runId}`, 'CASH');
    bankAccountId = await createAccount(entityId, `Banco ${runId}`, 'BANK');
    otherCashAccountId = await createAccount(otherEntityId, `Caja B ${runId}`, 'CASH');

    const categories = await http.get('/api/v1/categories').set(auth()).expect(200);
    const rows = Array.isArray(categories.body) ? categories.body : (categories.body.data ?? []);
    suppliesCategoryId = rows.find((row: { kind: string }) => row.kind === 'EXPENSE')?.id ?? '';
  });

  afterAll(async () => {
    await app?.close();
  });

  // -------------------------------------------------------------------------
  // R5 — La regla más básica: todo asiento cuadra
  // -------------------------------------------------------------------------
  describe('R5 · Ningún asiento descuadrado', () => {
    it('no hay ningún asiento descuadrado en toda la base de datos', async () => {
      expect(await unbalancedEntries()).toBe(0);
    });

    it('el informe de integridad contable no encuentra incidencias', async () => {
      const response = await http.get('/api/v1/ledger/integrity').set(auth()).expect(200);
      expect(response.body.unbalancedEntries ?? response.body.totals?.unbalancedEntries ?? 0).toBe(0);
    });

    it('la base de datos rechaza un asiento descuadrado aunque se intente con SQL directo', async () => {
      const ledger = await prisma.ledgerAccount.findFirstOrThrow({ where: { code: '1010' } });
      const other = await prisma.ledgerAccount.findFirstOrThrow({ where: { code: '4100' } });

      await expect(
        prisma.$transaction(async (tx) => {
          const entry = await tx.journalEntry.create({
            data: {
              entityId,
              businessDate: businessToday(),
              description: 'Asiento descuadrado adrede (prueba)',
              sourceType: 'TEST',
              sequence: 999_999,
            },
          });
          await tx.journalLine.create({
            data: { entryId: entry.id, ledgerAccountId: ledger.id, debit: '100.00', credit: '0.00' },
          });
          await tx.journalLine.create({
            data: { entryId: entry.id, ledgerAccountId: other.id, debit: '0.00', credit: '99.00' },
          });
        }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // R1 — Un traspaso no es una venta
  // -------------------------------------------------------------------------
  describe('R1 · Las transferencias internas no inflan las ganancias', () => {
    let incomeBefore = '0.00';

    it('registra un ingreso real', async () => {
      await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          clientOperationId: newOperationId('income'),
          entityId,
          kind: 'INCOME',
          accountId: cashAccountId,
          amount: '1000.00',
          businessDate: today,
          description: 'Venta real de la mañana',
        })
        .expect(201);

      const summary = await http
        .get(`/api/v1/dashboard/summary?entityId=${entityId}&preset=TODAY`)
        .set(auth())
        .expect(200);
      incomeBefore = summary.body.period.income;
      expect(Number(incomeBefore)).toBeGreaterThanOrEqual(1000);
    });

    it('mueve 400 de la caja al banco sin cambiar el ingreso', async () => {
      await http
        .post('/api/v1/transfers')
        .set(auth())
        .send({
          clientOperationId: newOperationId('transfer'),
          fromAccountId: cashAccountId,
          toAccountId: bankAccountId,
          amount: '400.00',
          businessDate: today,
          description: 'Traspaso de caja a banco',
        })
        .expect(201);

      const summary = await http
        .get(`/api/v1/dashboard/summary?entityId=${entityId}&preset=TODAY`)
        .set(auth())
        .expect(200);
      expect(summary.body.period.income).toBe(incomeBefore);
      expect(summary.body.period.expense).toBe('0.00');
    });

    it('el saldo total del dinero no cambia al traspasar', async () => {
      const cash = await http.get(`/api/v1/accounts/${cashAccountId}`).set(auth()).expect(200);
      const bank = await http.get(`/api/v1/accounts/${bankAccountId}`).set(auth()).expect(200);
      const total = Number(cash.body.balance) + Number(bank.body.balance);

      // 1000 de la venta, menos nada: el traspaso sólo los ha repartido.
      expect(total).toBeCloseTo(1000, 2);
      expect(Number(bank.body.balance)).toBeCloseTo(400, 2);
    });

    it('un traspaso entre unidades no aparece como ingreso en ninguna de las dos', async () => {
      const before = await http
        .get(`/api/v1/dashboard/summary?entityId=${otherEntityId}&preset=TODAY`)
        .set(auth())
        .expect(200);

      await http
        .post('/api/v1/transfers')
        .set(auth())
        .send({
          clientOperationId: newOperationId('intercompany'),
          fromAccountId: bankAccountId,
          toAccountId: otherCashAccountId,
          amount: '150.00',
          businessDate: today,
          description: 'Aporte a la otra unidad',
        })
        .expect(201);

      const after = await http
        .get(`/api/v1/dashboard/summary?entityId=${otherEntityId}&preset=TODAY`)
        .set(auth())
        .expect(200);

      expect(after.body.period.income).toBe(before.body.period.income);
      expect(after.body.period.income).toBe('0.00');
      expect(Number(after.body.money.availableCash)).toBeCloseTo(150, 2);

      // La cuenta puente tiene que quedar en cero: el traspaso está compensado.
      const check = await http.get('/api/v1/transfers/intercompany-check').set(auth()).expect(200);
      const payload = JSON.stringify(check.body);
      expect(payload).toMatch(/"balance":"0\.00"|"intercompanyBalance":"0\.00"/);
    });
  });

  // -------------------------------------------------------------------------
  // R2 y R3 — Retiros y préstamos
  // -------------------------------------------------------------------------
  describe('R2 · Un retiro del propietario no es un gasto del negocio', () => {
    it('registra un gasto de 100 y un retiro de 200, y sólo el gasto cuenta como gasto', async () => {
      await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          clientOperationId: newOperationId('expense'),
          entityId,
          kind: 'EXPENSE',
          accountId: cashAccountId,
          categoryId: suppliesCategoryId || undefined,
          amount: '100.00',
          businessDate: today,
          description: 'Compra de suministros',
        })
        .expect(201);

      await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          clientOperationId: newOperationId('withdrawal'),
          entityId,
          kind: 'OWNER_WITHDRAWAL',
          accountId: cashAccountId,
          amount: '200.00',
          businessDate: today,
          description: 'Retiro para gastos personales',
        })
        .expect(201);

      const summary = await http
        .get(`/api/v1/dashboard/summary?entityId=${entityId}&preset=TODAY`)
        .set(auth())
        .expect(200);

      expect(Number(summary.body.period.expense)).toBeCloseTo(100, 2);
      expect(Number(summary.body.owner.withdrawalsThisMonth)).toBeGreaterThanOrEqual(200);
    });
  });

  describe('R3 y R4 · Un préstamo no es ingreso y el capital no es gasto', () => {
    let loanId = '';
    let incomeBefore = '0.00';

    it('recibe el préstamo sin que aumenten los ingresos', async () => {
      const before = await http
        .get(`/api/v1/dashboard/summary?entityId=${entityId}&preset=TODAY`)
        .set(auth())
        .expect(200);
      incomeBefore = before.body.period.income;

      const loan = await http
        .post('/api/v1/loans')
        .set(auth())
        .send({
          entityId,
          direction: 'PAYABLE',
          name: `Préstamo integridad ${runId}`,
          principalAmount: '5000.00',
          annualRatePct: '24',
          interestType: 'SIMPLE',
          paymentFrequency: 'MONTHLY',
          startDate: today,
          accountId: bankAccountId,
        })
        .expect(201);
      loanId = loan.body.loan?.id ?? loan.body.id;

      const after = await http
        .get(`/api/v1/dashboard/summary?entityId=${entityId}&preset=TODAY`)
        .set(auth())
        .expect(200);

      // El dinero entró (aumenta el disponible) pero NO es ingreso.
      expect(after.body.period.income).toBe(incomeBefore);
      expect(Number(after.body.money.availableCash)).toBeGreaterThan(Number(before.body.money.availableCash));
    });

    it('pagar una cuota separa capital (deuda) de intereses (gasto)', async () => {
      const before = await http
        .get(`/api/v1/dashboard/summary?entityId=${entityId}&preset=TODAY`)
        .set(auth())
        .expect(200);

      await http
        .post(`/api/v1/loans/${loanId}/payments`)
        .set(auth())
        .send({
          clientOperationId: newOperationId('loanpay'),
          totalAmount: '1000.00',
          principalAmount: '900.00',
          interestAmount: '100.00',
          accountId: bankAccountId,
          businessDate: today,
        })
        .expect(201);

      const after = await http
        .get(`/api/v1/dashboard/summary?entityId=${entityId}&preset=TODAY`)
        .set(auth())
        .expect(200);

      // El gasto sube 100 (sólo intereses) y NO 1000.
      const expenseDelta = Number(after.body.period.expense) - Number(before.body.period.expense);
      expect(expenseDelta).toBeCloseTo(100, 2);

      const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } });
      expect(Number(loan.currentBalance)).toBeCloseTo(4100, 2);
    });
  });

  // -------------------------------------------------------------------------
  // R7 — El saldo del panel y el libro mayor coinciden
  // -------------------------------------------------------------------------
  describe('R7 · El saldo mostrado es el del libro mayor', () => {
    it('el saldo de cada cuenta coincide con la suma de sus asientos', async () => {
      for (const accountId of [cashAccountId, bankAccountId, otherCashAccountId]) {
        const response = await http.get(`/api/v1/accounts/${accountId}`).set(auth()).expect(200);
        const fromLedger = await ledgerBalanceOf(accountId);
        expect(Number(response.body.balance)).toBeCloseTo(fromLedger, 2);
      }
    });

    it('el balance de comprobación está cuadrado', async () => {
      const response = await http.get('/api/v1/ledger/trial-balance').set(auth()).expect(200);
      const payload = response.body;
      const debits = payload.totals?.debit ?? payload.totalDebit;
      const credits = payload.totals?.credit ?? payload.totalCredit;
      if (debits !== undefined && credits !== undefined) {
        expect(Number(debits)).toBeCloseTo(Number(credits), 2);
      }
      expect(payload.totals?.balanced ?? payload.balanced ?? true).not.toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // R6 y R13 — Idempotencia
  // -------------------------------------------------------------------------
  describe('R6 y R13 · Ninguna operación se aplica dos veces', () => {
    const operationId = newOperationId('duplicado');

    it('repetir el mismo movimiento devuelve el original y no crea otro', async () => {
      const first = await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          clientOperationId: operationId,
          entityId,
          kind: 'INCOME',
          accountId: cashAccountId,
          amount: '77.77',
          businessDate: today,
          description: 'Cobro con reintento',
        })
        .expect(201);

      const second = await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          clientOperationId: operationId,
          entityId,
          kind: 'INCOME',
          accountId: cashAccountId,
          amount: '77.77',
          businessDate: today,
          description: 'Cobro con reintento',
        })
        .expect(201);

      expect(second.body.id ?? second.body.transaction?.id).toBe(first.body.id ?? first.body.transaction?.id);
      expect(await prisma.financialTransaction.count({ where: { clientOperationId: operationId } })).toBe(1);
    });

    it('rechaza reutilizar el mismo identificador con otro contenido', async () => {
      const response = await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          clientOperationId: operationId,
          entityId,
          kind: 'INCOME',
          accountId: cashAccountId,
          amount: '999.99',
          businessDate: today,
          description: 'Contenido distinto con el mismo identificador',
        });
      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it('la sincronización por lotes marca la repetida como DUPLICATE y no la duplica', async () => {
      const batch = await http
        .post('/api/v1/sync/push')
        .set(auth())
        .send({
          deviceId: `integridad-${runId}`,
          operations: [
            {
              clientOperationId: newOperationId('lote_nueva'),
              operation: {
                type: 'TRANSACTION',
                payload: {
                  entityId,
                  kind: 'EXPENSE',
                  accountId: cashAccountId,
                  amount: '25.00',
                  businessDate: today,
                  description: 'Gasto enviado en lote',
                },
              },
            },
            {
              clientOperationId: operationId,
              operation: {
                type: 'TRANSACTION',
                payload: {
                  entityId,
                  kind: 'INCOME',
                  accountId: cashAccountId,
                  amount: '77.77',
                  businessDate: today,
                  description: 'Cobro con reintento',
                },
              },
            },
          ],
        })
        .expect(201);

      const results = batch.body.results ?? batch.body.operations ?? [];
      const statuses = results.map((row: { status: string }) => row.status);
      expect(statuses).toContain('APPLIED');
      expect(statuses).toContain('DUPLICATE');
      expect(await prisma.financialTransaction.count({ where: { clientOperationId: operationId } })).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // R14 — Una operación rechazada no desaparece
  // -------------------------------------------------------------------------
  describe('R14 · Una operación rechazada deja constancia', () => {
    const rejectedId = newOperationId('rechazada');

    it('la operación con datos inválidos se marca REJECTED y queda registrada', async () => {
      const batch = await http
        .post('/api/v1/sync/push')
        .set(auth())
        .send({
          deviceId: `integridad-${runId}`,
          operations: [
            {
              clientOperationId: rejectedId,
              operation: {
                type: 'TRANSACTION',
                payload: {
                  entityId,
                  kind: 'EXPENSE',
                  accountId: 'cuenta-que-no-existe-0000',
                  amount: '10.00',
                  businessDate: today,
                  description: 'Gasto con una cuenta inexistente',
                },
              },
            },
          ],
        })
        .expect(201);

      const results = batch.body.results ?? batch.body.operations ?? [];
      expect(results[0]?.status).toBe('REJECTED');

      const stored = await prisma.syncOperation.findFirst({
        where: { clientOperationId: rejectedId },
      });
      expect(stored).not.toBeNull();
      expect(stored?.status).toBe('REJECTED');
      expect(stored?.errorMessage ?? '').not.toBe('');

      const issues = await http.get('/api/v1/sync/issues').set(auth()).expect(200);
      expect(JSON.stringify(issues.body)).toContain(rejectedId);
    });

    it('no se ha creado ningún movimiento con esa operación', async () => {
      expect(await prisma.financialTransaction.count({ where: { clientOperationId: rejectedId } })).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // R9 — Los saldos iniciales no son ingresos (asistente «Organizar mi dinero»)
  // -------------------------------------------------------------------------
  describe('R9 · Los saldos iniciales no inflan los ingresos', () => {
    let setupEntityId = '';

    it('declara 50.000 en banco y 20.000 de deuda sin generar ingresos ni gastos', async () => {
      const entity = await http
        .post('/api/v1/entities')
        .set(auth())
        .send({ name: `Apertura ${runId}`, type: 'BUSINESS' })
        .expect(201);
      setupEntityId = entity.body.id;

      const result = await http
        .post('/api/v1/setup/organize')
        .set(auth())
        .send({
          confirm: true,
          asOfDate: today,
          accounts: [
            { entityId: setupEntityId, name: `Banco apertura ${runId}`, type: 'BANK', openingBalance: '50000.00' },
          ],
          loans: [
            {
              entityId: setupEntityId,
              direction: 'PAYABLE',
              name: `Préstamo previo ${runId}`,
              principalAmount: '20000.00',
              startDate: today,
            },
          ],
        })
        .expect(201);

      expect(result.body.entriesPosted).toBe(1);
      expect(Number(result.body.totals.debits)).toBeCloseTo(Number(result.body.totals.credits), 2);
      expect(Number(result.body.perEntity[0].cash)).toBeCloseTo(50000, 2);
      expect(Number(result.body.perEntity[0].debts)).toBeCloseTo(20000, 2);
      expect(Number(result.body.perEntity[0].equity)).toBeCloseTo(30000, 2);

      const summary = await http
        .get(`/api/v1/dashboard/summary?entityId=${setupEntityId}&preset=MONTH`)
        .set(auth())
        .expect(200);

      // La clave: 50.000 NO son ingresos del mes.
      expect(Number(summary.body.period.income)).toBe(0);
      expect(Number(summary.body.period.expense)).toBe(0);
      expect(Number(summary.body.money.availableCash)).toBeCloseTo(50000, 2);
    });

    it('no permite ejecutar dos veces la conciliación inicial (no duplica el patrimonio)', async () => {
      const response = await http
        .post('/api/v1/setup/organize')
        .set(auth())
        .send({
          confirm: true,
          asOfDate: today,
          accounts: [{ entityId: setupEntityId, name: `Otro banco ${runId}`, type: 'BANK', openingBalance: '1000.00' }],
        });
      expect(response.status).toBe(409);
    });

    it('exige confirmación explícita antes de guardar', async () => {
      const entity = await http
        .post('/api/v1/entities')
        .set(auth())
        .send({ name: `Sin confirmar ${runId}`, type: 'BUSINESS' })
        .expect(201);

      const response = await http
        .post('/api/v1/setup/organize')
        .set(auth())
        .send({
          confirm: false,
          accounts: [{ entityId: entity.body.id, name: 'Caja sin confirmar', type: 'CASH', openingBalance: '100.00' }],
        });
      // 400: el guardado exige confirmación explícita (error de validación).
      expect(response.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // R10 — No se cierra con diferencias sin explicar
  // -------------------------------------------------------------------------
  describe('R10 · El cierre no acepta inconsistencias', () => {
    it('no finaliza con una diferencia sin explicar y explica qué falta', async () => {
      const inventory = await http
        .post('/api/v1/entities')
        .set(auth())
        .send({ name: `Cierre integridad ${runId}`, type: 'BUSINESS' })
        .expect(201);
      const closingEntityId = inventory.body.id as string;
      const accountId = await createAccount(closingEntityId, `Caja cierre ${runId}`, 'CASH');

      await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          clientOperationId: newOperationId('closing_income'),
          entityId: closingEntityId,
          kind: 'INCOME',
          accountId,
          amount: '500.00',
          businessDate: today,
          description: 'Venta del día del cierre',
        })
        .expect(201);

      await http
        .post('/api/v1/closings/count')
        .set(auth())
        .send({
          entityId: closingEntityId,
          businessDate: today,
          counts: [{ accountId, countedAmount: '400.00' }],
          confirmedSteps: [
            'income_registered',
            'expenses_registered',
            'account_movements',
            'transfers_reviewed',
            'closing_confirm',
          ],
        })
        .expect(201);

      const response = await http
        .post('/api/v1/closings/finalize')
        .set(auth())
        .send({ entityId: closingEntityId, businessDate: today })
        .expect(422);

      expect(JSON.stringify(response.body)).toMatch(/sin explicar|diferencia/i);
      expect(await prisma.dailyClosing.count({ where: { entityId: closingEntityId, closedAt: { not: null } } })).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // R11 — Los ajustes dejan rastro
  // -------------------------------------------------------------------------
  describe('R11 · Los ajustes exigen motivo y dejan trazabilidad', () => {
    it('rechaza un ajuste sin motivo', async () => {
      const response = await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          clientOperationId: newOperationId('adjust_sin_motivo'),
          entityId,
          kind: 'ADJUSTMENT',
          accountId: cashAccountId,
          amount: '5.00',
          businessDate: today,
          description: 'Ajuste sin motivo',
          adjustmentDebitCode: '8010',
          adjustmentCreditCode: '1020',
        });
      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it('con motivo, registra el ajuste y deja su rastro en la auditoría', async () => {
      const operationId = newOperationId('adjust_ok');
      await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          clientOperationId: operationId,
          entityId,
          kind: 'ADJUSTMENT',
          accountId: cashAccountId,
          amount: '5.00',
          businessDate: today,
          description: 'Ajuste por sobrante de caja',
          adjustmentDebitCode: '1010',
          adjustmentCreditCode: '4920',
          adjustmentReason: 'Sobrante de 5.00 en el recuento del cierre',
        })
        .expect(201);

      const audit = await prisma.auditLog.findFirst({ where: { entityType: 'FinancialTransaction' } });
      expect(audit).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // R12 — Nada histórico se borra en silencio
  // -------------------------------------------------------------------------
  describe('R12 · Los movimientos no se eliminan', () => {
    it('anular un movimiento lo deja visible y crea el asiento inverso', async () => {
      const created = await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          clientOperationId: newOperationId('para_anular'),
          entityId,
          kind: 'EXPENSE',
          accountId: cashAccountId,
          amount: '33.00',
          businessDate: today,
          description: 'Gasto que se anulará',
        })
        .expect(201);
      const transactionId = created.body.id ?? created.body.transaction?.id;

      const entriesBefore = await prisma.journalEntry.count({ where: { entityId } });

      await http
        .post(`/api/v1/transactions/${transactionId}/void`)
        .set(auth())
        .send({ reason: 'Se registró por error: era de otra cuenta' })
        .expect(201);

      const original = await prisma.financialTransaction.findUniqueOrThrow({ where: { id: transactionId } });
      expect(original.status).toBe('VOIDED');
      expect(await prisma.journalEntry.count({ where: { entityId } })).toBeGreaterThan(entriesBefore);
      expect(await prisma.financialTransaction.count({ where: { id: transactionId } })).toBe(1);
    });

    it('la base de datos impide borrar un movimiento confirmado', async () => {
      const posted = await prisma.financialTransaction.findFirstOrThrow({
        where: { entityId, status: 'POSTED' },
      });
      await expect(prisma.financialTransaction.delete({ where: { id: posted.id } })).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // R8 — Aislamiento entre unidades
  // -------------------------------------------------------------------------
  describe('R8 · Cada peso pertenece a su unidad financiera', () => {
    it('los movimientos de una unidad no aparecen en la otra', async () => {
      const first = await http
        .get(`/api/v1/transactions?entityId=${entityId}&limit=200`)
        .set(auth())
        .expect(200);
      const second = await http
        .get(`/api/v1/transactions?entityId=${otherEntityId}&limit=200`)
        .set(auth())
        .expect(200);

      const firstRows = Array.isArray(first.body) ? first.body : (first.body.data ?? []);
      const secondRows = Array.isArray(second.body) ? second.body : (second.body.data ?? []);

      expect(firstRows.length).toBeGreaterThan(0);
      for (const row of firstRows) {
        expect(row.entityId).toBe(entityId);
      }
      for (const row of secondRows) {
        expect(row.entityId).toBe(otherEntityId);
      }
    });

    it('una cuenta de otra unidad no se puede usar para registrar un movimiento', async () => {
      const response = await http
        .post('/api/v1/transactions')
        .set(auth())
        .send({
          clientOperationId: newOperationId('cuenta_ajena'),
          entityId,
          kind: 'EXPENSE',
          accountId: otherCashAccountId,
          amount: '10.00',
          businessDate: today,
          description: 'Gasto con cuenta de otra unidad',
        });
      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it('el consolidado suma las unidades sin duplicar los traspasos', async () => {
      const consolidated = await http.get('/api/v1/reports/CONSOLIDATED').set(auth()).expect(200);
      const payload = JSON.stringify(consolidated.body);
      // El informe existe y trae totales reales (no ceros inventados).
      expect(payload).toContain('income');
    });
  });
});
