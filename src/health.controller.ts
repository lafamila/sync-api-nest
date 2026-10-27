import { Controller, Get } from '@nestjs/common';
import { SyncConfigService } from './config/config.service';
import { DatabaseService } from './database/database.service';
import { RedisService } from './redis/redis.service';

@Controller()
export class HealthController {
  constructor(private readonly config:SyncConfigService,private readonly db:DatabaseService,private readonly redis:RedisService) {}
  @Get('health')
  async health() {
    const [database,redis]=await Promise.allSettled([this.db.ping(),this.redis.ping()]);
    const ready=database.status==='fulfilled' && redis.status==='fulfilled';
    return { status:ready?'ok':'degraded',ready,product:'Sync',version:'0.1.0',dependencies:{ database:database.status==='fulfilled'?'up':'down',redis:redis.status==='fulfilled'?'up':'down' } };
  }
  @Get('config')
  publicConfig() { return { product:'Sync',version:'0.1.0',authConfigured:this.config.authConfigured,webUrl:this.config.config.publicUrl }; }
}
