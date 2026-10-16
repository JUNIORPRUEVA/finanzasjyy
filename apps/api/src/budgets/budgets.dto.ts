import { ArrayMinSize, IsArray, IsIn, IsOptional, IsString, Length, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { IsBusinessDateString, IsMoneyString } from '../common/validators.js';
import { PaginationQuery } from '../common/pagination.js';

const PERIODS = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL', 'CUSTOM'] as const;

export class BudgetAllocationDto {
  @IsString()
  categoryId!: string;

  @IsMoneyString({ allowZero: true, message: 'El límite del presupuesto' })
  limitAmount!: string;

  @IsOptional()
  @Type(() => Number)
  warnPct?: number;

  @IsOptional()
  @Type(() => Number)
  alertPct?: number;
}

export class CreateBudgetDto {
  @IsString()
  entityId!: string;

  @IsString()
  @Length(2, 120)
  name!: string;

  @IsIn(PERIODS as unknown as string[])
  period!: (typeof PERIODS)[number];

  @IsBusinessDateString({ message: 'La fecha de inicio del presupuesto' })
  startDate!: string;

  @IsOptional()
  @IsBusinessDateString({ message: 'La fecha de fin del presupuesto' })
  endDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'El presupuesto necesita al menos una categoría con límite' })
  @ValidateNested({ each: true })
  @Type(() => BudgetAllocationDto)
  allocations!: BudgetAllocationDto[];
}

export class UpdateBudgetDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @IsOptional()
  @IsBusinessDateString()
  endDate?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'CLOSED'])
  status?: 'ACTIVE' | 'CLOSED';

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

export class UpsertAllocationDto {
  @IsString()
  categoryId!: string;

  @IsMoneyString({ allowZero: true, message: 'El límite' })
  limitAmount!: string;

  @IsOptional()
  @Type(() => Number)
  warnPct?: number;

  @IsOptional()
  @Type(() => Number)
  alertPct?: number;
}

export class ListBudgetsQuery extends PaginationQuery {
  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'CLOSED'])
  status?: 'ACTIVE' | 'CLOSED';
}
