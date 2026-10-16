import { IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { IsBusinessDateString, IsMoneyString } from '../common/validators.js';

/**
 * ABONOS Y PAGOS DE OBLIGACIONES
 * ------------------------------
 * Un abono (cobro o pago) NUNCA se escribe directamente sobre la obligación:
 * se registra como movimiento financiero (que genera su asiento de partida
 * doble) y el saldo pendiente se recalcula desde los movimientos. Así el saldo
 * de la obligación no puede desincronizarse de la caja.
 */
export class SettleObligationDto {
  /** Identificador generado por el dispositivo: un reintento no duplica el cobro. */
  @IsOptional()
  @IsString()
  @Length(8, 120)
  clientOperationId?: string;

  /** Cuenta de donde entra el dinero (cobro) o de donde sale (pago). */
  @IsString()
  accountId!: string;

  /** Importe del abono. Puede ser parcial. */
  @IsMoneyString({ message: 'El importe del abono' })
  amount!: string;

  @IsOptional()
  @IsBusinessDateString({ message: 'La fecha del abono debe ser YYYY-MM-DD' })
  businessDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  method?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  reference?: string;

  @IsOptional()
  @IsString()
  attachmentId?: string | null;
}

export class PayRecurringDto {
  @IsOptional()
  @IsString()
  @Length(8, 120)
  clientOperationId?: string;

  /** Cuenta de la que sale (o entra) el dinero. */
  @IsString()
  accountId!: string;

  /** Si se omite, se usa el importe de la obligación (que es lo que se avisó). */
  @IsOptional()
  @IsMoneyString({ message: 'El importe pagado' })
  amount?: string;

  @IsOptional()
  @IsBusinessDateString({ message: 'La fecha de pago debe ser YYYY-MM-DD' })
  businessDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  method?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  attachmentId?: string | null;
}
