import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import { CreateTransactionDto, ListTransactionsQuery, VoidTransactionDto } from './transactions.dto.js';
import { TransactionsService } from './transactions.service.js';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  /** Registra un movimiento. Es idempotente si se envía clientOperationId. */
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTransactionDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.transactions.create(user, dto, meta);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListTransactionsQuery) {
    return this.transactions.list(user, query);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.transactions.get(user, id);
  }

  /** Anula un movimiento: revierte el asiento y deja motivo. Nunca se borra. */
  @Post(':id/void')
  void(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: VoidTransactionDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.transactions.void(user, id, dto.reason, meta);
  }
}
