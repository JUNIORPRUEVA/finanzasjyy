import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { DailyControlService } from './daily-control.service.js';

/**
 * MI CONTROL DIARIO
 * -----------------
 * Devuelve la lista de tareas reales del día con su semáforo. No bloquea nada:
 * informa y ordena por importancia.
 */
@Controller('daily-control')
export class DailyControlController {
  constructor(private readonly dailyControl: DailyControlService) {}

  @Get()
  overview(
    @CurrentUser() user: AuthenticatedUser,
    @Query('entityId') entityId?: string,
    @Query('days') days?: string,
  ) {
    return this.dailyControl.overview(user, entityId, days ? Number(days) : 7);
  }

  /** Constancia: días seguidos cerrando y cumplimiento semanal y mensual. */
  @Get('streaks')
  streaks(@CurrentUser() user: AuthenticatedUser, @Query('entityId') entityId?: string) {
    return this.dailyControl.streaks(user, entityId);
  }
}
