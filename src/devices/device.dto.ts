import { ArrayMaxSize, ArrayUnique, IsArray, IsBase64, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';
import { NATIVE_PLATFORMS, SYNC_CAPABILITIES, SYNC_LIMITS, WireBrowserActivity, WireDeviceProof } from '../generated/sync-wire';

export class EndpointMetadataDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  protocolVersion?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SYNC_CAPABILITIES.length)
  @ArrayUnique()
  @IsIn(SYNC_CAPABILITIES, { each: true })
  capabilities?: (typeof SYNC_CAPABILITIES)[number][];
}

export class DeviceMetadataDto extends EndpointMetadataDto {
  @IsOptional()
  @IsString()
  @MaxLength(SYNC_LIMITS.maxClientVersionLength)
  @Matches(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
  clientVersion?: string;
}

export class DeviceChallengeDto {
  @IsOptional()
  @IsUUID()
  deviceId?: string;
}

export class DeviceProofDto implements WireDeviceProof {
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

export class RegisterDeviceDto extends DeviceMetadataDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsIn(NATIVE_PLATFORMS)
  platform!: (typeof NATIVE_PLATFORMS)[number];

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
  @Min(SYNC_LIMITS.minimumModeSeconds)
  @Max(SYNC_LIMITS.maximumModeSeconds)
  ttlSeconds?: number;
}

export class ApproveGrantDto extends DeviceProofDto {
  @IsUUID()
  controllerDeviceId!: string;
}

export class ConnectDeviceDto extends EndpointMetadataDto {
  @ValidateIf((_value, value) => value !== undefined)
  @IsInt()
  @IsIn([SYNC_LIMITS.cliChatProtocolVersion])
  cliChatProtocolVersion?: number;

  @ValidateIf((_value, value) => value !== undefined)
  @IsIn(['screen', 'cli', 'access-code'])
  purpose?: 'screen' | 'cli' | 'access-code';

  @ValidateIf((_value, value) => value !== undefined)
  @IsInt()
  @IsIn([SYNC_LIMITS.cliProtocolVersion])
  cliProtocolVersion?: number;

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
  @MaxLength(128)
  challengeId?: string;

  @ValidateIf((value: ConnectDeviceDto) => Boolean(value.controllerDeviceId))
  @IsBase64()
  @MaxLength(256)
  signature?: string;

  @IsOptional()
  @IsBoolean()
  rememberDevice?: boolean;
}

export class CapabilityUpdateDto extends DeviceMetadataDto {
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

export class DeviceTicketDto extends EndpointMetadataDto {
  @ValidateIf((_value, value) => value !== undefined)
  @IsInt()
  @IsIn([SYNC_LIMITS.cliChatProtocolVersion])
  cliChatProtocolVersion?: number;

  @ValidateIf((_value, value) => value !== undefined)
  @IsInt()
  @IsIn([SYNC_LIMITS.cliProtocolVersion])
  cliProtocolVersion?: number;

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

export class BrowserActivityDto implements WireBrowserActivity {
  @IsString()
  @MinLength(24)
  @MaxLength(256)
  activityToken!: string;
}

export class BrowserRecoveryDto extends EndpointMetadataDto {
  @IsString()
  @MinLength(24)
  @MaxLength(256)
  activityToken!: string;
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
