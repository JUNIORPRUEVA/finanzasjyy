import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter.js';
import { SerializationInterceptor } from '../src/common/serialization.interceptor.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { hashPassword } from '../src/auth/password.js';

/**
 * RECORDATORIOS Y NOTAS — PRUEBA DE PUNTA A PUNTA
 * ===============================================
 * Lo que se exige:
 *   1. Una nota y una lista se guardan con sus puntos numerados.
 *   2. El aviso puede ser una vez, diario o mensual.
 *   3. Borrar SIN la contraseña de quien lo creó NO borra nada (403) y deja rastro.
 *   4. Con la contraseña correcta se borra.
 *   5. El enlace del calendario sirve iCalendar real (con los avisos y su repetición)
 *      y un token falso no revela nada.
 */
describe('FINANZA — recordatorios y notas (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  const runId = Date.now().toString(36);
  const password = 'PruebaRecordatorios-2026!';
  const email = `e2e.recordatorios.${runId}@finanza.test`;

  let token = '';
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
      data: { email, name: 'E2E Recordatorios', passwordHash: await hashPassword(password), role: 'OWNER' },
    });

    const login = await http
      .post('/api/v1/auth/login')
      .send({ email, password, deviceId: `e2e-recordatorios-${runId}`, platform: 'jest' })
      .expect(201);
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  let noteId = '';
  let listId = '';

  it('guarda una nota con aviso diario', async () => {
    const alertAt = new Date(Date.now() + 3_600_000).toISOString();
    const response = await http
      .post('/api/v1/reminders')
      .set(auth())
      .send({ title: `Llamar al contador ${runId}`, isList: false, notes: 'Llevar las facturas', alertEnabled: true, alertAt, repeat: 'DAILY' })
      .expect(201);

    noteId = response.body.id;
    expect(response.body.title).toContain('Llamar al contador');
    expect(response.body.alertEnabled).toBe(true);
    expect(response.body.repeat).toBe('DAILY');
    expect(response.body.alertAt).toBe(alertAt);
  });

  it('guarda una lista con sus puntos numerados', async () => {
    const response = await http
      .post('/api/v1/reminders')
      .set(auth())
      .send({
        title: `Lista del súper ${runId}`,
        isList: true,
        items: [{ text: 'Arroz' }, { text: 'Aceite' }, { text: 'Café' }],
        alertEnabled: true,
        alertAt: new Date(Date.now() + 7_200_000).toISOString(),
        repeat: 'MONTHLY',
      })
      .expect(201);

    listId = response.body.id;
    expect(response.body.isList).toBe(true);
    expect(response.body.items.map((item: { text: string }) => item.text)).toEqual(['Arroz', 'Aceite', 'Café']);
    expect(response.body.items[0].id).toBe('it_1');
  });

  it('una lista sin puntos se rechaza con un mensaje claro', async () => {
    const response = await http
      .post('/api/v1/reminders')
      .set(auth())
      .send({ title: 'Lista vacía', isList: true, items: [] });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('al menos un punto');
  });

  it('se pueden editar el texto y la repetición', async () => {
    const response = await http
      .patch(`/api/v1/reminders/${noteId}`)
      .set(auth())
      .send({ repeat: 'MONTHLY' })
      .expect(200);
    expect(response.body.repeat).toBe('MONTHLY');
  });

  it('el listado devuelve lo guardado', async () => {
    const response = await http.get('/api/v1/reminders').set(auth()).expect(200);
    const ids = (response.body as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toContain(noteId);
    expect(ids).toContain(listId);
  });

  it('borrar con una contraseña equivocada NO borra nada (403)', async () => {
    const response = await http
      .delete(`/api/v1/reminders/${noteId}`)
      .set(auth())
      .send({ password: 'clave-equivocada' });
    expect(response.status).toBe(403);
    expect(await prisma.reminder.count({ where: { id: noteId } })).toBe(1);
  });

  it('borrar con la contraseña de quien lo creó sí lo borra', async () => {
    await http.delete(`/api/v1/reminders/${noteId}`).set(auth()).send({ password }).expect(200);
    expect(await prisma.reminder.count({ where: { id: noteId } })).toBe(0);
  });

  it('el enlace del calendario devuelve iCalendar con el aviso y su repetición', async () => {
    const link = await http.get('/api/v1/reminders/calendar-link').set(auth()).expect(200);
    expect(link.body.url).toContain('/api/v1/calendar/feed/');

    const tokenPart = String(link.body.url).split('/').pop() as string;
    const feed = await http.get(`/api/v1/calendar/feed/${tokenPart}`).expect(200);

    expect(feed.headers['content-type']).toContain('text/calendar');
    expect(feed.text).toContain('BEGIN:VCALENDAR');
    expect(feed.text).toContain('Lista del súper');
    expect(feed.text).toContain('RRULE:FREQ=MONTHLY');
    expect(feed.text).toContain('BEGIN:VALARM');
  });

  it('un token inventado no revela ningún calendario', async () => {
    const response = await http.get('/api/v1/calendar/feed/no-existe-este-token').expect(404);
    expect(JSON.stringify(response.body)).not.toContain('Arroz');
  });

  it('cambiar el enlace invalida el anterior', async () => {
    const first = await http.get('/api/v1/reminders/calendar-link').set(auth()).expect(200);
    const oldToken = String(first.body.url).split('/').pop() as string;

    const rotated = await http.post('/api/v1/reminders/calendar-link/rotate').set(auth()).expect(201);
    const newToken = String(rotated.body.url).split('/').pop() as string;
    expect(newToken).not.toBe(oldToken);

    await http.get(`/api/v1/calendar/feed/${oldToken}`).expect(404);
    await http.get(`/api/v1/calendar/feed/${newToken}`).expect(200);
  });
});
