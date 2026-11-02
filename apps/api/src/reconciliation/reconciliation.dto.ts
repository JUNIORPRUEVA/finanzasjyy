import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { IsBusinessDateString } from '../common/validators.js';
import { PaginationQuery } from '../common/pagination.js';

/**
 * Saldo que figura en el banco.
 *
 * Admite negativos a propósito: una cuenta corriente puede estar en descubierto
 * y una tarjeta tiene saldo deudor. Rechazar el signo obligaría a mentir.
 */
const SALDO_INFORMADO = /^-?\d{1,15}([.,]\d{1,2})?$/;

/** Las seis causas posibles. Sólo la última permite generar un asiento. */
export const RECONCILIATION_CAUSES = [
  'UNRECORDED_MOVEMENT',
  'PENDING_TRANSFER',
  'OPENING_BALANCE_ERROR',
  'DUPLICATE_MOVEMENT',
  'UNIDENTIFIED',
  'AUTHORIZED_CASH_DIFFERENCE',
] as const;

export type ReconciliationCauseName = (typeof RECONCILIATION_CAUSES)[number];

export class PreviewReconciliationDto {
  @IsString()
  @Matches(SALDO_INFORMADO, { message: 'El saldo informado debe ser un número (admite decimales y negativos)' })
  informedBalance!: string;

  @IsOptional()
  @IsBusinessDateString({ message: 'La fecha debe ser YYYY-MM-DD' })
  asOf?: string;
}

/**
 * Confirmar la conciliación.
 *
 * `cause` explica POR QUÉ hay diferencia. Sin causa no se ajusta nada, y sólo
 * `AUTHORIZED_CASH_DIFFERENCE` —marcada además con `authorized: true`— puede
 * generar el asiento. El resto de causas llevan a corregir la causa real
 * (apuntar el movimiento, anular el duplicado…), no a inventar un ajuste.
 */
export class ConfirmReconciliationDto extends PreviewReconciliationDto {
  @IsOptional()
  @IsIn(RECONCILIATION_CAUSES as unknown as string[])
  cause?: ReconciliationCauseName;

  /** «Autorizo el ajuste»: una segunda llave, explícita. */
  @IsOptional()
  @IsBoolean()
  authorized?: boolean;

  /**
   * Obligatorio SÓLO si hay algo que ajustar (lo valida el servicio).
   *
   * Si la cuenta cuadra no se va a tocar ningún saldo, así que obligar a
   * explicar una diferencia que no existe sería pedir trabajo por nada.
   */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** Guardar la revisión SIN tocar saldos (cualquier causa, incluida «no sé»). */
export class DismissReconciliationDto extends PreviewReconciliationDto {
  @IsOptional()
  @IsIn(RECONCILIATION_CAUSES as unknown as string[])
  cause?: ReconciliationCauseName;

  /** Qué se comprobó y qué se espera. */
  @IsString()
  @Length(5, 300, { message: 'Explique qué ha visto (mínimo 5 caracteres)' })
  notes!: string;
}

export class ListReconciliationQuery extends PaginationQuery {
  @IsOptional()
  @IsString()
  status?: string;
}
