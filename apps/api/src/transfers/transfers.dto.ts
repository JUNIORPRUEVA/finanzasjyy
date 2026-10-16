import { IsBoolean, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { IsBusinessDateString, IsMoneyString } from '../common/validators.js';
import { PaginationQuery } from '../common/pagination.js';

export class CreateTransferDto {
  @IsOptional()
  @IsString()
  @Length(8, 120)
  clientOperationId?: string;

  @IsString()
  fromAccountId!: string;

  @IsString()
  toAccountId!: string;

  @IsMoneyString({ message: 'El importe de la transferencia' })
  amount!: string;

  @IsOptional()
  @IsBusinessDateString({ message: 'La fecha de la transferencia debe ser YYYY-MM-DD' })
  businessDate?: string;

  @IsString()
  @Length(2, 300)
  description!: string;

  @IsOptional()
  @IsBoolean()
  recordedOffline?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceId?: string;
}

export class ListTransfersQuery extends PaginationQuery {
  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsBusinessDateString()
  from?: string;

  @IsOptional()
  @IsBusinessDateString()
  to?: string;
}
