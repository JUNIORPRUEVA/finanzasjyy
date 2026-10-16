import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import { OrganizeMoneyDto } from './setup.dto.js';
import { SetupService } from './setup.service.js';

/**
 * PUESTA EN MARCHA — «Organizar mi dinero»
 * ---------------------------------------
 * Es el primer paso del uso real: declarar cuánto dinero hay, a quién pertenece,
 * qué deudas existen y qué compromisos se pagan cada mes. Sin esto, FINANZA no
 * puede saber nada; con esto, todo lo demás cuadra.
 */
@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  /** Qué está registrado y qué falta. Sirve para retomar el asistente donde se quedó. */
  @Get('status')
  status(@CurrentUser() user: AuthenticatedUser, @Query('entityId') entityId?: string) {
    return this.setup.status(user, entityId);
  }

  /** Guarda la situación declarada. Atómico: o entra todo, o no entra nada. */
  @Post('organize')
  organize(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: OrganizeMoneyDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.setup.organize(user, dto, meta);
  }
}
