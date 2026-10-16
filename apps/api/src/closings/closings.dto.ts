import { ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString, Length, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { IsBusinessDateString, IsMoneyString } from '../common/validators.js';

export class AccountCountDto {
  @IsString()
  accountId!: string;

  @IsMoneyString({ allowZero: true, message: 'El efectivo contado' })
  countedAmount!: string;

  /** Obligatorio cuando hay diferencia: sin explicación no se puede finalizar. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  explanation?: string;
}

export class SaveClosingDto {
  @IsString()
  entityId!: string;

  @IsOptional()
  @IsBusinessDateString({ message: 'La fecha de negocio del cierre' })
  businessDate?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Debe contar al menos una cuenta' })
  @ValidateNested({ each: true })
  @Type(() => AccountCountDto)
  counts!: AccountCountDto[];

  /** Pasos que el usuario confirma haber revisado. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  confirmedSteps?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  /** Idempotencia: un reintento desde offline no duplica el cierre. */
  @IsOptional()
  @IsString()
  @Length(8, 120)
  clientOperationId?: string;

  @IsOptional()
  @IsBoolean()
  recordedOffline?: boolean;
}

export class FinalizeClosingDto {
  @IsString()
  entityId!: string;

  @IsOptional()
  @IsBusinessDateString()
  businessDate?: string;

  /**
   * Si hay diferencias explicadas, ¿se genera el asiento de ajuste contable?
   * Por defecto sí: la caja cuadra con la realidad y queda el rastro (8010/4920).
   */
  @IsOptional()
  @IsBoolean()
  adjustDifferences?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  confirmedSteps?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class ReopenClosingDto {
  @IsString()
  entityId!: string;

  @IsOptional()
  @IsBusinessDateString()
  businessDate?: string;

  @IsString()
  @Length(10, 500, {
    message: 'La reapertura de un cierre exige un motivo detallado (mínimo 10 caracteres)',
  })
  reason!: string;
}
