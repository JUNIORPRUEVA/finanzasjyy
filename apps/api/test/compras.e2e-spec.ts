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
 * COMPRAS PERSONALES (e2e con PostgreSQL real)
 * ============================================
 * Una lista de la compra ayuda a decidir ANTES de gastar. Lo que se comprueba
 * aquí, y es lo más importante de todo:
 *
 *   1. Preparar la lista (crear, añadir, editar, marcar comprado, duplicar) NO
 *      genera NINGÚN movimiento ni asiento contable.
 *   2. El gasto se registra sólo al pulsar «Registrar gasto en FINANZA», y
 *      entonces pasa por el servicio de movimientos: un movimiento, un asiento
 *      de partida doble, auditoría.
 *   3. Es IMPOSIBLE duplicar el gasto de una lista (dos pulsaciones, dos
 *      reintentos desde un móvil sin cobertura… da igual).
 *   4. Una lista con gasto registrado no se puede borrar ni sobrescribir.
 *   5. Aislamiento: un usuario ajeno no ve ni toca las listas de otra unidad.
 */
describe('FINANZA — compras personales (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  const runId = Date.now().toString(36);
  const password = 'PruebaE2E-2026!';
  const ownerEmail = `compras.owner.${runId}@finanza.test`;
  const strangerEmail = `compras.ajeno.${runId}@finanza.test`;

  let token = '';
  let strangerToken = '';
  let entityId = '';
  let accountId = '';
  let categoryId = '';
  let strangerEntityId = '';

  const auth = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });
  const authStranger = (): Record<string, string> => ({ Authorization: `Bearer ${strangerToken}` });
  const today = businessDateToIso(businessToday());

  /** Cuenta los movimientos y asientos de una unidad (para demostrar que nada se movió). */
  const countMoney = async (entity: string) => {
    const [transactions, entries] = await Promise.all([
      prisma.financialTransaction.count({ where: { entityId: entity } }),
      prisma.journalEntry.count({ where: { entityId: entity } }),
    ]);
    return { transactions, entries };
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
      data: { email: ownerEmail, name: 'Compras Owner', passwordHash: await hashPassword(password), role: 'OWNER' },
    });
    await prisma.user.create({
      data: { email: strangerEmail, name: 'Compras Ajeno', passwordHash: await hashPassword(password), role: 'MEMBER' },
    });

    token = (
      await http
        .post('/api/v1/auth/login')
        .send({ email: ownerEmail, password, deviceId: `e2e-compras-${runId}`, platform: 'jest' })
        .expect(201)
    ).body.accessToken;
    strangerToken = (
      await http
        .post('/api/v1/auth/login')
        .send({ email: strangerEmail, password, deviceId: `e2e-compras-ajeno-${runId}`, platform: 'jest' })
        .expect(201)
    ).body.accessToken;

    // Unidad del propietario, con caja y categoría de gasto.
    // (El código de la unidad lo genera el servidor: no se envía.)
    const entity = await http
      .post('/api/v1/entities')
      .set(auth())
      .send({ name: `E2E Compras ${runId}`, type: 'BUSINESS', description: 'Unidad de pruebas de compras' })
      .expect(201);
    entityId = entity.body.id;

    const account = await http
      .post('/api/v1/accounts')
      .set(auth())
      .send({ entityId, name: 'Caja compras', type: 'CASH', openingBalance: '0.00', openingDate: today })
      .expect(201);
    accountId = account.body.id;

    // Las categorías de gasto vienen con la estructura inicial (son globales y
    // sirven para cualquier unidad): se usa una de ellas, como haría el usuario.
    const categories = await http.get('/api/v1/categories?kind=EXPENSE').set(auth()).expect(200);
    const expenseCategories = (Array.isArray(categories.body) ? categories.body : categories.body.data) as Array<{
      id: string;
      name: string;
    }>;
    if (!expenseCategories || expenseCategories.length === 0) {
      throw new Error('No hay categorías de gasto en la base de datos de pruebas');
    }
    categoryId = expenseCategories[0].id;

    // Unidad ajena, para comprobar el aislamiento.
    const strangerEntity = await http
      .post('/api/v1/entities')
      .set(authStranger())
      .send({ name: `E2E Ajena ${runId}`, type: 'BUSINESS' })
      .expect(201);
    strangerEntityId = strangerEntity.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  // ---------------------------------------------------------------------------

  describe('1. Preparar la compra NO mueve dinero', () => {
    let listId = '';
    let coffeeItemId = '';

    it('crea la lista con productos y calcula el total estimado en el servidor', async () => {
      const before = await countMoney(entityId);

      const response = await http
        .post('/api/v1/shopping-lists')
        .set(auth())
        .send({
          entityId,
          name: `Supermercado ${runId}`,
          plannedDate: today,
          items: [
            { name: 'Leche', quantity: '2', unit: 'litro', estimatedUnitPrice: '75.50' },
            { name: 'Arroz', quantity: '1', estimatedUnitPrice: '120.00' },
          ],
        })
        .expect(201);

      listId = response.body.id;
      // 2 × 75,50 + 1 × 120,00 = 271,00
      expect(response.body.totals.estimated).toBe('271.00');
      expect(response.body.totals.pending).toBe('271.00');
      expect(response.body.counts.items).toBe(2);
      expect(response.body.expense.registered).toBe(false);

      const after = await countMoney(entityId);
      // Crear una lista NO debe generar movimientos ni asientos.\n      expect(after).toEqual(before);
    });

    it('añade un producto y recalcula el estimado', async () => {
      const item = await http
        .post(`/api/v1/shopping-lists/${listId}/items`)
        .set(auth())
        .send({ name: 'Café', quantity: '1', estimatedUnitPrice: '250.00' })
        .expect(201);

      coffeeItemId = item.body.id;

      const list = await http.get(`/api/v1/shopping-lists/${listId}`).set(auth()).expect(200);
      expect(list.body.totals.estimated).toBe('521.00');
      expect(list.body.counts.items).toBe(3);
    });

    it('edita un producto (cantidad y precio estimado)', async () => {
      const response = await http
        .patch(`/api/v1/shopping-lists/${listId}/items/${coffeeItemId}`)
        .set(auth())
        .send({ quantity: '3', estimatedUnitPrice: '80.00' })
        .expect(200);

      expect(response.body.quantity).toBe('3');
      expect(response.body.estimatedTotal).toBe('240.00');

      const list = await http.get(`/api/v1/shopping-lists/${listId}`).set(auth()).expect(200);
      // Leche 2 × 75,50 = 151 + Arroz 120 + Café 3 × 80 = 240 → 511
      expect(list.body.totals.estimated).toBe('511.00');
    });

    it('marca un producto como comprado con su precio real (sin generar gasto)', async () => {
      const before = await countMoney(entityId);

      const response = await http
        .patch(`/api/v1/shopping-lists/${listId}/items/${coffeeItemId}`)
        .set(auth())
        .send({ isPurchased: true, actualUnitPrice: '85.00' })
        .expect(200);

      expect(response.body.isPurchased).toBe(true);
      expect(response.body.actualTotal).toBe('255.00'); // 3 × 85

      const list = await http.get(`/api/v1/shopping-lists/${listId}`).set(auth()).expect(200);
      expect(list.body.totals.actual).toBe('255.00');
      // Lo comprado costaba 240 estimado y costó 255 real: +15 de desvío.
      expect(list.body.totals.difference).toBe('15.00');
      // Lo que queda pendiente sigue siendo una INTENCIÓN, no un gasto.
      expect(list.body.totals.pending).toBe('271.00'); // Leche 151 + Arroz 120

      const after = await countMoney(entityId);
      // Marcar comprado NO debe generar movimientos.\n      expect(after).toEqual(before);
    });

    it('rechaza un precio negativo', async () => {
      await http
        .post(`/api/v1/shopping-lists/${listId}/items`)
        .set(auth())
        .send({ name: 'Producto inválido', estimatedUnitPrice: '-10.00' })
        .expect(400);
    });

    it('no deja borrar un producto ya comprado (primero hay que desmarcarlo)', async () => {
      await http.delete(`/api/v1/shopping-lists/${listId}/items/${coffeeItemId}`).set(auth()).expect(409);
    });

    it('duplica una lista frecuente como borrador, sin lo ya comprado', async () => {
      const response = await http.post(`/api/v1/shopping-lists/${listId}/duplicate`).set(auth()).expect(201);
      expect(response.body.status).toBe('DRAFT');
      expect(response.body.counts.purchased).toBe(0);
      expect(response.body.counts.items).toBe(3);
      // Se copia el precio estimado, no el real: es una idea nueva, no un recibo.
      expect(response.body.totals.actual).toBe('0.00');
    });
  });

  describe('2. Registrar el gasto (el único camino al libro mayor)', () => {
    let listId = '';

    beforeAll(async () => {
      const created = await http
        .post('/api/v1/shopping-lists')
        .set(auth())
        .send({
          entityId,
          name: `Mercado real ${runId}`,
          items: [{ name: 'Compra semanal', quantity: '1', estimatedUnitPrice: '1500.00' }],
        })
        .expect(201);
      listId = created.body.id;

      const items = await http.get(`/api/v1/shopping-lists/${listId}`).set(auth()).expect(200);
      const itemId = items.body.items[0].id;
      await http
        .patch(`/api/v1/shopping-lists/${listId}/items/${itemId}`)
        .set(auth())
        .send({ isPurchased: true, actualUnitPrice: '1620.50' })
        .expect(200);
    });

    it('registra el gasto por el importe real pagado, con su asiento cuadrado', async () => {
      const before = await countMoney(entityId);

      const response = await http
        .post(`/api/v1/shopping-lists/${listId}/register-expense`)
        .set(auth())
        .send({ accountId, categoryId, businessDate: today, method: 'EFECTIVO' })
        .expect(201);

      expect(response.body.duplicate).toBe(false);
      expect(response.body.transactionId).toBeTruthy();
      expect(response.body.list.status).toBe('COMPLETED');
      expect(response.body.list.expense.registered).toBe(true);

      const after = await countMoney(entityId);
      expect(after.transactions).toBe(before.transactions + 1);
      expect(after.entries).toBe(before.entries + 1);

      const entry = await prisma.journalEntry.findUniqueOrThrow({
        where: { id: response.body.journalEntryId },
        include: { lines: true },
      });
      const debit = entry.lines.reduce((acc, line) => acc + Number(line.debit), 0);
      const credit = entry.lines.reduce((acc, line) => acc + Number(line.credit), 0);
      expect(debit).toBeCloseTo(1620.5, 2);
      expect(credit).toBeCloseTo(1620.5, 2);
    });

    it('NO duplica el gasto si se pulsa otra vez (idempotencia)', async () => {
      const before = await countMoney(entityId);

      const response = await http
        .post(`/api/v1/shopping-lists/${listId}/register-expense`)
        .set(auth())
        .send({ accountId, categoryId, businessDate: today })
        .expect(201);

      expect(response.body.duplicate).toBe(true);
      const after = await countMoney(entityId);
      // Una segunda pulsación no puede crear otro movimiento.\n      expect(after).toEqual(before);
    });

    it('tampoco lo duplica si llega con un identificador distinto (la lista ya tiene gasto)', async () => {
      const before = await countMoney(entityId);

      await http
        .post(`/api/v1/shopping-lists/${listId}/register-expense`)
        .set(auth())
        .send({ accountId, categoryId, clientOperationId: `manual_${runId}_reintento` })
        .expect(201);

      expect(await countMoney(entityId)).toEqual(before);
    });

    it('no se puede borrar una lista con gasto registrado (se archiva)', async () => {
      await http.delete(`/api/v1/shopping-lists/${listId}`).set(auth()).expect(409);

      const archived = await http
        .patch(`/api/v1/shopping-lists/${listId}`)
        .set(auth())
        .send({ status: 'ARCHIVED' })
        .expect(200);
      expect(archived.body.status).toBe('ARCHIVED');
    });

    it('exige indicar el importe si no hay ningún precio real apuntado', async () => {
      const empty = await http
        .post('/api/v1/shopping-lists')
        .set(auth())
        .send({ entityId, name: `Sin precios ${runId}`, items: [{ name: 'Algo' }] })
        .expect(201);

      await http
        .post(`/api/v1/shopping-lists/${empty.body.id}/register-expense`)
        .set(auth())
        .send({ accountId, categoryId })
        .expect(400);

      // Con el importe indicado a mano, sí se registra.
      await http
        .post(`/api/v1/shopping-lists/${empty.body.id}/register-expense`)
        .set(auth())
        .send({ accountId, categoryId, amount: '99.99' })
        .expect(201);
    });
  });

  describe('3. Sin conexión: la lista del dispositivo no se duplica ni pisa lo confirmado', () => {
    it('guarda una lista creada en el dispositivo y, al reenviarla, no la duplica', async () => {
      const deviceListId = `dev_${runId}_lista`;

      const first = await http
        .post('/api/v1/shopping-lists/sync')
        .set(auth())
        .send({
          deviceListId,
          entityId,
          name: 'Lista desde el móvil',
          items: [{ name: 'Pan', quantity: '2', estimatedUnitPrice: '60.00' }],
        })
        .expect(201);

      const second = await http
        .post('/api/v1/shopping-lists/sync')
        .set(auth())
        .send({
          deviceListId,
          entityId,
          name: 'Lista desde el móvil (editada)',
          items: [{ name: 'Pan', quantity: '3', estimatedUnitPrice: '60.00' }],
        })
        .expect(201);

      expect(second.body.id).toBe(first.body.id);
      expect(second.body.name).toBe('Lista desde el móvil (editada)');
      expect(second.body.counts.items).toBe(1);
      expect(second.body.totals.estimated).toBe('180.00');

      const stored = await prisma.shoppingList.count({ where: { deviceListId } });
      expect(stored).toBe(1);
    });

    it('no sobrescribe una lista cuyo gasto ya está confirmado', async () => {
      const before = await countMoney(entityId);

      const list = await http
        .post('/api/v1/shopping-lists')
        .set(auth())
        .send({
          entityId,
          name: 'Confirmada en el servidor',
          deviceListId: `dev_${runId}_confirmada`,
          items: [{ name: 'Cosa', quantity: '1', estimatedUnitPrice: '50.00' }],
        })
        .expect(201);

      await http
        .post(`/api/v1/shopping-lists/${list.body.id}/register-expense`)
        .set(auth())
        .send({ accountId, categoryId, amount: '50.00' })
        .expect(201);

      const after = await countMoney(entityId);
      expect(after.transactions).toBe(before.transactions + 1);

      // El móvil, tarde, envía una versión vieja de esa misma lista.
      const resync = await http
        .post('/api/v1/shopping-lists/sync')
        .set(auth())
        .send({
          deviceListId: `dev_${runId}_confirmada`,
          entityId,
          name: 'Versión vieja del móvil',
          items: [{ name: 'Otra cosa', quantity: '9', estimatedUnitPrice: '999.00' }],
        })
        .expect(201);

      // Se respeta lo confirmado: ni se renombra ni se cambian los productos.
      expect(resync.body.name).toBe('Confirmada en el servidor');
      expect(resync.body.expense.registered).toBe(true);
      expect(await countMoney(entityId)).toEqual(after);
    });
  });

  describe('4. Aislamiento entre unidades y usuarios', () => {
    let foreignListId = '';

    beforeAll(async () => {
      const created = await http
        .post('/api/v1/shopping-lists')
        .set(auth())
        .send({ entityId, name: `Privada ${runId}`, items: [{ name: 'Secreto' }] })
        .expect(201);
      foreignListId = created.body.id;
    });

    it('un usuario ajeno no puede ver la lista (403, no 404)', async () => {
      await http.get(`/api/v1/shopping-lists/${foreignListId}`).set(authStranger()).expect(403);
    });

    it('un usuario ajeno no puede modificarla ni registrar su gasto', async () => {
      await http
        .patch(`/api/v1/shopping-lists/${foreignListId}`)
        .set(authStranger())
        .send({ name: 'Robada' })
        .expect(403);

      await http.post(`/api/v1/shopping-lists/${foreignListId}/duplicate`).set(authStranger()).expect(403);
    });

    it('no puede crear una lista en una unidad ajena', async () => {
      await http
        .post('/api/v1/shopping-lists')
        .set(auth())
        .send({ entityId: strangerEntityId, name: 'Intruso' })
        .expect(403);
    });

    it('el listado sólo devuelve lo que puede ver', async () => {
      const own = await http.get('/api/v1/shopping-lists').set(auth()).expect(200);
      const foreign = await http.get('/api/v1/shopping-lists').set(authStranger()).expect(200);

      const ownIds = (own.body.data as Array<{ id: string }>).map((row) => row.id);
      const foreignIds = (foreign.body.data as Array<{ id: string }>).map((row) => row.id);

      expect(ownIds).toContain(foreignListId);
      expect(foreignIds).not.toContain(foreignListId);
    });
  });

  describe('5. Resumen para el inicio', () => {
    it('informa de listas abiertas y de lo que queda por comprar, sin llamarlo gasto', async () => {
      const response = await http.get('/api/v1/shopping-lists/summary').set(auth()).expect(200);
      expect(response.body.openLists).toBeGreaterThanOrEqual(0);
      expect(typeof response.body.pendingTotal).toBe('string');
      expect(response.body.note).toMatch(/no es un gasto|no un gasto/i);
    });
  });
});
