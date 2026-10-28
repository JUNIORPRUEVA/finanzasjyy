import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { verifyPassword } from '../auth/password.js';
import type { CreateReminderDto, UpdateReminderDto } from './reminders.dto.js';
import {
  isDueNow,
  nextOccurrence,
  reminderBase,
  toRrule,
  type ReminderSchedule,
} from './reminder-recurrence.js';
import { buildIcs, reminderDescription, type CalendarEventInput } from './calendar-ics.js';

/**
 * RECORDATORIOS Y NOTAS
 * ---------------------
 * Lo que el usuario necesita tener a mano (una nota suelta o una lista de
 * puntos) y, si lo pide, que la app se lo recuerde:
 *
 *  · aviso push a la hora indicada, una sola vez, todos los días o cada mes;
 *  · y en el calendario del teléfono (Google Calendar) mediante un enlace de
 *    suscripción, que además incluye los COMPROMISOS MENSUALES, los préstamos y
 *    las cuentas por pagar: todo lo que no se puede olvidar.
 *
 * Borrar exige la contraseña de quien lo creó. No es un adorno: es la única
 * forma de que un aviso importante no desaparezca por un toque de más.
 */
@Injectable()
export class RemindersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  async list(user: AuthenticatedUser, params: { entityId?: string; onlyAlerts?: boolean } = {}) {
    const entityIds = await this.access.resolveScope(user.userId, params.entityId ?? undefined);
    const rows = await this.prisma.reminder.findMany({
      where: {
        isActive: true,
        ...(params.onlyAlerts ? { alertEnabled: true } : {}),
        OR: [{ userId: user.userId }, { entityId: { in: entityIds } }],
      },
      include: {
        entity: { select: { id: true, name: true, code: true } },
        creator: { select: { id: true, name: true } },
      },
      orderBy: [{ alertEnabled: 'desc' }, { alertAt: 'asc' }, { createdAt: 'desc' }],
      take: 300,
    });

