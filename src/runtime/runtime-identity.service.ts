import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SyncConfigService } from '../config/config.service';

@Injectable()
export class RuntimeIdentityService {
  readonly instanceId=randomUUID();
  readonly namespace:string;
  constructor(config:SyncConfigService) { this.namespace=config.config.redisKeyPrefix; }
}
