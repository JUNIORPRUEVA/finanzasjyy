import { IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { IsBusinessDateString, IsMoneyString } from '../common/validators.js';
import { PaginationQuery } from '../common/pagination.js';

/**
 * «Pagué algo del negocio con mi dinero».
 *
 * El usuario sólo dice CUATRO cosas: qué negocio, cuánto, de qué cuenta personal
 * salió y qué compró. Las cuentas contables las decide el servidor.
 */
export class CreateReimbursementDto {
  /** Unidad de negocio que debe el dinero. */
  @IsString()
  companyEntityId!: string;

  /** Cuenta personal de la que salió el dinero. */
  @IsString()
  ownerAccountId!: string;

  /** Categoría del gasto (define la cuenta 6xxx). Opcional: hay una por defecto. */
  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsMoneyString({ message: 'El importe pagado' })
  amount!: string;

  @IsString()
  @Length(2, 300, { message: 'Describa qué pagó (mínimo 2 caracteres)' })
  description!: string;

  @IsOptional()
  @IsBusinessDateString({ message: 'La fecha debe ser YYYY-MM-DD' })
  businessDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  method?: string;

  @IsOptional()
  @IsString()
  @Length(8, 120)
  clientOperationId?: string;
}

/** Devolución del dinero adelantado. */
export class PayReimbursementDto {
  /** Cuenta de la empresa de la que sale el dinero. */
  @IsString()
  companyAccountId!: string;

  /** Si se omite, se devuelve todo lo que quede pendiente. */
  @IsOptional()
  @IsMoneyString({ message: 'El importe a devolver' })
  amount?: string;

  @IsOptional()
  @IsBusinessDateString({ message: 'La fecha debe ser YYYY-MM-DD' })
  businessDate?: string;

  @IsOptional()
  @IsString()
  @Length(8, 120)
  clientOperationId?: string;
}

export class VoidReimbursementDto {
  @IsString()
  @Length(5, 300, { message: 'El motivo de la anulación es obligatorio (mínimo 5 caracteres)' })
  reason!: string;
}

export class ListReimbursementsQuery extends PaginationQuery {
  @IsOptional()
  @IsString()
  companyEntityId?: string;

  @IsOptional()
  @IsString()
  status?: string;
}
