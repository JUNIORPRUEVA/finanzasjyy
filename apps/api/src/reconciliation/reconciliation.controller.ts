import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import {
  ConfirmReconciliationDto,
  DismissReconciliationDto,
  ListReconciliationQuery,
  PreviewReconciliationDto,
} from './reconciliation.dto.js';
import { ReconciliationService } from './reconciliation.service.js';

/**
 * Conciliación guiada de una cuenta: «el banco dice X, el libro dice Y».
 *
 * `preview` no escribe nada; sólo compara y explica. `confirm` es el único paso
 * que puede generar un asiento, y siempre con motivo.
 */
@Controller('accounts/:accountId/reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Post('preview')
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId') accountId: string,
    @Body() dto: PreviewReconciliationDto,
  ) {
    return this.reconciliation.preview(user, accountId, dto);
  }

  @Post('confirm')
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId') accountId: string,
    @Body() dto: ConfirmReconciliationDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.reconciliation.confirm(user, accountId, dto, meta);
  }

  @Post('dismiss')
  dismiss(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId') accountId: string,
    @Body() dto: DismissReconciliationDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.reconciliation.dismiss(user, accountId, dto, meta);
  }

  @Get()
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId') accountId: string,
    @Query() query: ListReconciliationQuery,
  ) {
    return this.reconciliation.history(user, accountId, query);
  }
}
