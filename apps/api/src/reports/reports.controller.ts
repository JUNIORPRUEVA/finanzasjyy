import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { ValidationError } from '../common/errors.js';
import { REPORT_TYPES, ReportsService, type ReportType } from './reports.service.js';

class ReportQuery {
  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}

function assertReportType(value: string): ReportType {
  if (!(REPORT_TYPES as readonly string[]).includes(value)) {
    throw new ValidationError(
      `Informe desconocido: "${value}". Informes disponibles: ${REPORT_TYPES.join(', ')}`,
    );
  }
  return value as ReportType;
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Lista de informes disponibles (para que la UI no los invente). */
  @Get('types')
  types() {
    return {
      types: REPORT_TYPES,
      note: 'Todos los informes incluyen su período y advierten si hay datos provisionales.',
    };
  }

  /** Tendencias mensuales y aviso de crecimiento peligroso del gasto. */
  @Get('trends')
  trends(
    @CurrentUser() user: AuthenticatedUser,
    @Query('entityId') entityId?: string,
    @Query('months') months?: string,
  ) {
    return this.reports.trends(user, entityId, months ? Number(months) : 6);
  }

  @Get(':type')
  generate(@CurrentUser() user: AuthenticatedUser, @Param('type') type: string, @Query() query: ReportQuery) {
    return this.reports.generate(user, assertReportType(type.toUpperCase()), {
      entityId: query.entityId,
      from: query.from,
      to: query.to,
    });
  }

  /** Exportación CSV (abre directamente en Excel / Google Sheets). */
  @Get(':type/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async csv(@CurrentUser() user: AuthenticatedUser, @Param('type') type: string, @Query() query: ReportQuery) {
    const result = await this.reports.exportCsv(user, assertReportType(type.toUpperCase()), {
      entityId: query.entityId,
      from: query.from,
      to: query.to,
    });
    return result.body;
  }
}
