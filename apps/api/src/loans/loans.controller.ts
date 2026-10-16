import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import { CreateLoanDto, ListLoansQuery, RegisterLoanPaymentDto } from './loans.dto.js';
import { LoansService } from './loans.service.js';

@Controller('loans')
export class LoansController {
  constructor(private readonly loans: LoansService) {}

  /** Deuda total, cuentas por cobrar y vencimientos próximos. */
  @Get('summary')
  summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('entityId') entityId?: string,
    @Query('dueWithinDays') dueWithinDays?: string,
  ) {
    return this.loans.summary(user, entityId, dueWithinDays ? Number(dueWithinDays) : 30);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListLoansQuery) {
    return this.loans.list(user, query);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateLoanDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.loans.create(user, dto, meta);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.loans.get(user, id);
  }

  /** Cuadro de amortización proyectado (informativo). */
  @Get(':id/schedule')
  schedule(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.loans.schedule(user, id);
  }

  /** Registra un pago separando capital, intereses, comisiones y mora. */
  @Post(':id/payments')
  registerPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RegisterLoanPaymentDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.loans.registerPayment(user, id, dto, meta);
  }
}
