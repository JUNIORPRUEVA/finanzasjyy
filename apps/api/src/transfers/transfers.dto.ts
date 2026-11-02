import { IsBoolean, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { IsBusinessDateString, IsMoneyString } from '../common/validators.js';
import { PaginationQuery } from '../common/pagination.js';

/**
 * NATURALEZA DEL DINERO CUANDO SALE DE UNA EMPRESA HACIA EL PROPIETARIO
 * --------------------------------------------------------------------
 * Un movimiento entre dos personas jurídicas distintas no se puede contabilizar
 * sin saber qué es. Estas dos son las que la aplicación puede registrar sin
 * inventar nada:
 *
 *  · `WITHDRAWAL` — es dinero suyo que se lleva (retiro del propietario).
 *  · `LOAN`       — la empresa se lo presta y lo devolverá.
 *
 * La tercera naturaleza real (reembolso de un gasto que él adelantó) tiene su
 * propio módulo, porque necesita el gasto y la factura.
 */
export const OWNER_FUNDS_NATURES = ['WITHDRAWAL', 'LOAN'] as const;
export type OwnerFundsNatureName = (typeof OWNER_FUNDS_NATURES)[number];

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

  /**
   * Sólo para «dinero para mí»: sacar dinero de una empresa hacia una cuenta
   * personal. Sin este campo, cruzar entre personas jurídicas sigue bloqueado.
   */
  @IsOptional()
  @IsIn(OWNER_FUNDS_NATURES as unknown as string[])
  nature?: OwnerFundsNatureName;

  /** Referencia del justificante (acta, contrato de préstamo…). Opcional. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  documentRef?: string;

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
