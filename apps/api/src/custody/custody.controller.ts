import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import {
  CollectIntoCustodyDto,
  CustodyQuery,
  ListPendingCustodyQuery,
  OpenCustodyFundsDto,
  PayExpenseFromCustodyDto,
  SettleCustodyDto,
  VoidCustodyMovementDto,
} from './custody.dto.js';
import { CustodyService } from './custody.service.js';

/**
 * FONDOS EMPRESARIALES EN CUENTAS PERSONALES
 * ------------------------------------------
 * El usuario no necesita saber nada de las cuentas 1130 y 2150: desde la app
 * elige «cobré para Fulltech en mi Banreservas», «esto ya estaba ahí», «liquidar»
 * o «pagué un gasto de Ap pyra con ese dinero». El servidor decide los asientos.
 */
@Controller('custody')
export class CustodyController {
  constructor(private readonly custody: CustodyService) {}

  /** Cobro de una empresa que entra en una cuenta de otra unidad (custodia). */
  @Post('collect')
  collect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CollectIntoCustodyDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.custody.collect(user, dto, meta);
  }

  /** Dinero de la empresa que YA estaba depositado antes de usar FINANZA. */
  @Post('opening')
  opening(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: OpenCustodyFundsDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.custody.openExistingFunds(user, dto, meta);
  }

  /** Liquidación total, parcial o agrupada hacia una cuenta de la empresa. */
  @Post('settle')
  settle(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SettleCustodyDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.custody.settle(user, dto, meta);
  }

  /** Gasto de la empresa pagado con dinero que estaba en custodia. */
  @Post('expense')
  payExpense(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PayExpenseFromCustodyDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.custody.payExpenseFromCustody(user, dto, meta);
  }

  /** Qué hay pendiente de liquidar, por empresa y cuenta que lo custodia. */
  @Get('pending')
  pending(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPendingCustodyQuery) {
    return this.custody.pending(user, query);
  }

  /** Panel: saldo real, fondos de empresas en custodia y neto personal por cuenta. */
  @Get('summary')
  summary(@CurrentUser() user: AuthenticatedUser, @Query() query: CustodyQuery) {
    return this.custody.summary(user, query);
  }

  /** Historial de cobros, aperturas, liquidaciones y gastos pagados con custodia. */
  @Get('movements')
  movements(@CurrentUser() user: AuthenticatedUser, @Query() query: CustodyQuery) {
    return this.custody.movements(user, query);
  }

  /** Anula una liquidación o un gasto pagado con custodia (reversa, no borra). */
  @Post('movements/:id/void')
  voidMovement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: VoidCustodyMovementDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.custody.voidMovement(user, id, dto.reason, meta);
  }
}
