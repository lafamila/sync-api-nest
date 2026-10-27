import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { SyncConfigService } from '../config/config.service';

@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  readonly client: Redis;
  constructor(private readonly config: SyncConfigService) {
    this.client = new Redis(config.config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2, enableReadyCheck: true });
  }
  async onModuleInit(): Promise<void> { await this.client.connect(); await this.client.ping(); }
  key(...parts: string[]): string { return [this.config.config.redisKeyPrefix, ...parts].join(':'); }
  async ping(): Promise<void> { await this.client.ping(); }
  async onApplicationShutdown(): Promise<void> { if (this.client.status !== 'end') await this.client.quit(); }
}
