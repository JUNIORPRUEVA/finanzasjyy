import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const REPEATS = ['ONCE', 'DAILY', 'MONTHLY'] as const;
export type ReminderRepeatDto = (typeof REPEATS)[number];

/** Un punto de la lista enumerada. */
export class ReminderItemDto {
  @IsString()
  @Length(1, 200)
  text!: string;
}

export class CreateReminderDto {
  @IsString()
  @Length(2, 120)
  title!: string;

  @IsOptional()
  @IsBoolean()
  isList?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReminderItemDto)
  items?: ReminderItemDto[];

  @IsOptional()
  @IsBoolean()
  alertEnabled?: boolean;

  /** Fecha y hora del primer aviso, en ISO 8601 (la app envía la hora local convertida). */
  @IsOptional()
  @IsISO8601()
  alertAt?: string;

  @IsOptional()
  @IsIn(REPEATS as unknown as string[])
  repeat?: ReminderRepeatDto;

  @IsOptional()
  @IsString()
  entityId?: string;
}

export class UpdateReminderDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  title?: string;

  @IsOptional()
  @IsBoolean()
  isList?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReminderItemDto)
  items?: ReminderItemDto[];

  @IsOptional()
  @IsBoolean()
  alertEnabled?: boolean;

  @IsOptional()
  @IsISO8601()
  alertAt?: string;

  @IsOptional()
  @IsIn(REPEATS as unknown as string[])
  repeat?: ReminderRepeatDto;

  @IsOptional()
  @IsString()
  entityId?: string;
}

/**
 * Para borrar hace falta la contraseña de QUIEN CREÓ el recordatorio. Es la
 * condición que pidió el usuario: el aviso no desaparece por descuido ni por
 * tocar el botón equivocado.
 */
export class DeleteReminderDto {
  @IsString()
  @Length(1, 200)
  password!: string;
}
