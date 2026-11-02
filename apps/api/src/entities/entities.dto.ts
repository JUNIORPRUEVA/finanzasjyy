import { IsBoolean, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export const ENTITY_TYPES = ['BUSINESS', 'PERSONAL', 'RENTAL', 'SERVICE', 'INVESTMENT', 'OTHER'] as const;
export type EntityTypeName = (typeof ENTITY_TYPES)[number];

export class CreateEntityDto {
  @IsString()
  @Length(2, 60, { message: 'El nombre de la unidad financiera debe tener entre 2 y 60 caracteres' })
  name!: string;

  @IsOptional()
  @IsString()
  @Length(2, 40)
  code?: string;

  @IsOptional()
  @IsIn(ENTITY_TYPES as unknown as string[])
  type?: EntityTypeName;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;
}

export class UpdateEntityDto {
  @IsOptional()
  @IsString()
  @Length(2, 60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsIn(ENTITY_TYPES as unknown as string[])
  type?: EntityTypeName;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;
}

export class EntityMemberDto {
  @IsString()
  userId!: string;

  @IsOptional()
  @IsIn(['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'])
  role?: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
}

/** Persona jurídica: la sociedad o la persona física propietaria. */
export const LEGAL_ENTITY_KINDS = ['COMPANY', 'INDIVIDUAL'] as const;
export type LegalEntityKindName = (typeof LEGAL_ENTITY_KINDS)[number];

export class CreateLegalEntityDto {
  @IsString()
  @Length(2, 80, { message: 'El nombre de la persona jurídica debe tener entre 2 y 80 caracteres' })
  name!: string;

  @IsOptional()
  @IsString()
  @Length(2, 40)
  code?: string;

  @IsOptional()
  @IsIn(LEGAL_ENTITY_KINDS as unknown as string[])
  kind?: LegalEntityKindName;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  taxId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

/**
 * Estructura de una unidad: a qué persona jurídica pertenece y de qué unidad
 * depende.
 *
 * `null` explícito significa «quitar la relación» (volver a dejarla sin
 * confirmar). Omitir el campo significa «no tocarla»: son dos cosas distintas y
 * por eso se usan `?? undefined` en el servicio, no `|| undefined`.
 */
export class EntityStructureDto {
  @IsOptional()
  @IsString()
  legalEntityId?: string | null;

  @IsOptional()
  @IsString()
  parentEntityId?: string | null;
}
