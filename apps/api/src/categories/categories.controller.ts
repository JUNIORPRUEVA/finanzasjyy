import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { CurrentUser, type AuthenticatedUser } from '../common/http.decorators.js';
import { RequestMeta, type RequestMetaInfo } from '../common/request-meta.js';
import { CategoriesService } from './categories.service.js';

class ListCategoriesQuery {
  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsIn(['INCOME', 'EXPENSE'])
  kind?: 'INCOME' | 'EXPENSE';

  @IsOptional()
  @IsString()
  includeInactive?: string;
}

class CreateCategoryDto {
  @IsOptional()
  @IsString()
  entityId?: string | null;

  @IsString()
  @Length(2, 80)
  name!: string;

  @IsIn(['INCOME', 'EXPENSE'])
  kind!: 'INCOME' | 'EXPENSE';

  @IsOptional()
  @IsString()
  @Length(4, 4, { message: 'La cuenta contable se indica con 4 dígitos (p. ej. 6350)' })
  defaultLedgerCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;

  @IsOptional()
  @IsString()
  parentId?: string;
}

class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(4, 4)
  defaultLedgerCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListCategoriesQuery) {
    return this.categories.list(user, {
      entityId: query.entityId,
      kind: query.kind,
      includeInactive: query.includeInactive === 'true',
    });
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCategoryDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.categories.create(user, dto, meta);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.categories.update(user, id, dto, meta);
  }

  @Delete(':id')
  deactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @RequestMeta() meta: RequestMetaInfo,
  ) {
    return this.categories.deactivate(user, id, meta);
  }
}
