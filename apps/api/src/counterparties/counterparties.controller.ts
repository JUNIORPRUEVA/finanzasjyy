import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsEmail, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import { CounterpartiesService } from './counterparties.service.js';

const TYPES = ['CUSTOMER', 'SUPPLIER', 'LENDER', 'BORROWER', 'EMPLOYEE', 'OWNER', 'OTHER'] as const;

class ListCounterpartiesQuery {
  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsIn(TYPES as unknown as string[])
  type?: (typeof TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  @IsOptional()
  @IsString()
  includeInactive?: string;
}

class CreateCounterpartyDto {
  @IsOptional()
  @IsString()
  entityId?: string | null;

  @IsIn(TYPES as unknown as string[])
  type!: (typeof TYPES)[number];

  @IsString()
  @Length(2, 120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  taxId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

class UpdateCounterpartyDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @IsOptional()
  @IsIn(TYPES as unknown as string[])
  type?: (typeof TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(40)
  taxId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;

  @IsOptional()
  isActive?: boolean;
}

@Controller('counterparties')
export class CounterpartiesController {
  constructor(private readonly counterparties: CounterpartiesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListCounterpartiesQuery) {
    return this.counterparties.list(user, {
      entityId: query.entityId,
      type: query.type,
      search: query.search,
      includeInactive: query.includeInactive === 'true',
    });
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCounterpartyDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.counterparties.create(user, dto, meta);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCounterpartyDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.counterparties.update(user, id, dto, meta);
  }

  @Delete(':id')
  deactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.counterparties.deactivate(user, id, meta);
  }
}
