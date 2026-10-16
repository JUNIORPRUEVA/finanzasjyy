import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import { CreateBudgetDto, ListBudgetsQuery, UpdateBudgetDto, UpsertAllocationDto } from './budgets.dto.js';
import { BudgetsService } from './budgets.service.js';

@Controller('budgets')
export class BudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  /** Alertas de presupuesto (incluye excesos reales, no estimaciones). */
  @Get('alerts')
  alerts(@CurrentUser() user: AuthenticatedUser, @Query('entityId') entityId?: string) {
    return this.budgets.alerts(user, entityId);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListBudgetsQuery) {
    return this.budgets.list(user, query);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBudgetDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.budgets.create(user, dto, meta);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.budgets.get(user, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateBudgetDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.budgets.update(user, id, dto, meta);
  }

  @Post(':id/allocations')
  upsertAllocation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpsertAllocationDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.budgets.upsertAllocation(user, id, dto, meta);
  }
}
