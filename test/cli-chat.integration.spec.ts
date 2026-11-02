import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Pool } from 'pg';
import { loadConfig } from '../src/config/app-config';
import { SyncConfigService } from '../src/config/config.service';
import { DatabaseService } from '../src/database/database.service';
import { SCHEMA_SQL } from '../src/database/schema';
import { RedisService } from '../src/redis/redis.service';
import { RevocationBusService } from '../src/common/revocation-bus.service';
import { SessionRepository } from '../src/auth/session.repository';
import { DeviceRepository } from '../src/devices/device.repository';
import { DeviceProofService } from '../src/devices/device-proof.service';
import { DeviceService } from '../src/devices/device.service';
import { ModeService } from '../src/devices/mode.service';
import { RemoteSessionRepository } from '../src/sessions/remote-session.repository';
import { RemoteSessionService } from '../src/sessions/remote-session.service';
import { RuntimeIdentityService } from '../src/runtime/runtime-identity.service';
import { TicketService } from '../src/signaling/ticket.service';
import { IceService } from '../src/ice/ice.service';
import { randomOpaque } from '../src/common/crypto';
import { deviceProof } from '../src/generated/sync-wire';

const enabled=process.env.SYNC_CLI_CHAT_INTEGRATION_TESTS==='1';
const integration=enabled?describe:describe.skip;

