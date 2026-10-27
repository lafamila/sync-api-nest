import { Test } from '@nestjs/testing';
import { SyncConfigService } from '../src/config/config.service';
import { loadConfig } from '../src/config/app-config';

describe('SyncConfigService Nest DI bootstrap',()=>{
  it('loads process environment when no config-values provider is registered',async()=>{
    const previousDatabase=process.env.DATABASE_URL;
    const previousRedis=process.env.REDIS_URL;
    process.env.DATABASE_URL='postgresql://bootstrap:bootstrap@127.0.0.1:5432/bootstrap';
    process.env.REDIS_URL='redis://127.0.0.1:6379';
    try {
      const module=await Test.createTestingModule({providers:[SyncConfigService]}).compile();
      expect(module.get(SyncConfigService).config.databaseUrl).toContain('/bootstrap');
      await module.close();
    } finally {
      restoreEnv('DATABASE_URL',previousDatabase);
      restoreEnv('REDIS_URL',previousRedis);
    }
  });

  it('includes the canonical public origin plus explicit local development aliases',()=>{
    const config=loadConfig({DATABASE_URL:'postgresql://test',REDIS_URL:'redis://127.0.0.1:6379',
      SYNC_PUBLIC_URL:'http://localhost:3053',
      SYNC_ALLOWED_ORIGINS:'http://127.0.0.1:3053,http://localhost:5179,http://127.0.0.1:5179'});
    expect(config.allowedOrigins).toEqual([
      'http://localhost:3053','http://127.0.0.1:3053','http://localhost:5179','http://127.0.0.1:5179',
    ]);
  });
});

function restoreEnv(name:string,value:string|undefined):void {
  if(value===undefined) delete process.env[name];
  else process.env[name]=value;
}
