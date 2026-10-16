import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class SubscribePushDto {
  @IsString()
  @Length(20, 800)
  endpoint!: string;

  @IsString()
  @Length(10, 300)
  p256dh!: string;

  @IsString()
  @Length(4, 300)
  auth!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  platform?: string;
}

export class UnsubscribePushDto {
  @IsString()
  @Length(20, 800)
  endpoint!: string;
}

export class ListNotificationsQuery {
  @IsOptional()
  @IsString()
  unreadOnly?: string;

  @IsOptional()
  @IsIn(['INFO', 'WARNING', 'CRITICAL'])
  severity?: 'INFO' | 'WARNING' | 'CRITICAL';

  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsString()
  limit?: string;
}
