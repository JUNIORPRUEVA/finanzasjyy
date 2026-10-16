import { Controller, Get, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { DashboardService } from './dashboard.service.js';
import type { RangePreset } from '../domain/business-date.js';

const PRESETS = ['TODAY', 'YESTERDAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR', 'LAST_30_DAYS'] as const;

class DashboardQuery {
  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsIn(PRESETS as unknown as string[])
  preset?: RangePreset;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsString()
  days?: string;
}

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** Indicadores principales. Marca claramente lo provisional vs lo conciliado. */
  @Get('summary')
  summary(@CurrentUser() user: AuthenticatedUser, @Query() query: DashboardQuery) {
    return this.dashboard.summary(user, {
      entityId: query.entityId,
      preset: query.preset,
      from: query.from,
      to: query.to,
    });
  }

  /** Series para las gráficas del panel. */
  @Get('charts')
  charts(@CurrentUser() user: AuthenticatedUser, @Query() query: DashboardQuery) {
    return this.dashboard.charts(user, {
      entityId: query.entityId,
      days: query.days ? Number(query.days) : undefined,
    });
  }
}
