import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import { CreateTransferDto, ListTransfersQuery } from './transfers.dto.js';
import { TransfersService } from './transfers.service.js';

@Controller('transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  /** Transferencia atómica entre dos cuentas (misma o distinta unidad). */
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTransferDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.transfers.create(user, dto, meta);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListTransfersQuery) {
    return this.transfers.list(user, query);
  }

  /** Verifica que las transferencias entre unidades no distorsionan el consolidado. */
  @Get('intercompany-check')
  intercompanyCheck(@CurrentUser() user: AuthenticatedUser) {
    return this.transfers.intercompanyCheck(user);
  }
}
