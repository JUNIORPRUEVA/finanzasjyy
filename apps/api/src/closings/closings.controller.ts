import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import { FinalizeClosingDto, ReopenClosingDto, SaveClosingDto } from './closings.dto.js';
import { ClosingsService } from './closings.service.js';

class ClosingQuery {
  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsString()
  date?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsString()
  days?: string;
}

@Controller('closings')
export class ClosingsController {
  constructor(private readonly closings: ClosingsService) {}

  /**
   * Paso 1 del asistente: TODO lo que hay que revisar antes de cerrar
   * (saldos esperados, resumen del día, transferencias, pendientes de sincronizar).
   */
  @Get('prepare')
  prepare(
    @CurrentUser() user: AuthenticatedUser,
    @Query('entityId') entityId: string,
    @Query('date') date?: string,
  ) {
    return this.closings.prepare(user, entityId, date);
  }

  /** Guarda el efectivo contado (queda PROVISIONAL; nunca finaliza aquí). */
  @Post('count')
  saveCount(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SaveClosingDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.closings.saveCount(user, dto, meta);
  }

  /** Finaliza el cierre. Exige diferencias explicadas y nada pendiente de sincronizar. */
  @Post('finalize')
  finalize(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: FinalizeClosingDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.closings.finalize(user, dto, meta);
  }

  /** Reapertura auditada con motivo obligatorio. */
  @Post('reopen')
  reopen(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReopenClosingDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.closings.reopen(user, dto, meta);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ClosingQuery) {
    return this.closings.list(user, query.entityId, query.from, query.to);
  }

  /** Calendario de cierres: qué días están cerrados y cuáles no. */
  @Get('calendar')
  calendar(
    @CurrentUser() user: AuthenticatedUser,
    @Query('entityId') entityId: string,
    @Query('days') days?: string,
  ) {
    return this.closings.calendar(user, entityId, days ? Number(days) : 30);
  }

  /** Semáforo VERDE/AMARILLO/ROJO con criterios verificables. */
  @Get('discipline')
  discipline(@CurrentUser() user: AuthenticatedUser, @Query('entityId') entityId?: string) {
    return this.closings.discipline(user, entityId);
  }
}
