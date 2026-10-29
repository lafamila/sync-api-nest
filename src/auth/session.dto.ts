import { IsIn, IsOptional, IsString, Length, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { SESSION_PLATFORMS } from '../generated/sync-wire';

export class OidcStartDto {
  @IsIn(SESSION_PLATFORMS)
  platform!: (typeof SESSION_PLATFORMS)[number];

  @ValidateIf((value: OidcStartDto) => value.platform !== 'web')
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  challenge?: string;

  @IsOptional()
  @IsString()
  @Length(11, 11)
  @Matches(/^sync:\/\/auth$/)
  returnUri?: 'sync://auth';
}

export class OidcCompleteDto {
  @IsString()
  @MinLength(32)
  @MaxLength(128)
  transactionId!: string;

  @IsString()
  @MinLength(32)
  @MaxLength(128)
  verifier!: string;

  @IsString()
  @MinLength(32)
  @MaxLength(128)
  handoffCode!: string;
}