    return rows.map((row) => this.present(row, user.userId));
  }

  // -------------------------------------------------------------------------
  // Alta y edición
  // -------------------------------------------------------------------------

  async create(user: AuthenticatedUser, dto: CreateReminderDto, meta: RequestMetaInfo) {
    if (dto.entityId) {
      await this.access.assertCanWrite(user.userId, dto.entityId);
    }

    const timezone = await this.userTimezone(user.userId);
    const alertAt = dto.alertEnabled ? this.parseAlertAt(dto.alertAt) : null;
    const items = this.normalizeItems(dto.items);
    const isList = dto.isList === true;

    if (isList && items.length === 0) {
      throw new ValidationError('Una lista necesita al menos un punto. Escriba el primero o elija «Nota simple».');
    }

    const reminder = await this.prisma.reminder.create({
      data: {
        userId: user.userId,
        createdByUserId: user.userId,
        entityId: dto.entityId ?? null,
        title: dto.title.trim(),
        isList,
        notes: isList ? null : (dto.notes?.trim() ?? null),
        itemsJson: isList ? items : undefined,
        alertEnabled: dto.alertEnabled === true,
        alertAt,
        timezone,
        repeat: dto.repeat ?? 'ONCE',
      },
      include: {
        entity: { select: { id: true, name: true, code: true } },
        creator: { select: { id: true, name: true } },
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'reminder.created',
      entityType: 'Reminder',
      entityId: reminder.id,
      after: { title: reminder.title, alertEnabled: reminder.alertEnabled, repeat: reminder.repeat },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.present(reminder, user.userId);
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateReminderDto, meta: RequestMetaInfo) {
    const existing = await this.loadVisible(user.userId, id);

    if (dto.entityId !== undefined && dto.entityId !== existing.entityId) {
      if (!dto.entityId) {
        throw new ValidationError('Elija una unidad financiera o deje el recordatorio sin unidad.');
      }
      await this.access.assertCanWrite(user.userId, dto.entityId);
    }

    const items = dto.items !== undefined ? this.normalizeItems(dto.items) : undefined;
    const isList = dto.isList ?? existing.isList;
    const alertEnabled = dto.alertEnabled ?? existing.alertEnabled;
    const alertAt =
      dto.alertEnabled === false
        ? null
        : dto.alertAt !== undefined
          ? this.parseAlertAt(dto.alertAt)
          : existing.alertAt;

    if (alertEnabled && !alertAt) {
      throw new ValidationError('Para que se le avise hace falta la fecha y la hora del recordatorio.');
    }
    if (isList && items !== undefined && items.length === 0) {
      throw new ValidationError('Una lista necesita al menos un punto.');
    }

    const updated = await this.prisma.reminder.update({
      where: { id },
      data: {
        title: dto.title !== undefined ? dto.title.trim() : undefined,
        isList,
        notes: isList ? null : dto.notes !== undefined ? (dto.notes.trim() || null) : undefined,
        ...(items !== undefined ? { itemsJson: items } : {}),
        alertEnabled,
        alertAt,
        repeat: dto.repeat ?? undefined,
        entityId: dto.entityId !== undefined ? dto.entityId || null : undefined,
      },
      include: {
        entity: { select: { id: true, name: true, code: true } },
        creator: { select: { id: true, name: true } },
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'reminder.updated',
      entityType: 'Reminder',
      entityId: id,
      before: { title: existing.title, alertEnabled: existing.alertEnabled, alertAt: existing.alertAt },
      after: { title: updated.title, alertEnabled: updated.alertEnabled, alertAt: updated.alertAt },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.present(updated, user.userId);
  }

  // -------------------------------------------------------------------------
  // Borrado con contraseña
  // -------------------------------------------------------------------------

  async remove(user: AuthenticatedUser, id: string, password: string, meta: RequestMetaInfo) {
    const existing = await this.loadVisible(user.userId, id);

    const creator = await this.prisma.user.findUnique({
      where: { id: existing.createdByUserId },
      select: { id: true, name: true, passwordHash: true },
    });

    if (!creator) {
      throw new NotFoundError('Recordatorio', id);
    }

    const correct = await verifyPassword(creator.passwordHash, password).catch(() => false);

    if (!correct) {
      await this.audit.record({
        userId: user.userId,
        action: 'reminder.delete.rejected',
        entityType: 'Reminder',
        entityId: id,
        after: { reason: 'WRONG_PASSWORD', creatorId: creator.id },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new ForbiddenError(
        `La contraseña no es la de ${creator.name}, que creó este recordatorio. Sin ella no se puede borrar.`,
      );
    }

    await this.prisma.reminder.delete({ where: { id } });

    await this.audit.record({
      userId: user.userId,
      action: 'reminder.deleted',
      entityType: 'Reminder',
      entityId: id,
      before: { title: existing.title, alertEnabled: existing.alertEnabled },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { id, deleted: true };
  }

  // -------------------------------------------------------------------------
  // Calendario (Google Calendar y cualquier app compatible con ICS)
  // -------------------------------------------------------------------------

  /** Enlace secreto de suscripción. Se crea la primera vez y no cambia solo. */
  async calendarLink(user: AuthenticatedUser, baseUrl: string) {
    let feed = await this.prisma.calendarFeed.findUnique({ where: { userId: user.userId } });
    if (!feed) {
      feed = await this.prisma.calendarFeed.create({
        data: { userId: user.userId, token: randomBytes(24).toString('hex') },
      });
    }
    if (!feed.isActive) {
      feed = await this.prisma.calendarFeed.update({ where: { id: feed.id }, data: { isActive: true } });
    }
    return this.presentCalendarLink(feed.token, baseUrl);
  }

  /** Cambia el enlace: el anterior deja de funcionar de inmediato. */
  async rotateCalendarToken(user: AuthenticatedUser, baseUrl: string, meta: RequestMetaInfo) {
    const token = randomBytes(24).toString('hex');
    const feed = await this.prisma.calendarFeed.upsert({
      where: { userId: user.userId },
      create: { userId: user.userId, token },
      update: { token, isActive: true },
    });
    await this.audit.record({
      userId: user.userId,
      action: 'reminder.calendar.rotated',
      entityType: 'CalendarFeed',
      entityId: feed.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return this.presentCalendarLink(feed.token, baseUrl);
  }

  private presentCalendarLink(token: string, baseUrl: string) {
    const clean = baseUrl.replace(/\/+$/, '');
    const url = `${clean}/api/v1/calendar/feed/${token}`;
    return {
      url,
      // «webcal://» abre directamente la app de calendario del teléfono.
      webcalUrl: url.replace(/^https?:\/\//, 'webcal://'),
      googleUrl: `https://calendar.google.com/calendar/r/settings/addbyurl?url=${encodeURIComponent(url)}`,
      instructions: [
        'Copie el enlace.',
        'En Google Calendar (ordenador): Otros calendarios → «+» → «Suscribirse a un calendario» → pegue el enlace.',
        'En el teléfono: toque el enlace webcal y el sistema lo añadirá a su calendario.',
        'El enlace es secreto: cualquiera que lo tenga puede ver los títulos de sus recordatorios.',
      ],
    };
  }

  /** Construye el calendario de un enlace. Se sirve sin sesión: el token es la llave. */
  async buildFeed(token: string): Promise<{ body: string; calendarName: string }> {
    const feed = await this.prisma.calendarFeed.findUnique({
      where: { token },
      include: { user: { select: { id: true, name: true, preference: { select: { timezone: true } } } } },
    });

    if (!feed || !feed.isActive) {
      throw new NotFoundError('Calendario');
    }

    const timezone = feed.user.preference?.timezone ?? 'America/Santo_Domingo';
    const userId = feed.user.id;
    const entityIds = await this.access.resolveScope(userId);

    const [reminders, recurrings, loans, payables] = await Promise.all([
      this.prisma.reminder.findMany({
        where: { userId, isActive: true, alertEnabled: true, alertAt: { not: null } },
        select: {
          id: true,
          title: true,
          notes: true,
          itemsJson: true,
          alertAt: true,
          repeat: true,
          timezone: true,
          entity: { select: { name: true } },
        },
      }),
      this.prisma.recurringObligation.findMany({
        where: { entityId: { in: entityIds }, status: 'ACTIVE' },
        select: {
          id: true,
          name: true,
          nextDueDate: true,
          frequency: true,
          remindDaysBefore: true,
          direction: true,
          amount: true,
          currency: true,
          entity: { select: { name: true } },
        },
      }),
      this.prisma.loan.findMany({
        where: { entityId: { in: entityIds }, status: 'ACTIVE', direction: 'PAYABLE', nextDueDate: { not: null } },
        select: {
          id: true,
          name: true,
          nextDueDate: true,
          installmentAmount: true,
          currentBalance: true,
          currency: true,
          entity: { select: { name: true } },
        },
      }),
      this.prisma.payable.findMany({
        where: {
          entityId: { in: entityIds },
          status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] },
          dueDate: { not: null },
        },
        select: {
          id: true,
          description: true,
          dueDate: true,
          originalAmount: true,
          settledAmount: true,
          entity: { select: { name: true } },
        },
      }),
    ]);

    const events: CalendarEventInput[] = [];

    for (const reminder of reminders) {
      const schedule: ReminderSchedule = {
        alertAt: reminder.alertAt,
        repeat: reminder.repeat,
        timezone: reminder.timezone || timezone,
      };
      const base = reminderBase(schedule);
      if (!base || !reminder.alertAt) {
        continue;
      }
      events.push({
        uid: `recordatorio-${reminder.id}@finanza`,
        summary: `🔔 ${reminder.title}`,
        description: reminderDescription(
          reminder.notes,
          readItems(reminder.itemsJson).map((item) => item.text),
        ),
        start: reminder.alertAt,
        durationMinutes: 30,
        rrule: toRrule(schedule),
        alarmMinutesBefore: 10,
        category: reminder.entity?.name ? `Recordatorio · ${reminder.entity.name}` : 'Recordatorio',
      });
    }

    for (const obligation of recurrings) {
      if (!obligation.nextDueDate) {
        continue;
      }
      events.push({
        uid: `compromiso-${obligation.id}@finanza`,
        summary: `💳 ${obligation.name}`,
        description:
          `${obligation.direction === 'PAYABLE' ? 'Pago' : 'Cobro'} de ${obligation.amount.toFixed(2)} ${obligation.currency}` +
          ` · ${obligation.entity.name}`,
        start: atNineLocal(obligation.nextDueDate, timezone),
        durationMinutes: 30,
        rrule: rruleForFrequency(obligation.frequency, obligation.nextDueDate),
        alarmMinutesBefore: Math.max(1, obligation.remindDaysBefore) * 24 * 60,
        category: 'Compromiso mensual',
      });
    }

    for (const loan of loans) {
      if (!loan.nextDueDate) {
        continue;
      }
      events.push({
        uid: `prestamo-${loan.id}@finanza`,
        summary: `🏦 Cuota: ${loan.name}`,
        description:
          `Cuota de ${(loan.installmentAmount ?? loan.currentBalance).toFixed(2)} ${loan.currency}` +
          ` · ${loan.entity.name}`,
        start: atNineLocal(loan.nextDueDate, timezone),
        durationMinutes: 30,
        rrule: `FREQ=MONTHLY;BYMONTHDAY=${loan.nextDueDate.getUTCDate()}`,
        alarmMinutesBefore: 3 * 24 * 60,
        category: 'Préstamo',
      });
    }

    for (const payable of payables) {
      if (!payable.dueDate) {
        continue;
      }
      events.push({
        uid: `pagar-${payable.id}@finanza`,
        summary: `📄 Vence: ${payable.description}`,
        description:
          `Pendiente ${payable.originalAmount.minus(payable.settledAmount).toFixed(2)} · ${payable.entity.name}`,
        start: atNineLocal(payable.dueDate, timezone),
        durationMinutes: 30,
        alarmMinutesBefore: 24 * 60,
        category: 'Cuenta por pagar',
      });
    }

    // Se deja constancia de que el enlace se está usando (Google lo consulta a menudo).
    await this.prisma.calendarFeed.update({ where: { id: feed.id }, data: { lastUsedAt: new Date() } });

    const calendarName = `FINANZA — ${feed.user.name}`;
    return { body: buildIcs(events, { calendarName }), calendarName };
  }

  // -------------------------------------------------------------------------
  // Ayudas internas
  // -------------------------------------------------------------------------

  private async loadVisible(userId: string, id: string) {
    const reminder = await this.prisma.reminder.findUnique({ where: { id } });
    if (!reminder) {
      throw new NotFoundError('Recordatorio', id);
    }
    if (reminder.userId === userId) {
      return reminder;
    }
    if (reminder.entityId) {
      await this.access.assertCanRead(userId, reminder.entityId);
      return reminder;
    }
    // No se revela que existe: para este usuario simplemente no está.
    throw new NotFoundError('Recordatorio', id);
  }

  private parseAlertAt(value: string | undefined): Date {
    if (!value) {
      throw new ValidationError('Indique la fecha y la hora del aviso.');
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError('La fecha y la hora del aviso no son válidas.');
    }
    return parsed;
  }

  private normalizeItems(items: Array<{ text: string }> | undefined) {
    if (!items) {
      return [] as Array<{ id: string; text: string }>;
    }
    return items
      .map((item) => item.text.trim())
      .filter((text) => text.length > 0)
      .map((text, index) => ({ id: `it_${index + 1}`, text: text.slice(0, 200) }));
  }

  private async userTimezone(userId: string): Promise<string> {
    const preference = await this.prisma.userPreference.findUnique({
      where: { userId },
      select: { timezone: true },
    });
    return preference?.timezone ?? 'America/Santo_Domingo';
  }

  private present(
    row: {
      id: string;
      title: string;
      isList: boolean;
      notes: string | null;
      itemsJson: unknown;
      alertEnabled: boolean;
      alertAt: Date | null;
      timezone: string;
      repeat: ReminderSchedule['repeat'];
      isActive: boolean;
      userId: string;
      createdByUserId: string;
      createdAt: Date;
      updatedAt: Date;
      entity?: { id: string; name: string; code: string } | null;
      creator?: { id: string; name: string } | null;
    },
    currentUserId: string,
  ) {
    const items = readItems(row.itemsJson);
    const schedule: ReminderSchedule = { alertAt: row.alertAt, repeat: row.repeat, timezone: row.timezone };
    const now = DateTime.now();
    const due = row.alertEnabled ? isDueNow(schedule, now) : false;

    return {
      id: row.id,
      title: row.title,
      isList: row.isList,
      notes: row.notes,
      items,
      alertEnabled: row.alertEnabled,
      alertAt: row.alertAt ? row.alertAt.toISOString() : null,
      repeat: row.repeat,
      timezone: row.timezone,
      isActive: row.isActive,
      entity: row.entity ?? null,
      creator: row.creator ?? null,
      // Sólo quien la creó puede borrarla con SU contraseña; se dice en la interfaz.
      canDelete: row.userId === currentUserId,
      isOwnedByMe: row.userId === currentUserId,
      dueNow: due,
      nextAlertAt: nextOccurrence(schedule, now)?.toUTC().toISO() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** Los puntos de una lista, vengan como vengan del JSON. */
function readItems(value: unknown): Array<{ id: string; text: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === 'string') {
        return { id: '', text: item };
      }
      if (item && typeof item === 'object') {
        const record = item as { id?: unknown; text?: unknown };
        return {
          id: typeof record.id === 'string' ? record.id : '',
          text: typeof record.text === 'string' ? record.text : '',
        };
      }
      return { id: '', text: '' };
    })
    .filter((item) => item.text.length > 0)
    .map((item, index) => ({ id: item.id || `it_${index + 1}`, text: item.text }));
}

/** La hora de un vencimiento, a las 9:00 de la zona del usuario. */
function atNineLocal(date: Date, timezone: string): Date {
  return DateTime.fromJSDate(date, { zone: 'utc' }).setZone(timezone).set({ hour: 9, minute: 0, second: 0 }).toUTC().toJSDate();
}

/** Repetición en el calendario según la frecuencia del compromiso. */
function rruleForFrequency(frequency: string, nextDueDate: Date): string | null {
  const day = nextDueDate.getUTCDate();
  switch (frequency) {
    case 'WEEKLY':
      return 'FREQ=WEEKLY';
    case 'BIWEEKLY':
      return 'FREQ=WEEKLY;INTERVAL=2';
    case 'MONTHLY':
      return `FREQ=MONTHLY;BYMONTHDAY=${day}`;
    case 'QUARTERLY':
      return `FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=${day}`;
    case 'SEMIANNUAL':
      return `FREQ=MONTHLY;INTERVAL=6;BYMONTHDAY=${day}`;
    case 'ANNUAL':
      return 'FREQ=YEARLY';
    default:
      return null;
  }
}
