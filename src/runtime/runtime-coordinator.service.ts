import { BeforeApplicationShutdown, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { RevocationBusService } from '../common/revocation-bus.service';
import { SyncConfigService } from '../config/config.service';
import { RedisService } from '../redis/redis.service';
import { RemoteSessionService } from '../sessions/remote-session.service';
import { RuntimeIdentityService } from './runtime-identity.service';

@Injectable()
export class RuntimeCoordinatorService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private renewal?:NodeJS.Timeout;
  private active=false;
  constructor(
    private readonly config:SyncConfigService,
    private readonly redis:RedisService,
    private readonly identity:RuntimeIdentityService,
    private readonly sessions:RemoteSessionService,
    private readonly revocations:RevocationBusService,
  ) {}

  async onApplicationBootstrap():Promise<void> {
    const acquired=await this.redis.client.set(this.leaseKey(),this.identity.instanceId,'EX',
      this.config.config.instanceLeaseTtlSeconds,'NX');
    if(acquired!=='OK') throw new Error(`Another Sync API instance owns Redis namespace ${this.identity.namespace}`);
    this.active=true;
    await this.sessions.endOrphans(this.identity.namespace,this.identity.instanceId,'server_restarted');
    const interval=Math.max(1,Math.floor(this.config.config.instanceLeaseTtlSeconds/3))*1000;
    this.renewal=setInterval(()=>void this.renew(),interval);
    this.renewal.unref();
  }

  async beforeApplicationShutdown():Promise<void> {
    if(this.renewal) clearInterval(this.renewal);
    if(!this.active) return;
    this.active=false;
    await this.redis.client.eval(
      `if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`,
      1,this.leaseKey(),this.identity.instanceId,
    ).catch(()=>undefined);
  }

  private async renew():Promise<void> {
    if(!this.active) return;
    try {
      const renewed=await this.redis.client.eval(
        `if redis.call('GET',KEYS[1]) == ARGV[1] then redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]); return 1 else return 0 end`,
        1,this.leaseKey(),this.identity.instanceId,String(this.config.config.instanceLeaseTtlSeconds),
      );
      if(Number(renewed)!==1) throw new Error('runtime lease lost');
    } catch {
      this.active=false;
      this.revocations.emit({kind:'runtime',id:this.identity.instanceId,reason:'runtime_lease_lost'});
      process.kill(process.pid,'SIGTERM');
    }
  }

  private leaseKey():string { return this.redis.key('api-instance-lease'); }
}
