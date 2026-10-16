import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { IsBusinessDateString, IsMoneyString } from '../common/validators.js';
import { PaginationQuery } from '../common/pagination.js';

/**
 * Kinds que se pueden registrar por el endpoint de movimientos.
 * TRANSFER_* y LOAN_PAYMENT se excluyen a propósito: tienen su propio servicio
 * porque exigen una operación atómica doble (dos asientos / reparto de capital
 * e intereses) que no se puede improvisar desde el cliente.
 */
export const CREATABLE_KINDS = [
  'INCOME',
  'EXPENSE',
  'OWNER_WITHDRAWAL',
  'OWNER_CONTRIBUTION',
  'LOAN_DISBURSEMENT',
  'CREDIT_CARD_PAYMENT',
  'RECEIVABLE_SETTLEMENT',
  'PAYABLE_SETTLEMENT',
  'ADJUSTMENT',
] as const;

export type CreatableKind = (typeof CREATABLE_KINDS)[number];

export class CreateTransactionDto {
  /**
   * Identificador generado por el dispositivo. Garantiza idempotencia: si el
   * móvil reintenta el envío sin conexión, el movimiento NO se duplica.
   */
  @IsOptional()
  @IsString()
  @Length(8, 120)
  clientOperationId?: string;

  @IsString()
  entityId!: string;

  @IsIn(CREATABLE_KINDS as unknown as string[])
  kind!: CreatableKind;

  /** Cuenta de donde sale o entra el dinero. */
  @IsString()
  accountId!: string;

  @IsOptional()
  @IsString()
  categoryId?: string | null;

  @IsOptional()
  @IsString()
  counterpartyId?: string | null;

  @IsMoneyString({ message: 'El importe' })
  amount!: string;

  @IsOptional()
  @IsBusinessDateString({ message: 'La fecha del movimiento debe ser YYYY-MM-DD' })
  businessDate?: string;

  @IsString()
  @Length(2, 300, { message: 'La descripción es obligatoria (mínimo 2 caracteres)' })
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  method?: string;

  @IsOptional()
  @IsString()
  attachmentId?: string | null;

  /** Obligatorio para RECEIVABLE_SETTLEMENT. */
  @IsOptional()
  @IsString()
  receivableId?: string;

  /** Obligatorio para PAYABLE_SETTLEMENT. */
  @IsOptional()
  @IsString()
  payableId?: string;

  /** Obligatorio para LOAN_DISBURSEMENT. */
  @IsOptional()
  @IsString()
  loanId?: string;

  /** Ajustes manuales: cuenta que se carga (debe). */
  @IsOptional()
  @Matches(/^\d{4}$/, { message: 'adjustmentDebitCode debe ser una cuenta de 4 dígitos' })
  adjustmentDebitCode?: string;

  /** Ajustes manuales: cuenta que se abona (haber). */
  @IsOptional()
  @Matches(/^\d{4}$/, { message: 'adjustmentCreditCode debe ser una cuenta de 4 dígitos' })
  adjustmentCreditCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  adjustmentReason?: string;

  /** El cliente informa de que se registró sin conexión. */
  @IsOptional()
  @IsBoolean()
  recordedOffline?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceId?: string;
}

export class VoidTransactionDto {
  @IsString()
  @Length(5, 300, { message: 'El motivo de anulación es obligatorio (mínimo 5 caracteres)' })
  reason!: string;
}

export class ListTransactionsQuery extends PaginationQuery {
  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsString()
  kinds?: string;

  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  counterpartyId?: string;

  @IsOptional()
  @IsBusinessDateString()
  from?: string;

  @IsOptional()
  @IsBusinessDateString()
  to?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsString()
  minAmount?: string;

  @IsOptional()
  @IsString()
  maxAmount?: string;
}
