import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsBusinessDateString, IsMoneyString } from '../common/validators.js';
import { PaginationQuery } from '../common/pagination.js';

/**
 * COMPRAS PERSONALES — contratos de la API
 * ----------------------------------------
 * Una lista de compras NO es un documento financiero: prepararla no mueve dinero.
 * El gasto sólo se registra con `RegisterShoppingExpenseDto`, y por el mismo
 * camino que cualquier otro gasto de FINANZA (partida doble y auditoría).
 */

export const SHOPPING_STATUSES = ['DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED'] as const;
export type ShoppingStatus = (typeof SHOPPING_STATUSES)[number];

/** Cantidad admite hasta 3 decimales (1,5 kg de tomates). */
const QUANTITY_PATTERN = /^\d{1,12}(\.\d{1,3})?$/;

export class ShoppingItemDto {
  @IsString()
  @Length(1, 120, { message: 'El nombre del producto debe tener entre 1 y 120 caracteres' })
  name!: string;

  @IsOptional()
  @Matches(QUANTITY_PATTERN, { message: 'La cantidad debe ser un número (máximo 3 decimales)' })
  quantity?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  unit?: string | null;

  @IsOptional()
  @IsMoneyString({ message: 'El precio estimado' })
  estimatedUnitPrice?: string | null;

  @IsOptional()
  @IsMoneyString({ message: 'El precio real' })
  actualUnitPrice?: string | null;

  @IsOptional()
  @IsBoolean()
  isPurchased?: boolean;

  @IsOptional()
  @IsString()
  categoryId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class CreateShoppingListDto {
  /**
   * Identificador generado por el dispositivo. Permite crear la lista sin
   * conexión y enviarla después sin duplicarla.
   */
  @IsOptional()
  @IsString()
  @Length(8, 120)
  deviceListId?: string;

  @IsString()
  entityId!: string;

  @IsString()
  @Length(2, 80, { message: 'El nombre de la lista debe tener entre 2 y 80 caracteres' })
  name!: string;

  @IsOptional()
  @IsIn(SHOPPING_STATUSES as unknown as string[])
  status?: ShoppingStatus;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  notes?: string | null;

  @IsOptional()
  @IsBusinessDateString({ message: 'La fecha prevista debe ser YYYY-MM-DD' })
  plannedDate?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ShoppingItemDto)
  items?: ShoppingItemDto[];
}

export class UpdateShoppingListDto {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  name?: string;

  @IsOptional()
  @IsIn(SHOPPING_STATUSES as unknown as string[])
  status?: ShoppingStatus;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  notes?: string | null;

  @IsOptional()
  @IsBusinessDateString({ message: 'La fecha prevista debe ser YYYY-MM-DD' })
  plannedDate?: string | null;
}

export class UpdateShoppingItemDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @Matches(QUANTITY_PATTERN, { message: 'La cantidad debe ser un número (máximo 3 decimales)' })
  quantity?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  unit?: string | null;

  @IsOptional()
  @IsMoneyString({ message: 'El precio estimado' })
  estimatedUnitPrice?: string | null;

  @IsOptional()
  @IsMoneyString({ message: 'El precio real' })
  actualUnitPrice?: string | null;

  @IsOptional()
  @IsBoolean()
  isPurchased?: boolean;

  @IsOptional()
  @IsString()
  categoryId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

/**
 * Registro del gasto real de la lista.
 * Es el ÚNICO punto por el que una lista de compras puede mover dinero.
 */
export class RegisterShoppingExpenseDto {
  /** Cuenta de pago: de dónde sale el dinero. */
  @IsString()
  accountId!: string;

  @IsOptional()
  @IsString()
  categoryId?: string | null;

  /**
   * Importe realmente pagado. Si no se envía, se usa el total real calculado
   * (suma de precio real × cantidad de los productos marcados).
   */
  @IsOptional()
  @IsMoneyString({ message: 'El importe pagado' })
  amount?: string;

  @IsOptional()
  @IsBusinessDateString({ message: 'La fecha del gasto debe ser YYYY-MM-DD' })
  businessDate?: string;

  /**
   * Identificador idempotente. Si no se envía, se deriva de la propia lista
   * (`shop_<id>`), de modo que pulsar dos veces NUNCA duplica el gasto.
   */
  @IsOptional()
  @IsString()
  @Length(8, 120)
  clientOperationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  method?: string;
}

export class ShoppingListQuery extends PaginationQuery {
  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsIn(SHOPPING_STATUSES as unknown as string[])
  status?: ShoppingStatus;

  /** Búsqueda por nombre de lista o de producto. */
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  search?: string;

  @IsOptional()
  @IsUUID()
  createdByUserId?: string;
}
