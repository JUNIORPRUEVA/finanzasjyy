import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsISO8601, IsOptional, IsString, Length } from 'class-validator';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import { PaginationQuery, paginate, toSkipTake } from '../common/pagination.js';
import { parseBusinessDateIso } from '../domain/business-date.js';
import { LedgerService } from './ledger.service.js';

class LedgerQuery {
  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

class EntriesQuery extends PaginationQuery {
  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsString()
  sourceType?: string;

  @IsOptional()
  @IsString()
  accountId?: string;
}

class ReverseEntryDto {
  @IsString()
  @Length(5, 500, { message: 'El motivo del reverso es obligatorio (mínimo 5 caracteres)' })
  reason!: string;
}

@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  /** Catálogo contable (plan de cuentas) de FINANZA. */
  @Get('accounts')
  accounts() {
    return this.ledger.listLedgerAccounts();
  }

  /** Saldos calculados de las cuentas financieras. */
  @Get('balances')
  balances(@CurrentUser() user: AuthenticatedUser, @Query() query: LedgerQuery) {
    return this.ledger.accountBalances(
      user,
      query.entityId,
      query.to ? parseBusinessDateIso(query.to.slice(0, 10)) : undefined,
    );
  }

  /** Balance de comprobación por unidad financiera o consolidado. */
  @Get('trial-balance')
  trialBalance(@CurrentUser() user: AuthenticatedUser, @Query() query: LedgerQuery) {
    return this.ledger.trialBalance(user, {
      entityId: query.entityId,
      from: query.from ? parseBusinessDateIso(query.from.slice(0, 10)) : undefined,
      to: query.to ? parseBusinessDateIso(query.to.slice(0, 10)) : undefined,
    });
  }

  /** Libro diario: todos los asientos, con sus líneas y su origen. */
  @Get('entries')
  async entries(@CurrentUser() user: AuthenticatedUser, @Query() query: EntriesQuery) {
    const { skip, take, page, limit } = toSkipTake(query);
    const { data, total } = await this.ledger.listEntries(user, {
      entityId: query.entityId,
      from: query.from ? parseBusinessDateIso(query.from.slice(0, 10)) : undefined,
      to: query.to ? parseBusinessDateIso(query.to.slice(0, 10)) : undefined,
      sourceType: query.sourceType,
      accountId: query.accountId,
      skip,
      take,
    });
    return paginate(data, total, page, limit);
  }

  @Get('entries/:id')
  entry(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.ledger.getEntry(user, id);
  }

  /** Corrige un asiento por reverso (nunca por edición ni borrado). */
  @Post('entries/:id/reverse')
  reverse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReverseEntryDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.ledger.reverseEntryManually(user, id, dto.reason, meta);
  }

  /** Autocomprobación: ¿cuadra el libro? ¿La cuenta puente está en cero? */
  @Get('integrity')
  integrity(@CurrentUser() user: AuthenticatedUser, @Query() query: LedgerQuery) {
    return this.ledger.integrity(user, query.entityId);
  }
}
