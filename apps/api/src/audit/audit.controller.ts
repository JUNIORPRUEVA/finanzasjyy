import { Controller, Get, Query } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { Roles } from '../common/http.decorators.js';
import { PaginationQuery, paginate, toSkipTake } from '../common/pagination.js';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** Historial de auditoría: sólo para propietarios y administradores. */
  @Roles('OWNER', 'ADMIN')
  @Get()
  async list(@Query() query: PaginationQuery) {
    const { skip, take, page, limit } = toSkipTake(query);
    const { data, total } = await this.audit.list({ skip, take });
    return paginate(data, total, page, limit);
  }
}
