import { Controller, Get, Query } from '@nestjs/common';
import { IsDateString, IsOptional } from 'class-validator';
import { AuditService } from './audit.service.js';
import { Roles } from '../common/http.decorators.js';
import { PaginationQuery, paginate, toSkipTake } from '../common/pagination.js';
import { businessRange } from '../domain/business-date.js';

/**
 * Filtros de la auditoría.
 *
 * El servicio ya sabía filtrar por rango de fechas, pero la ruta no lo exponía:
 * la pantalla sólo podía paginar. Con esto se puede preguntar «qué pasó entre el
 * 1 y el 15», que es lo primero que uno quiere hacer cuando revisa.
 *
 * Las fechas llegan como día del negocio (`AAAA-MM-DD`), no como instante: así
 * «hasta el 15» incluye TODO el día 15, y no se queda a las 00:00 del 15.
 */
class AuditQuery extends PaginationQuery {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** Historial de auditoría: sólo para propietarios y administradores. */
  @Roles('OWNER', 'ADMIN')
  @Get()
  async list(@Query() query: AuditQuery) {
    const { skip, take, page, limit } = toSkipTake(query);

    const from = query.from ? businessRange(query.from, query.from).from : undefined;
    // «Hasta» se pasa como el último milisegundo de ese día del negocio.
    const to = query.to
      ? new Date(businessRange(query.to, query.to).from.getTime() + 86_400_000 - 1)
      : undefined;

    const { data, total } = await this.audit.list({ skip, take, from, to });
    return paginate(data, total, page, limit);
  }
}
