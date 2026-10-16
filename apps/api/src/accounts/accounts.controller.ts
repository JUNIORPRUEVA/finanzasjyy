import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import { AccountsService } from './accounts.service.js';

const ACCOUNT_TYPES = [
  'CASH',
  'BUSINESS_CASH',
  'BANK',
  'SAVINGS',
  'CHECKING',
  'DIGITAL_WALLET',
  'MERCHANT',
  'CREDIT_CARD',
  'OTHER',
] as const;

class CreateAccountDto {
  @IsString()
  entityId!: string;

  @IsString()
  @Length(2, 80, { message: 'El nombre de la cuenta debe tener entre 2 y 80 caracteres' })
  name!: string;

  @IsIn(ACCOUNT_TYPES as unknown as string[])
  type!: (typeof ACCOUNT_TYPES)[number];

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  /** Saldo inicial documentado (el que figura en el banco o en la caja). */
  @IsOptional()
  @IsString()
  openingBalance?: string;

  @IsOptional()
  @IsString()
  openingDate?: string;

  @IsOptional()
  @IsBoolean()
  isCreditCard?: boolean;

  @IsOptional()
  @IsString()
  creditLimit?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  statementDay?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  paymentDueDay?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

class UpdateAccountDto {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  name?: string;

  @IsOptional()
  @IsIn(ACCOUNT_TYPES as unknown as string[])
  type?: (typeof ACCOUNT_TYPES)[number];

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE', 'CLOSED'])
  status?: 'ACTIVE' | 'INACTIVE' | 'CLOSED';

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;

  @IsOptional()
  @IsString()
  creditLimit?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  statementDay?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  paymentDueDay?: number | null;

  @IsOptional()
  @IsString()
  openingBalance?: string;

  @IsOptional()
  @IsString()
  openingDate?: string;
}

class ListAccountsQuery {
  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsString()
  includeClosed?: string;

  @IsOptional()
  @IsString()
  includeBalances?: string;
}

@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListAccountsQuery) {
    return this.accounts.list(user, {
      entityId: query.entityId,
      includeClosed: query.includeClosed === 'true',
      includeBalances: query.includeBalances !== 'false',
    });
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAccountDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.accounts.create(user, dto, meta);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.accounts.get(user, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateAccountDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.accounts.update(user, id, dto, meta);
  }

  @Delete(':id')
  close(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.accounts.close(user, id, meta);
  }
}
