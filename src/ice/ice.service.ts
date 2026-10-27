import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { sha256 } from '../common/crypto';
import { Account } from '../common/request';
import { SyncConfigService } from '../config/config.service';

export interface IceServer { urls: string[]; username?: string; credential?: string }

@Injectable()
export class IceService {
  constructor(private readonly config: SyncConfigService) {}
  forAccount(account: Account): IceServer[] {
    const result: IceServer[] = [];
    if (this.config.config.stunUrls.length) result.push({ urls: this.config.config.stunUrls });
    if (this.config.config.turnUrls.length && this.config.config.turnSecret) {
      const expiry = Math.floor(Date.now() / 1000) + this.config.config.turnTtlSeconds;
      const username = `${expiry}:${this.config.config.turnUsernamePrefix}:${sha256(account.id).slice(0, 16)}`;
      const credential = createHmac('sha1', this.config.config.turnSecret).update(username).digest('base64');
      result.push({ urls: this.config.config.turnUrls, username, credential });
    }
    return result;
  }
}
