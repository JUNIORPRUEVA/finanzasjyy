import { IsString } from 'class-validator';

/**
 * Vista previa de la relación jurídica entre las dos cuentas de un traspaso.
 *
 * Existe para que la pantalla pueda avisar ANTES de registrar: no es lo mismo
 * mover dinero dentro de la misma sociedad que entre la sociedad y el
 * propietario, y el usuario tiene que saberlo antes, no después del error.
 */
export class PreviewTransferRelationDto {
  @IsString()
  fromAccountId!: string;

  @IsString()
  toAccountId!: string;
}
