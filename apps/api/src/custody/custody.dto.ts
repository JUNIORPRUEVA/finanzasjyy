import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';

/**
 * DTOs de la custodia (dinero de una empresa en una cuenta de otra unidad).
 * Los importes viajan como texto decimal, igual que en el resto de FINANZA, para
 * no perder precisión con números en coma flotante.
 */

export class CollectIntoCustodyDto {
  /** Unidad dueña del dinero (FULLTECH, APPYRA…). */
  @IsString()
  beneficiaryEntityId!: string;

  /** Cuenta real que recibe el dinero (personal del propietario). */
  @IsString()
  holdingAccountId!: string;

  /** INCOME = venta nueva; RECEIVABLE_SETTLEMENT = cobro de una factura ya contabilizada. */
  @IsIn(['INCOME', 'RECEIVABLE_SETTLEMENT'])
  kind!: 'INCOME' | 'RECEIVABLE_SETTLEMENT';

  @IsString()
  amount!: string;

  @IsOptional()
  @IsString()
  businessDate?: string;

  @IsString()
  @Length(3, 200, { message: 'Escriba un concepto de al menos 3 caracteres' })
  description!: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  /** Obligatorio cuando `kind = RECEIVABLE_SETTLEMENT`. */
  @IsOptional()
  @IsString()
  receivableId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  method?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  clientOperationId?: string;
}

export class SettleCustodyDto {
  @IsString()
  beneficiaryEntityId!: string;

  @IsString()
  holdingAccountId!: string;

  /** Cuenta de la empresa (banco o caja) que recibe el dinero. */
  @IsString()
  targetAccountId!: string;

  @IsString()
  amount!: string;

  @IsOptional()
  @IsString()
  businessDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  clientOperationId?: string;
}

export class PayExpenseFromCustodyDto {
  @IsString()
  beneficiaryEntityId!: string;

  @IsString()
  holdingAccountId!: string;

  @IsString()
  categoryId!: string;

  @IsString()
  amount!: string;

  @IsOptional()
  @IsString()
  businessDate?: string;

  @IsString()
  @Length(3, 200, { message: 'Escriba un concepto de al menos 3 caracteres' })
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  method?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  clientOperationId?: string;
}

export class VoidCustodyMovementDto {
  @IsString()
  @Length(5, 300, { message: 'Explique el motivo (mínimo 5 caracteres): queda en la auditoría' })
  reason!: string;
}

export class ListPendingCustodyQuery {
  @IsOptional()
  @IsString()
  beneficiaryEntityId?: string;

  @IsOptional()
  @IsString()
  holdingAccountId?: string;
}