integration('CLI chat isolated sync_test schema and Redis prefix',()=>{
  const id=randomUUID().replace(/-/g,'');
  const schema=`sync_cli_chat_${id}`;
  const prefix=`sync:test:cli-chat:${id}`;
  const database=new URL(process.env.SYNC_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/sync_test');
  if(decodeURIComponent(database.pathname.slice(1))!=='sync_test') {
    throw new Error('CLI chat integration refuses any database other than sync_test');
  }
  // Both pools override any URL search_path. Only the setup pool can see pg_catalog;
  // every migration/repository query is confined to a fresh schema, never public.
  const administration=new URL(database);
  administration.searchParams.set('options','-c search_path=pg_catalog');
  database.searchParams.set('options',`-c search_path=${schema}`);
  const admin=new Pool({connectionString:administration.toString(),max:1,connectionTimeoutMillis:3000});
  const config=new SyncConfigService(loadConfig({NODE_ENV:'test',DATABASE_URL:database.toString(),
    REDIS_URL:process.env.SYNC_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379',SYNC_REDIS_KEY_PREFIX:prefix,
    SYNC_PUBLIC_URL:'http://localhost:3053',SYNC_AUTH_ISSUER_URL:'http://localhost:3032',
    SYNC_AUTH_JWKS_URL:'http://localhost:3032/oauth/jwks',SYNC_OIDC_CLIENT_ID:'public-test-client',
    SYNC_OIDC_CLIENT_SECRET:'public-test-secret',SYNC_SESSION_ENCRYPTION_KEY:Buffer.alloc(32,17).toString('base64'),
    SYNC_PIN_PEPPER:'public-test-pin-pepper'}));
  const db=new DatabaseService(config);
  const redis=new RedisService(config);
  const bus=new RevocationBusService();
  const sessions=new RemoteSessionService(new RemoteSessionRepository(db),bus,new RuntimeIdentityService(config));
  const authSessions=new SessionRepository(db,config);
  const devices=new DeviceRepository(db);
  const proofs=new DeviceProofService(config,redis,devices);
  const modes=new ModeService(config,redis,sessions);
  const tickets=new TicketService(config,redis);
  const service=new DeviceService(devices,proofs,modes,sessions,tickets,new IceService(config),redis,bus,config);
  let created=false;

  beforeAll(async()=>{
    expect((await admin.query('select current_database() as name')).rows[0].name).toBe('sync_test');
    await admin.query(`create schema ${schema}`);
    created=true;
    expect((await db.query('select current_schema() as name')).rows[0]!.name).toBe(schema);
    await db.onModuleInit();
    await redis.onModuleInit();
    sessions.onModuleInit();
  },15000);

  afterAll(async()=>{
    sessions.onModuleDestroy();
    try {
      if(redis.client.status==='ready') {
        let cursor='0';
        do {
          const [next,keys]=await redis.client.scan(cursor,'MATCH',`${prefix}:*`,'COUNT',100);
          cursor=next;
          if(keys.length) await redis.client.del(...keys);
        } while(cursor!=='0');
        await redis.onApplicationShutdown();
      } else redis.client.disconnect();
    } finally {
      await db.onApplicationShutdown();
      try { if(created) await admin.query(`drop schema ${schema} cascade`); }
      finally { await admin.end(); }
    }
  },15000);

  async function fixture(chat=true) {
    const account={id:`cli-chat-test-${randomUUID()}`,name:'Synthetic Fixture',permission:'member' as const};
    const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const key=pair.publicKey.export({format:'der',type:'spki'});
    const host=await devices.create(account.id,{name:'Synthetic Mac',platform:'macos',publicKeyDer:key,protocolVersion:2});
    const controller=await devices.create(account.id,{name:'Synthetic Native',platform:'ios',publicKeyDer:key,protocolVersion:2});
    const grant=await devices.rememberGrant(account.id,host.id,controller.id,'control');
    const authId=await authSessions.create({token:randomOpaque(48),csrfToken:randomOpaque(),account,platform:'ios',
      accessToken:'synthetic-access',refreshToken:'synthetic-refresh',accessTokenExpiresAt:new Date(Date.now()+600000)});
    const auth={databaseId:authId,source:'native' as const,platform:'ios' as const,token:'synthetic',csrfHash:'synthetic',account};
    const mode=await modes.set(account,host,{enabled:true,allowBrowser:true,ttlSeconds:300});
    const endpoint={id:randomUUID(),protocolVersion:2,capabilities:['bounded-lifetime'],cliProtocolVersion:1,
      ...(chat?{cliChatProtocolVersion:1}:{})};
    await redis.client.set(redis.key('presence',host.id),JSON.stringify(endpoint),'EX',60);
    const input=async()=>{
      const challenge=await proofs.challenge(account,controller.id);
      return {protocolVersion:2,cliProtocolVersion:1,...(chat?{cliChatProtocolVersion:1}:{}),purpose:'cli' as const,scope:'control' as const,
        controllerDeviceId:controller.id,challengeId:challenge.id,
        signature:sign('sha256',Buffer.from(deviceProof(controller.id,challenge.id,challenge.nonce)),pair.privateKey).toString('base64')};
    };
    return {account,host,controller,grant,auth,mode,endpoint,input};
  }

  it('isolates all migration tables/search paths without creating history or message tables',async()=>{
    const names=await db.query('select tablename from pg_tables where schemaname=$1 order by tablename',[schema]);
    expect(names.rows.map(row=>row.tablename)).toEqual(['sync_access_events','sync_auth_sessions','sync_device_grants',
      'sync_devices','sync_remote_sessions','sync_schema_migrations']);
    expect((await db.query('show search_path')).rows[0]!.search_path).toBe(schema);
    expect((await db.query('select max(version) as version from sync_schema_migrations')).rows[0]!.version).toBe(5);
  });

  it('applies migration5 twice to populated v4 without changing rows or unique-host policy',async()=>{
    await db.transaction(async(query)=>{
      const migration=`${schema}_v4`;
      await query(`create schema ${migration}`);
      await query(`set local search_path to ${migration}`);
      await query(SCHEMA_SQL.split('do $$ begin').slice(0,4).join('do $$ begin'));
      const auth=randomUUID(),host=randomUUID(),secondHost=randomUUID(),controller=randomUUID(),grant=randomUUID(),epoch=randomUUID();
      await query(`insert into sync_auth_sessions(id,token_hash,csrf_hash,account_id,account_name,permission,platform,
        access_token_encrypted,refresh_token_encrypted,access_token_expires_at,expires_at)
        values($1,'preserve-test-token','csrf','owner','fixture','member','ios','access','refresh',now()+interval '1 hour',now()+interval '1 day')`,[auth]);
      for(const device of [host,secondHost,controller]) await query(`insert into sync_devices(id,owner_account_id,name,platform,public_key_der)
        values($1,'owner','Preserved fixture','macos',$2)`,[device,Buffer.from('synthetic-spki')]);
      await query(`insert into sync_device_grants(id,owner_account_id,host_device_id,controller_device_id,scope)
        values($1,'owner',$2,$3,'control')`,[grant,host,controller]);
      const cli=randomUUID(),screen=randomUUID();
      await query(`insert into sync_remote_sessions(id,owner_account_id,host_device_id,controller_device_id,controller_kind,scope,
        mode_epoch,auth_session_id,expires_at,purpose,protocol_version,cli_protocol_version,authorization_grant_id,host_endpoint_id)
        values($1,'owner',$2,$3,'native','control',$4,$5,now()+interval '1 hour','cli',2,1,$6,'original-endpoint')`,
        [cli,host,controller,epoch,auth,grant]);
      await query(`insert into sync_remote_sessions(id,owner_account_id,host_device_id,controller_kind,scope,mode_epoch,auth_session_id,expires_at)
        values($1,'owner',$2,'browser','view',$3,$4,now()+interval '1 hour')`,[screen,secondHost,epoch,auth]);
      const before=await query('select * from sync_remote_sessions order by id');
      const indexBefore=await query(`select indexdef from pg_indexes where schemaname=$1 and indexname='sync_one_controller_per_host_idx'`,[migration]);
      await query(SCHEMA_SQL); await query(SCHEMA_SQL);
      const after=await query('select * from sync_remote_sessions order by id');
      expect(after.rows.map(({cli_chat_protocol_version,...row})=>{ expect(cli_chat_protocol_version).toBeNull(); return row; })).toEqual(before.rows);
      expect((await query(`select indexdef from pg_indexes where schemaname=$1 and indexname='sync_one_controller_per_host_idx'`,[migration])).rows).toEqual(indexBefore.rows);
      expect((await query('select max(version) as version from sync_schema_migrations')).rows[0]!.version).toBe(5);
      for(const [session,assignment] of [[screen,'cli_chat_protocol_version=1'],[cli,'cli_chat_protocol_version=2'],
        [cli,'cli_chat_protocol_version=1,cli_protocol_version=null'],[cli,`cli_chat_protocol_version=1,controller_device_id=host_device_id`]]) {
        await query('savepoint invalid_chat');
        await expect(query(`update sync_remote_sessions set ${assignment} where id=$1`,[session])).rejects.toMatchObject({code:'23514'});
        await query('rollback to savepoint invalid_chat');
      }
      await query(`drop schema ${migration} cascade`);
    });
    expect((await db.query('show search_path')).rows[0]!.search_path).toBe(schema);
  });

  it.each(['screen','cli'] as const)('persists immutable %s chat snapshots and installs only their original endpoint',async(purpose)=>{
    const f=await fixture();
    const connected=await service.connect(f.auth,f.host.id,{...await f.input(),purpose},'127.0.0.1');
    expect(connected.session).toMatchObject({purpose,cliProtocolVersion:1,cliChatProtocolVersion:1,epoch:f.mode.mode!.epoch});
    const snapshot=(await sessions.findActive(connected.session.id))!;
    expect(snapshot).toMatchObject({cliChatProtocolVersion:1,authorizationGrantId:f.grant.id,hostEndpointId:f.endpoint.id});
    await expect(sessions.installController(snapshot,()=>true)).resolves.toMatchObject({cliChatProtocolVersion:1});
    await expect(sessions.bindHostEndpoint(snapshot,'replacement',()=>true)).resolves.toBeUndefined();
  });

  it('keeps legacy CLI1 snapshots null even when the host later gains chat support',async()=>{
    const f=await fixture(false);
    const connected=await service.connect(f.auth,f.host.id,await f.input(),'127.0.0.1');
    const snapshot=(await sessions.findActive(connected.session.id))!;
    expect(snapshot.cliProtocolVersion).toBe(1);
    expect(snapshot).not.toHaveProperty('cliChatProtocolVersion');
    const raw=(await db.query('select cli_chat_protocol_version from sync_remote_sessions where id=$1',[snapshot.id])).rows[0]!;
    expect(raw.cli_chat_protocol_version).toBeNull();
    await redis.client.set(redis.key('presence',f.host.id),JSON.stringify({...f.endpoint,cliChatProtocolVersion:1}),'EX',60);
    await devices.updateCapabilities(f.account.id,f.host.id,{protocolVersion:2,capabilities:['bounded-lifetime']});
    await expect(sessions.installController({...snapshot,cliChatProtocolVersion:1},()=>true)).rejects.toMatchObject({status:403});
    expect((await sessions.findActive(snapshot.id))!).not.toHaveProperty('cliChatProtocolVersion');
    await expect(sessions.installController(snapshot,()=>true)).resolves.not.toHaveProperty('cliChatProtocolVersion');
  });

  it.each(['old-host','missing-cli','old-controller','stale-metadata'] as const)('fails closed for %s chat declaration without fallback',async(kind)=>{
    const f=await fixture();
    const input:Parameters<DeviceService['connect']>[2]=await f.input();
    if(kind==='old-host' || kind==='stale-metadata') {
      await redis.client.set(redis.key('presence',f.host.id),JSON.stringify({...f.endpoint,cliChatProtocolVersion:undefined}),'EX',60);
    }
    if(kind==='missing-cli') delete input.cliProtocolVersion;
    if(kind==='old-controller') input.protocolVersion=1;
    await expect(service.connect(f.auth,f.host.id,input,'127.0.0.1')).rejects.toMatchObject({status:426,response:{error:'cli-chat-update-required'}});
    expect(await sessions.listOwned(f.account.id)).toEqual([]);
  });

  it.each(['browser','view','pin','no-grant','other-owner','bad-proof','windows','mode-off'] as const)('rejects real %s authority with zero chat rows',async(kind)=>{
    const f=await fixture();
    const input:Parameters<DeviceService['connect']>[2]=await f.input();
    const auth:Parameters<DeviceService['connect']>[0]={...f.auth};
    if(kind==='browser') Object.assign(auth,{source:'web',platform:'web'});
    if(kind==='view') input.scope='view';
    if(kind==='pin') input.code=f.mode.code;
    if(kind==='no-grant') await devices.revokeGrant(f.account.id,f.host.id,f.grant.id);
    if(kind==='other-owner') auth.account={...f.account,id:'unrelated-fixture-owner'};
    if(kind==='bad-proof') input.signature=Buffer.alloc(64).toString('base64');
    if(kind==='windows') await db.query("update sync_devices set platform='windows' where id=$1",[f.host.id]);
    if(kind==='mode-off') await modes.clear(f.host.id);
    await expect(service.connect(auth,f.host.id,input,'127.0.0.1')).rejects.toMatchObject({status:403});
    expect(await sessions.listOwned(f.account.id)).toEqual([]);
  });

  it.each(['grant','auth','controller','host','expiry'] as const)('rechecks %s before controller installation',async(kind)=>{
    const f=await fixture();
    const connected=await service.connect(f.auth,f.host.id,await f.input(),'127.0.0.1');
    const snapshot=(await sessions.findActive(connected.session.id))!;
    if(kind==='grant') await devices.revokeGrant(f.account.id,f.host.id,f.grant.id);
    if(kind==='auth') await authSessions.revoke(f.auth.databaseId);
    if(kind==='controller' || kind==='host') await devices.revoke(f.account.id,kind==='controller'?f.controller.id:f.host.id);
    if(kind==='expiry') await db.query("update sync_remote_sessions set expires_at=clock_timestamp()-interval '1 second' where id=$1",[snapshot.id]);
    const install=jest.fn(()=>true);
    await expect(sessions.installController(snapshot,install)).rejects.toMatchObject({status:403});
    expect(install).not.toHaveBeenCalled();
  });

  it.each(['endpoint','mode'] as const)('rechecks %s after INSERT and cleans the isolated reservation',async(kind)=>{
    const f=await fixture();
    const create=sessions.create.bind(sessions);
    const spy=jest.spyOn(sessions,'create').mockImplementationOnce(async(input)=>{
      const snapshot=await create(input);
      if(kind==='endpoint') await redis.client.set(redis.key('presence',f.host.id),JSON.stringify({...f.endpoint,id:randomUUID()}),'EX',60);
      else await modes.set(f.account,f.host,{enabled:true,allowBrowser:true,ttlSeconds:300});
      return snapshot;
    });
    try {
      await expect(service.connect(f.auth,f.host.id,await f.input(),'127.0.0.1')).rejects.toMatchObject({status:403});
      expect(await sessions.listOwned(f.account.id)).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it('retains the single host-wide controller reservation across concurrent CLI1/chat requests',async()=>{
    const f=await fixture();
    const [chat,legacy]=await Promise.all([f.input(),f.input()]);
    delete (legacy as {cliChatProtocolVersion?:number}).cliChatProtocolVersion;
    const results=await Promise.allSettled([service.connect(f.auth,f.host.id,chat,'127.0.0.1'),service.connect(f.auth,f.host.id,legacy,'127.0.0.1')]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
    expect(await sessions.listOwned(f.account.id)).toHaveLength(1);
  });
});
