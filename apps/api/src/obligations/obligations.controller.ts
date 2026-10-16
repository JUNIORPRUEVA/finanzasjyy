import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import {
  CreatePayableDto,
  CreateReceivableDto,
  CreateRecurringDto,
  ListObligationsQuery,
  UpdateObligationDto,
} from './obligations.dto.js';
import { PayRecurringDto, SettleObligationDto } from './obligations.payments.dto.js';
import { ObligationsService } from './obligations.service.js';

const FREQUENCIES = ['ONE_TIME', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'] as const;

class UpdateRecurringDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  amount?: string;

  @IsOptional()
  @IsIn(FREQUENCIES as unknown as string[])
  frequency?: (typeof FREQUENCIES)[number];

  @IsOptional()
  @IsString()
  nextDueDate?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'PAUSED', 'ENDED'])
  status?: 'ACTIVE' | 'PAUSED' | 'ENDED';

  @IsOptional()
  remindDaysBefore?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

@Controller('obligations')
export class ObligationsController {
  constructor(private readonly obligations: ObligationsService) {}

  /** Todo lo que vence pronto (recurrentes, por pagar, por cobrar y cuotas). */
  @Get('upcoming')
  upcoming(
    @CurrentUser() user: AuthenticatedUser,
    @Query('entityId') entityId?: string,
    @Query('days') days?: string,
  ) {
    return this.obligations.upcoming(user, entityId, days ? Number(days) : 15);
  }

  // ------------------------- Cuentas por cobrar -------------------------

  @Get('receivables')
  listReceivables(@CurrentUser() user: AuthenticatedUser, @Query() query: ListObligationsQuery) {
    return this.obligations.listReceivables(user, query);
  }

  @Post('receivables')
  createReceivable(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReceivableDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.obligations.createReceivable(user, dto, meta);
  }

  @Patch('receivables/:id')
  updateReceivable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateObligationDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.obligations.updateReceivable(user, id, dto, meta);
  }

  /** Cobra (total o parcialmente). Genera el movimiento y su asiento. */
  @Post('receivables/:id/payments')
  settleReceivable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SettleObligationDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.obligations.settleReceivable(user, id, dto, meta);
  }

  // ------------------------- Cuentas por pagar --------------------------

  @Get('payables')
  listPayables(@CurrentUser() user: AuthenticatedUser, @Query() query: ListObligationsQuery) {
    return this.obligations.listPayables(user, query);
  }

  @Post('payables')
  createPayable(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePayableDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.obligations.createPayable(user, dto, meta);
  }

  @Patch('payables/:id')
  updatePayable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateObligationDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.obligations.updatePayable(user, id, dto, meta);
  }

  /** Paga (total o parcialmente). Genera el movimiento y su asiento. */
  @Post('payables/:id/payments')
  settlePayable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SettleObligationDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.obligations.settlePayable(user, id, dto, meta);
  }

  // --------------------- Obligaciones recurrentes -----------------------

  @Get('recurring')
  listRecurring(@CurrentUser() user: AuthenticatedUser, @Query('entityId') entityId?: string) {
    return this.obligations.listRecurring(user, entityId);
  }

  @Post('recurring')
  createRecurring(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRecurringDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.obligations.createRecurring(user, dto, meta);
  }

  @Patch('recurring/:id')
  updateRecurring(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateRecurringDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.obligations.updateRecurring(user, id, dto, meta);
  }

  /**
   * Registra el pago/cobro REAL del período en curso y avanza el vencimiento.
   * Es la vía normal: deja el gasto o ingreso en el libro mayor.
   */
  @Post('recurring/:id/pay')
  payRecurring(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PayRecurringDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.obligations.payRecurring(user, id, dto, meta);
  }

  /** Marca la obligación como cumplida y pasa al siguiente período. */
  @Post('recurring/:id/roll-forward')
  rollForward(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.obligations.rollForward(user, id, meta);
  }
}
