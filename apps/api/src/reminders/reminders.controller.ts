import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import { CreateReminderDto, DeleteReminderDto, UpdateReminderDto } from './reminders.dto.js';
import { RemindersService } from './reminders.service.js';

/**
 * RECORDATORIOS
 * -------------
 * Ver, crear, editar y borrar notas y listas. El borrado pide la contraseña de
 * quien creó el recordatorio: es la única operación que no se puede deshacer.
 *
 * Aquí viven también los enlaces del calendario (Google Calendar y compatibles).
 */
@Controller('reminders')
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('entityId') entityId?: string,
    @Query('alerts') alerts?: string,
  ) {
    return this.reminders.list(user, { entityId, onlyAlerts: alerts === 'true' });
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateReminderDto, @RequestMeta() meta: RequestMetaInfo) {
    return this.reminders.create(user, dto, meta);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateReminderDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.reminders.update(user, id, dto, meta);
  }

  /** Borrar SIEMPRE exige la contraseña de quien creó el recordatorio. */
  @Delete(':id')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DeleteReminderDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.reminders.remove(user, id, dto.password, meta);
  }

  // --------------------------- Calendario ---------------------------------

  @Get('calendar-link')
  calendarLink(@CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    return this.reminders.calendarLink(user, baseUrl(request));
  }

  /** Cambia el enlace: el anterior deja de abrir el calendario. */
  @Post('calendar-link/rotate')
  rotateCalendarLink(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.reminders.rotateCalendarToken(user, baseUrl(request), meta);
  }
}

/** Dirección pública real (detrás de nginx el host llega en las cabeceras X-Forwarded-*). */
export function baseUrl(request: Request): string {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const proto = firstHeader(request.headers['x-forwarded-proto']) ?? request.protocol;
  const host = firstHeader(request.headers['x-forwarded-host']) ?? request.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(',')[0]?.trim() || undefined;
}
