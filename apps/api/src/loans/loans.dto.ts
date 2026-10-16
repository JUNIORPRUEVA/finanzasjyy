import { IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { IsBusinessDateString, IsMoneyString } from '../common/validators.js';
import { PaginationQuery } from '../common/pagination.js';

const FREQUENCIES = ['ONE_TIME', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'] as const;
const INTEREST_TYPES = ['NONE', 'SIMPLE', 'COMPOUND', 'FIXED_INSTALLMENT'] as const;

export class CreateLoanDto {
  @IsString()
  entityId!: string;

  /** PAYABLE = FINANZA debe; RECEIVABLE = a FINANZA le deben. */
  @IsIn(['PAYABLE', 'RECEIVABLE'])
  direction!: 'PAYABLE' | 'RECEIVABLE';

  @IsOptional()
  @IsString()
  counterpartyId?: string;

  @IsString()
  @Length(2, 120)
  name!: string;

  @IsMoneyString({ message: 'El capital del préstamo' })
  principalAmount!: string;

  /** Tasa anual en porcentaje, como texto ("12.5" = 12,5%). */
  @IsOptional()
  @IsMoneyString({ allowZero: true, message: 'La tasa anual' })
  annualRatePct?: string;

  @IsOptional()
  @IsIn(INTEREST_TYPES as unknown as string[])
  interestType?: (typeof INTEREST_TYPES)[number];

  @IsOptional()
  @IsIn(FREQUENCIES as unknown as string[])
  paymentFrequency?: (typeof FREQUENCIES)[number];

  @IsOptional()
  @IsMoneyString({ message: 'El importe de la cuota' })
  installmentAmount?: string;

  @IsOptional()
  @Type(() => Number)
  installmentCount?: number;

  @IsBusinessDateString({ message: 'La fecha de inicio' })
  startDate!: string;

  @IsOptional()
  @IsBusinessDateString()
  firstDueDate?: string;

  /** Cuenta donde entra (crédito recibido) o de donde sale (préstamo otorgado). */
  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @IsString()
  @Length(8, 120)
  clientOperationId?: string;
}

export class RegisterLoanPaymentDto {
  @IsMoneyString({ message: 'El importe total del pago' })
  totalAmount!: string;

  @IsString()
  accountId!: string;

  @IsOptional()
  @IsBusinessDateString()
  businessDate?: string;

  /** Si se indica, se respeta tal cual; si no, se calcula el reparto. */
  @IsOptional()
  @IsMoneyString({ allowZero: true, message: 'El capital' })
  principalAmount?: string;

  @IsOptional()
  @IsMoneyString({ allowZero: true, message: 'Los intereses' })
  interestAmount?: string;

  @IsOptional()
  @IsMoneyString({ allowZero: true, message: 'Las comisiones' })
  feeAmount?: string;

  @IsOptional()
  @IsMoneyString({ allowZero: true, message: 'La mora' })
  penaltyAmount?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;

  @IsOptional()
  @IsString()
  @Length(8, 120)
  clientOperationId?: string;
}

export class ListLoansQuery extends PaginationQuery {
  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsIn(['PAYABLE', 'RECEIVABLE'])
  direction?: 'PAYABLE' | 'RECEIVABLE';

  @IsOptional()
  @IsIn(['ACTIVE', 'PAID_OFF', 'DEFAULTED', 'CANCELLED'])
  status?: 'ACTIVE' | 'PAID_OFF' | 'DEFAULTED' | 'CANCELLED';

  @IsOptional()
  @Matches(/^\d+$/, { message: 'dueWithinDays debe ser un número de días' })
  dueWithinDays?: string;
}
