import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import {
  CreateReimbursementDto,
  ListReimbursementsQuery,
  PayReimbursementDto,
  VoidReimbursementDto,
} from './reimbursements.dto.js';
import { ReimbursementsService } from './reimbursements.service.js';

@Controller('reimbursements')
export class ReimbursementsController {
  constructor(private readonly reimbursements: ReimbursementsService) {}

  /** «Pagué algo del negocio con mi dinero». */
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReimbursementDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.reimbursements.create(user, dto, meta);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListReimbursementsQuery) {
    return this.reimbursements.list(user, query);
  }

  /** La empresa devuelve el dinero (total o parcial). */
  @Post(':id/pay')
  pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PayReimbursementDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.reimbursements.pay(user, id, dto, meta);
  }

  /** Anulación con asientos contrarios. Nunca se borra nada. */
  @Post(':id/void')
  void(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: VoidReimbursementDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.reimbursements.void(user, id, dto.reason, meta);
  }
}
