import { Inject, Injectable, Optional } from '@nestjs/common';
import { loadConfig, SyncConfig } from './app-config';

export const SYNC_CONFIG_VALUES=Symbol('SYNC_CONFIG_VALUES');

@Injectable()
export class SyncConfigService {
  private readonly values:SyncConfig;

  constructor(@Optional() @Inject(SYNC_CONFIG_VALUES) values?:SyncConfig) {
    this.values=values ?? loadConfig();
  }

  get config(): SyncConfig { return this.values; }
  get authConfigured(): boolean {
    return Boolean(
      this.values.authIssuerUrl &&
      this.values.oidcClientId &&
      this.values.oidcClientSecret &&
      this.values.sessionEncryptionKey,
    );
  }
  get modeConfigured(): boolean { return Boolean(this.values.pinPepper); }
}
