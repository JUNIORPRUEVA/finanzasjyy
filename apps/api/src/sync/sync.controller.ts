import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import { ValidationError } from '../common/errors.js';
import { SyncService } from './sync.service.js';

@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  /**
   * Envía el lote de operaciones registradas sin conexión.
   * Es SEGURO reintentar: cada operación es idempotente por clientOperationId.
   */
  @Post('push')
  push(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown, @RequestMeta() meta: RequestMetaInfo) {
    return this.sync.push(user, body, meta);
  }

  /** Descarga los cambios posteriores al cursor para actualizar la caché local. */
  @Get('pull')
  pull(
    @CurrentUser() user: AuthenticatedUser,
    @Query('since') since?: string,
    @Query('entityId') entityId?: string,
    @Query('limit') limit?: string,
  ) {
    if (since && Number.isNaN(new Date(since).getTime())) {
      throw new ValidationError('El parámetro since debe ser una fecha ISO válida');
    }
    return this.sync.pull(user, { since, entityId, limit: limit ? Number(limit) : undefined });
  }

  /** Estado real de sincronización (lo que la app muestra al usuario). */
  @Get('status')
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.sync.status(user);
  }

  /** Conflictos y rechazos pendientes de decidir por el usuario. */
  @Get('issues')
  issues(@CurrentUser() user: AuthenticatedUser) {
    return this.sync.issues(user);
  }

  /** Resuelve un conflicto dejando constancia (nunca borra la operación). */
  @Post('issues/resolve')
  resolveIssue(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { syncOperationId: string; resolution: 'DISCARDED' | 'RETRY_SUGGESTED'; note?: string },
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    if (!body?.syncOperationId) {
      throw new ValidationError('Falta el identificador de la operación de sincronización');
    }
    return this.sync.resolveIssue(
      user,
      body.syncOperationId,
      body.resolution ?? 'DISCARDED',
      body.note ?? '',
      meta,
    );
  }

  /**
   * Fecha de negocio del SERVIDOR: la app la usa para no depender del reloj del
   * dispositivo (que puede estar mal configurado).
   */
  @Get('server-date')
  serverDate() {
    return { businessDate: this.sync.serverBusinessDate(), serverTime: new Date().toISOString() };
  }
}
