import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class DeviceInfoDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  platform?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  appVersion?: string;
}

export class LoginDto extends DeviceInfoDto {
  @IsEmail({}, { message: 'El correo electrónico no es válido' })
  email!: string;

  @IsString()
  @Length(8, 200, { message: 'La contraseña debe tener entre 8 y 200 caracteres' })
  password!: string;
}

export class RegisterUserDto extends DeviceInfoDto {
  @IsEmail({}, { message: 'El correo electrónico no es válido' })
  email!: string;

  @IsString()
  @Length(8, 200, { message: 'La contraseña debe tener al menos 8 caracteres' })
  password!: string;

  @IsString()
  @Length(2, 120)
  name!: string;

  @IsOptional()
  @IsIn(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'])
  role?: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
}

/**
 * Edición de una persona con acceso (nombre, correo, rol y si puede entrar).
 * Todo es opcional: se manda sólo lo que cambia.
 */
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @IsOptional()
  @IsEmail({}, { message: 'El correo electrónico no es válido' })
  email?: string;

  @IsOptional()
  @IsIn(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'])
  role?: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Contraseña nueva para otra persona (por si la olvida). */
export class SetUserPasswordDto {
  @IsString()
  @Length(8, 200, { message: 'La contraseña debe tener al menos 8 caracteres' })
  password!: string;
}

export class RefreshTokenDto extends DeviceInfoDto {
  /**
   * Opcional a propósito: en el modo «cookie» el refresh token viaja en una
   * cookie HttpOnly y no en el cuerpo. Si no viene en el cuerpo, el controlador
   * lo lee de la cookie. Si no viene en ninguno de los dos, la respuesta es 401.
   */
  @IsOptional()
  @IsString()
  @Length(20, 300)
  refreshToken?: string;
}

export class ChangePasswordDto {
  @IsString()
  @Length(8, 200)
  currentPassword!: string;

  @IsString()
  @Length(10, 200, { message: 'La nueva contraseña debe tener al menos 10 caracteres' })
  newPassword!: string;

  @IsOptional()
  @IsBoolean()
  revokeOtherSessions?: boolean;
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @IsOptional()
  @IsEmail({}, { message: 'El correo electrónico no es válido' })
  email?: string;
}

export class UpdatePreferencesDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;

  @IsOptional()
  @IsIn(['light', 'dark', 'system'])
  theme?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  closingReminderHour?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(59)
  closingReminderMinute?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6, { message: 'Máximo 6 avisos escalonados' })
  @IsInt({ each: true })
  @Min(0, { each: true })
  reminderOffsetsMinutes?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'La ventana offline mínima es de 1 hora' })
  @Max(168, { message: 'La ventana offline máxima es de 168 horas (7 días)' })
  offlineWindowHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  budgetWarnPct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  budgetAlertPct?: number;

  @IsOptional()
  @IsString()
  cashDifferenceAlert?: string;

  @IsOptional()
  @IsBoolean()
  pushEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  dailyBriefEnabled?: boolean;
}

export class PushSubscriptionDto extends DeviceInfoDto {
  @IsString()
  @Length(20, 800)
  endpoint!: string;

  @IsString()
  @Length(10, 300)
  p256dh!: string;

  @IsString()
  @Length(4, 300)
  auth!: string;
}

export class UnsubscribePushDto {
  @IsString()
  @Length(20, 800)
  endpoint!: string;
}

export class RecurringReminderConfigDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => Object)
  intervals?: unknown[];
}
