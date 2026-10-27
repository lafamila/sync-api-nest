import { IsBase64, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';

export class DeviceChallengeDto {
  @IsOptional()
  @IsUUID()
  deviceId?: string;
}

export class DeviceProofDto {
  @IsUUID()
  deviceId!: string;

  @IsString()
  @MinLength(24)
  @MaxLength(128)
  challengeId!: string;

  @IsBase64()
  @MaxLength(256)
  signature!: string;
}

export class RegisterDeviceDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsIn(['macos', 'ios'])
  platform!: 'macos' | 'ios';

  @IsBase64()
  @MaxLength(1024)
  publicKey!: string;

  @IsString()
  @MinLength(24)
  @MaxLength(128)
  challengeId!: string;

  @IsBase64()
  @MaxLength(256)
  signature!: string;
}

export class SetModeDto extends DeviceProofDto {
  @IsBoolean()
  enabled!: boolean;

  @IsBoolean()
  allowBrowser!: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(300)
  @Max(604800)
  ttlSeconds?: number;
}

export class ApproveGrantDto extends DeviceProofDto {
  @IsUUID()
  controllerDeviceId!: string;
}

export class ConnectDeviceDto {
  @IsOptional()
  @Matches(/^\d{6}$/)
  code?: string;

  @IsIn(['view', 'control'])
  scope!: 'view' | 'control';

  @IsOptional()
  @IsUUID()
  controllerDeviceId?: string;

  @ValidateIf((value: ConnectDeviceDto) => Boolean(value.controllerDeviceId))
  @IsString()
  @MinLength(24)
  challengeId?: string;

  @ValidateIf((value: ConnectDeviceDto) => Boolean(value.controllerDeviceId))
  @IsBase64()
  signature?: string;

  @IsOptional()
  @IsBoolean()
  rememberDevice?: boolean;
}

export class EndSessionDto {
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ValidateIf((value: EndSessionDto) => Boolean(value.deviceId))
  @IsString()
  @MinLength(24)
  challengeId?: string;

  @ValidateIf((value: EndSessionDto) => Boolean(value.deviceId))
  @IsBase64()
  signature?: string;
}
