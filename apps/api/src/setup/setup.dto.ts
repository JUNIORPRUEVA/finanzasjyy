import { IsArray, IsBoolean, IsIn, IsOptional, IsString, Length, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { IsBusinessDateString, IsMoneyString } from '../common/validators.js';

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

const FREQUENCIES = ['ONE_TIME', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'] as const;
const INTEREST_TYPES = ['NONE', 'SIMPLE', 'COMPOUND', 'FIXED_INSTALLMENT'] as const;

/** Una cuenta con el dinero que tiene HOY (fecha de corte). */
export class SetupAccountDto {
  @IsString()
  entityId!: string;

  @IsString()
  @Length(2, 80)
  name!: string;

  @IsIn(ACCOUNT_TYPES as unknown as string[])
  type!: (typeof ACCOUNT_TYPES)[number];

  @IsMoneyString({ message: 'El saldo de la cuenta' })
  openingBalance!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  notes?: string;
}

export class SetupLoanDto {
  @IsString()
  entityId!: string;

  /** PAYABLE = lo debo; RECEIVABLE = me lo deben. */
  @IsIn(['PAYABLE', 'RECEIVABLE'])
  direction!: 'PAYABLE' | 'RECEIVABLE';

  @IsString()
  @Length(2, 120)
  name!: string;

  @IsMoneyString({ message: 'El capital pendiente' })
  principalAmount!: string;

  /** Tasa anual en porcentaje ("12.5" = 12,5 %). Se omite si no se conoce. */
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

  @IsOptional()
  @IsBusinessDateString()
  startDate?: string;

  @IsOptional()
  @IsBusinessDateString()
  nextDueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class SetupReceivableDto {
  @IsString()
  entityId!: string;

  @IsString()
  @Length(2, 300)
  description!: string;

  @IsMoneyString({ message: 'El importe que le deben' })
  originalAmount!: string;

  @IsOptional()
  @IsBusinessDateString()
  issueDate?: string;

  @IsOptional()
  @IsBusinessDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class SetupPayableDto {
  @IsString()
  entityId!: string;

  @IsString()
  @Length(2, 300)
  description!: string;

  @IsMoneyString({ message: 'El importe que debe' })
  originalAmount!: string;

  @IsOptional()
  @IsBusinessDateString()
  issueDate?: string;

  @IsOptional()
  @IsBusinessDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class SetupRecurringDto {
  @IsString()
  entityId!: string;

  @IsString()
  @Length(2, 120)
  name!: string;

  @IsOptional()
  @IsIn(['PAYABLE', 'RECEIVABLE'])
  direction?: 'PAYABLE' | 'RECEIVABLE';

  @IsMoneyString({ message: 'El importe del compromiso' })
  amount!: string;

  @IsIn(FREQUENCIES as unknown as string[])
  frequency!: (typeof FREQUENCIES)[number];

  @IsBusinessDateString({ message: 'El próximo vencimiento' })
  nextDueDate!: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @Type(() => Number)
  remindDaysBefore?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

/**
 * CONCILIACIÓN INICIAL — «Organizar mi dinero»
 *
 * Un único envío con toda la situación real del usuario. El servicio lo guarda
 * de forma atómica: o entra todo, o no entra nada.
 */
export class OrganizeMoneyDto {
  /** Confirmación explícita: el asistente no debe guardar por accidente. */
  @IsBoolean()
  confirm!: boolean;

  /** Fecha de corte de la situación declarada. Por defecto, hoy. */
  @IsOptional()
  @IsBusinessDateString({ message: 'La fecha de corte debe ser YYYY-MM-DD' })
  asOfDate?: string;

  @IsOptional()
  @IsString()
  @Length(8, 120)
  clientOperationId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SetupAccountDto)
  accounts?: SetupAccountDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SetupLoanDto)
  loans?: SetupLoanDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SetupReceivableDto)
  receivables?: SetupReceivableDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SetupPayableDto)
  payables?: SetupPayableDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SetupRecurringDto)
  recurrings?: SetupRecurringDto[];
}
