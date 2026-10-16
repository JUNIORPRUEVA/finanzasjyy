import { IsBoolean, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { IsBusinessDateString, IsMoneyString } from '../common/validators.js';
import { PaginationQuery } from '../common/pagination.js';

const FREQUENCIES = ['ONE_TIME', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'] as const;

export class CreateReceivableDto {
  @IsString()
  entityId!: string;

  @IsOptional()
  @IsString()
  counterpartyId?: string;

  @IsString()
  @Length(2, 300)
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  documentRef?: string;

  @IsMoneyString({ message: 'El importe original' })
  originalAmount!: string;

  @IsBusinessDateString({ message: 'La fecha de emisión' })
  issueDate!: string;

  @IsOptional()
  @IsBusinessDateString({ message: 'La fecha de vencimiento' })
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class CreatePayableDto {
  @IsString()
  entityId!: string;

  @IsOptional()
  @IsString()
  counterpartyId?: string;

  @IsString()
  @Length(2, 300)
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  documentRef?: string;

  @IsMoneyString({ message: 'El importe original' })
  originalAmount!: string;

  @IsBusinessDateString({ message: 'La fecha de emisión' })
  issueDate!: string;

  @IsOptional()
  @IsBusinessDateString({ message: 'La fecha de vencimiento' })
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class UpdateObligationDto {
  @IsOptional()
  @IsString()
  @Length(2, 300)
  description?: string;

  @IsOptional()
  @IsBusinessDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @IsIn(['PENDING', 'PARTIAL', 'SETTLED', 'OVERDUE', 'CANCELLED'])
  status?: 'PENDING' | 'PARTIAL' | 'SETTLED' | 'OVERDUE' | 'CANCELLED';
}

export class CreateRecurringDto {
  @IsString()
  entityId!: string;

  @IsString()
  @Length(2, 120)
  name!: string;

  @IsOptional()
  @IsIn(['PAYABLE', 'RECEIVABLE'])
  direction?: 'PAYABLE' | 'RECEIVABLE';

  @IsMoneyString({ message: 'El importe' })
  amount!: string;

  @IsIn(FREQUENCIES as unknown as string[])
  frequency!: (typeof FREQUENCIES)[number];

  @IsBusinessDateString({ message: 'El próximo vencimiento' })
  nextDueDate!: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  counterpartyId?: string;

  @IsOptional()
  @IsBoolean()
  autoCreate?: boolean;

  @IsOptional()
  @Type(() => Number)
  remindDaysBefore?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

export class ListObligationsQuery extends PaginationQuery {
  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  counterpartyId?: string;

  @IsOptional()
  @IsBusinessDateString()
  dueFrom?: string;

  @IsOptional()
  @IsBusinessDateString()
  dueTo?: string;

  @IsOptional()
  @IsString()
  search?: string;
}
