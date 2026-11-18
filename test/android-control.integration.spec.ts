import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Pool } from 'pg';
import { loadConfig } from '../src/config/app-config';
import { SyncConfigService } from '../src/config/config.service';
import { DatabaseService, Query } from '../src/database/database.service';
import { SCHEMA_SQL } from '../src/database/schema';
import { RedisService } from '../src/redis/redis.service';
import { RevocationBusService } from '../src/common/revocation-bus.service';
import { SessionRepository } from '../src/auth/session.repository';
import { DeviceRepository } from '../src/devices/device.repository';
import { DeviceProofService } from '../src/devices/device-proof.service';
import { DeviceService } from '../src/devices/device.service';
import { ConnectDeviceDto } from '../src/devices/device.dto';
import { ModeService } from '../src/devices/mode.service';
import { RemoteSession, RemoteSessionRepository } from '../src/sessions/remote-session.repository';
import { supportsSession } from '../src/common/protocol';
import { RemoteSessionService } from '../src/sessions/remote-session.service';
import { RuntimeIdentityService } from '../src/runtime/runtime-identity.service';
import { TicketService } from '../src/signaling/ticket.service';
import { IceService } from '../src/ice/ice.service';
import { randomOpaque } from '../src/common/crypto';
import { deviceProof } from '../src/generated/sync-wire';

const integration=process.env.SYNC_ANDROID_CONTROL_INTEGRATION_TESTS==='1'?describe:describe.skip;
integration('Android control isolated DB authority, additive migration7 and real grant locks',()=>{
  const suffix=randomUUID().replace(/-/g,''),schema=`sync_android_${suffix}`,prefix=`sync:test:android:${suffix}`;
  const database=new URL(process.env.SYNC_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/sync_test');
  if(decodeURIComponent(database.pathname.slice(1))!=='sync_test' || !['localhost','127.0.0.1','[::1]'].includes(database.hostname)) {
    throw new Error('Android control integration requires loopback sync_test');
  }
  const redisUrl=new URL(process.env.SYNC_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379');
  if(!['localhost','127.0.0.1','[::1]'].includes(redisUrl.hostname)) throw new Error('Android control integration requires loopback Redis');
  const administration=new URL(database);administration.searchParams.set('options','-c search_path=pg_catalog');
  database.searchParams.set('options',`-c search_path=${schema}`);database.searchParams.set('application_name',schema);
  const admin=new Pool({connectionString:administration.toString(),max:1,connectionTimeoutMillis:3000});
  const config=new SyncConfigService(loadConfig({NODE_ENV:'test',DATABASE_URL:database.toString(),
    REDIS_URL:redisUrl.toString(),SYNC_REDIS_KEY_PREFIX:prefix,SYNC_PUBLIC_URL:'http://localhost:3053',
    SYNC_AUTH_ISSUER_URL:'http://localhost:3032',SYNC_AUTH_JWKS_URL:'http://localhost:3032/oauth/jwks',
    SYNC_OIDC_CLIENT_ID:'synthetic-test-client',SYNC_OIDC_CLIENT_SECRET:'synthetic-test-secret',
    SYNC_SESSION_ENCRYPTION_KEY:Buffer.alloc(32,17).toString('base64'),SYNC_PIN_PEPPER:'synthetic-test-pepper'}));
  const db=new DatabaseService(config),redis=new RedisService(config),bus=new RevocationBusService();
  const repository=new RemoteSessionRepository(db),sessions=new RemoteSessionService(repository,bus,new RuntimeIdentityService(config));
  const authSessions=new SessionRepository(db,config),devices=new DeviceRepository(db);
  const proofs=new DeviceProofService(config,redis,devices),modes=new ModeService(config,redis,sessions),tickets=new TicketService(config,redis);
  const service=new DeviceService(devices,proofs,modes,sessions,tickets,new IceService(config),redis,bus,config);
  let created=false;
  beforeAll(async()=>{
    expect((await admin.query('select current_database() as name')).rows[0].name).toBe('sync_test');
    await admin.query(`create schema ${schema}`);created=true;
    expect((await db.query('select current_schema() as name')).rows[0]!.name).toBe(schema);
    await db.onModuleInit();await redis.onModuleInit();sessions.onModuleInit();
  },15000);
  afterAll(async()=>{
    sessions.onModuleDestroy();
    try {
      if(redis.client.status==='ready') {
        let cursor='0';
        do { const [next,keys]=await redis.client.scan(cursor,'MATCH',`${prefix}:*`,'COUNT',100);cursor=next;
          if(keys.length) await redis.client.del(...keys);
        } while(cursor!=='0');
        await redis.onApplicationShutdown();
      } else redis.client.disconnect();
    } finally {
      await db.onApplicationShutdown();
      try { if(created) await admin.query(`drop schema ${schema} cascade`); } finally { await admin.end(); }
    }
  },15000);

  async function fixture(scope:'view'|'control'='control') {
    const account={id:`android-test-${randomUUID()}`,name:'Synthetic Fixture',permission:'member' as const};
    const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),key=pair.publicKey.export({format:'der',type:'spki'});
    const host=await devices.create(account.id,{name:'Synthetic Android',platform:'android',publicKeyDer:key,protocolVersion:2});
    const controller=await devices.create(account.id,{name:'Synthetic iPhone controller',platform:'ios',publicKeyDer:key,protocolVersion:2});
    const grant=await devices.rememberGrant(account.id,host.id,controller.id,scope);
    const authId=await authSessions.create({token:randomOpaque(48),csrfToken:randomOpaque(),account,platform:'ios',
      accessToken:'synthetic-access',refreshToken:'synthetic-refresh',accessTokenExpiresAt:new Date(Date.now()+600000)});
    const auth={databaseId:authId,source:'native' as const,platform:'ios' as const,token:'synthetic',csrfHash:'synthetic',account};
    const mode=await modes.set(account,host,{enabled:true,allowBrowser:false,allowControl:true,ttlSeconds:300});
    const endpoint={id:randomUUID(),protocolVersion:2,capabilities:['screen-host','input-host','bounded-lifetime'],androidControlProtocolVersion:1};
    await redis.client.set(redis.key('presence',host.id),JSON.stringify(endpoint),'EX',60);
    const proof=async(deviceId:string)=>{
      const challenge=await proofs.challenge(account,deviceId);
      return {deviceId,challengeId:challenge.id,
        signature:sign('sha256',Buffer.from(deviceProof(deviceId,challenge.id,challenge.nonce)),pair.privateKey).toString('base64')};
    };
    const input=async():Promise<ConnectDeviceDto>=>{
      const signed=await proof(controller.id);
      return {protocolVersion:2,androidControlProtocolVersion:1,purpose:'screen',scope:'control',capabilities:['bounded-lifetime'],
        controllerDeviceId:controller.id,challengeId:signed.challengeId,signature:signed.signature};
    };
    const connect=async()=>service.connect(auth,host.id,await input(),'127.0.0.1');
    return {account,host,controller,grant,auth,mode,endpoint,input,connect,proof};
  }
  function live(snapshot:RemoteSession) {
    return async()=>{
      const mode=await modes.get(snapshot.ownerAccountId,snapshot.hostId),endpoint=await tickets.activeEndpoint(snapshot.hostId);
      return Boolean(mode?.allowControl && mode.epoch===snapshot.epoch && endpoint?.id===snapshot.hostEndpointId && supportsSession(endpoint,snapshot));
    };
  }
  async function snapshot(f:Awaited<ReturnType<typeof fixture>>) { return (await sessions.findActive((await f.connect()).session.id))!; }
  async function hold(sql:string,params:unknown[]) {
    let reached!:()=>void,release!:()=>void;
    const locked=new Promise<void>(resolve=>{reached=resolve;}),waiting=new Promise<void>(resolve=>{release=resolve;});
    const transaction=db.transaction(async(query)=>{await query(sql,params);reached();await waiting;});
    await Promise.race([locked,transaction.then(()=>{throw new Error('lock not acquired');})]);
    return {release,transaction};
  }
  async function waitBlocked() {
    const deadline=Date.now()+3000;
    while(Date.now()<deadline) {
      if((await admin.query(`select 1 from pg_stat_activity where application_name=$1 and cardinality(pg_blocking_pids(pid))>0`,[schema])).rowCount) return;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error('Expected actual PostgreSQL lock contention');
  }
  async function rejectLocked(lock:Awaited<ReturnType<typeof hold>>,start:()=>Promise<unknown>,during?:()=>Promise<unknown>) {
    const result=start().then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    try { await waitBlocked();await during?.(); } finally { lock.release();await lock.transaction; }
    expect((await result).error).toMatchObject({status:403});
  }

  it('installs genuine version1/control with host-role input-host despite no controller input-host',async()=>{
    const f=await fixture(),s=await snapshot(f);
    expect(s).toMatchObject({androidControlProtocolVersion:1,scope:'control',purpose:'screen',capabilities:['bounded-lifetime','input-host'],
      authorizationGrantId:f.grant.id,hostEndpointId:f.endpoint.id});
    await expect(sessions.installController(s,()=>true,live(s))).resolves.toMatchObject({androidControlProtocolVersion:1});
    await expect(sessions.bindHostEndpoint(s,'replacement',()=>true,live(s))).resolves.toBeUndefined();
    await expect(sessions.bindHostEndpoint(s,f.endpoint.id,()=>true,live(s))).resolves.toMatchObject({id:s.id});
  });
  it('preserves old view grants, requires explicit upgrade and ends existing pair rows on both scope changes',async()=>{
    const f=await fixture('view');
    await expect(f.connect()).rejects.toMatchObject({status:403});
    const viewed=await service.connect(f.auth,f.host.id,{...await f.input(),scope:'view'},'127.0.0.1');
    expect(viewed.session).not.toHaveProperty('androidControlProtocolVersion');
    expect((await devices.findGrant(f.account.id,f.host.id,f.controller.id))!.scope).toBe('view');
    const events:unknown[]=[];const unsubscribe=bus.subscribe(event=>events.push(event));
    try {
      await service.approveGrant(f.auth,f.host.id,{...await f.proof(f.host.id),controllerDeviceId:f.controller.id,scope:'control'});
      expect((await sessions.findOwned(f.account.id,viewed.session.id))!.endReason).toBe('grant_scope_changed');
      const controlled=await snapshot(f);
      await service.approveGrant(f.auth,f.host.id,{...await f.proof(f.host.id),controllerDeviceId:f.controller.id});
      expect((await sessions.findOwned(f.account.id,controlled.id))!.endReason).toBe('grant_scope_changed');
      expect(events).toContainEqual({kind:'session',id:controlled.id,reason:'grant_scope_changed'});
      await expect(sessions.installController(controlled,()=>true,live(controlled))).rejects.toMatchObject({status:403});
      expect((await service.listGrants(f.auth,f.host.id)).grants[0].scope).toBe('view');
    } finally { unsubscribe(); }
  });
  it.each(['create','install','bind'] as const)('relocks a revoked grant before %s',async(phase)=>{
    const f=await fixture(),s=phase==='create'?undefined:await snapshot(f);
    const input=await f.input();
    const lock=await hold('update sync_device_grants set revoked_at=clock_timestamp() where id=$1',[f.grant.id]);
    const install=jest.fn(()=>true);
    await rejectLocked(lock,()=>phase==='create'?service.connect(f.auth,f.host.id,input,'127.0.0.1'):
      phase==='install'?sessions.installController(s!,install,live(s!)):sessions.bindHostEndpoint(s!,f.endpoint.id,install,live(s!)));
    expect(install).not.toHaveBeenCalled();
  });
  it.each(['create','install','bind'] as const)('relocks a downgraded view grant before %s',async(phase)=>{
    const f=await fixture(),s=phase==='create'?undefined:await snapshot(f),input=await f.input();
    const lock=await hold("update sync_device_grants set scope='view' where id=$1",[f.grant.id]);
    await rejectLocked(lock,()=>phase==='create'?service.connect(f.auth,f.host.id,input,'127.0.0.1'):
      phase==='install'?sessions.installController(s!,()=>true,live(s!)):sessions.bindHostEndpoint(s!,f.endpoint.id,()=>true,live(s!)));
  });
  it.each(['mode','endpoint'] as const)('rechecks %s after waiting on the session lock for install/bind',async(kind)=>{
    for(const phase of ['install','bind'] as const) {
      const f=await fixture(),s=await snapshot(f),lock=await hold('select id from sync_remote_sessions where id=$1 for update',[s.id]);
      await rejectLocked(lock,()=>phase==='install'?sessions.installController(s,()=>true,live(s)):sessions.bindHostEndpoint(s,f.endpoint.id,()=>true,live(s)),async()=>{
        if(kind==='mode') {
          const raw=JSON.parse((await redis.client.get(redis.key('mode',f.host.id)))!);raw.allowControl=false;
          await redis.client.set(redis.key('mode',f.host.id),JSON.stringify(raw),'EX',60);
        } else await redis.client.set(redis.key('presence',f.host.id),JSON.stringify({...f.endpoint,id:randomUUID()}),'EX',60);
      });
    }
  });
  it('requires live callbacks at create/install/bind, prevents fabricated snapshot upgrades and bounds reservations',async()=>{
    const f=await fixture(),s=await snapshot(f);
    await expect(repository.create({...s,controllerDeviceId:s.controllerDeviceId!,authorizationGrantId:s.authorizationGrantId!,
      hostEndpointId:s.hostEndpointId!,expiresAt:new Date(s.expiresAt)})).rejects.toMatchObject({status:403});
    await expect(sessions.installController(s,()=>true)).rejects.toMatchObject({status:403});
    await expect(sessions.bindHostEndpoint(s,f.endpoint.id,()=>true)).rejects.toMatchObject({status:403});
    await expect(sessions.installController({...s,androidControlProtocolVersion:undefined},()=>true)).rejects.toMatchObject({status:403});
    await db.query("update sync_remote_sessions set connection_deadline=clock_timestamp()-interval '1 second' where id=$1",[s.id]);
    await expect(sessions.installController(s,()=>true,live(s))).rejects.toMatchObject({status:403});
    await sessions.endExpired();expect((await sessions.findOwned(f.account.id,s.id))!.endReason).toBe('connection_timeout');
  });
  it.each(['other-owner','self','browser','pin','ios','no-version','no-input-host'] as const)('rejects actual %s authority',async(kind)=>{
    const f=await fixture(),input=await f.input(),auth={...f.auth};
    if(kind==='other-owner') auth.account={...f.account,id:'other-synthetic-owner'};
    if(kind==='self') input.controllerDeviceId=f.host.id;
    if(kind==='browser') Object.assign(auth,{source:'web',platform:'web'});
    if(kind==='pin') input.code='123456';
    if(kind==='ios') await db.query("update sync_devices set platform='ios' where id=$1",[f.host.id]);
    if(kind==='no-version') delete input.androidControlProtocolVersion;
    if(kind==='no-input-host') await redis.client.set(redis.key('presence',f.host.id),JSON.stringify({...f.endpoint,capabilities:[]}), 'EX',60);
    await expect(service.connect(auth,f.host.id,input,'127.0.0.1')).rejects.toThrow();
    expect(await sessions.listOwned(f.account.id)).toEqual([]);
  });
  it('mode OFF ends only inbound sessions and preserves independent outbound viewers',async()=>{
    const f=await fixture(),s=await snapshot(f),g=await fixture();
    await devices.rememberGrant(f.account.id,g.host.id,f.host.id,'view');
    await db.query('update sync_devices set owner_account_id=$1 where id=$2',[f.account.id,g.host.id]);
    const outbound=await sessions.create({ownerAccountId:f.account.id,hostId:g.host.id,controllerDeviceId:f.host.id,
      controllerKind:'native',scope:'view',epoch:randomUUID(),authSessionId:f.auth.databaseId,expiresAt:new Date(Date.now()+60000)});
    await modes.set(f.account,f.host,{enabled:false,allowBrowser:false});
    expect((await sessions.findOwned(f.account.id,s.id))!.endReason).toBe('mode_disabled');
    expect(await sessions.findActive(outbound.id)).toBeDefined();
  });
  it('migration7 is additive/idempotent over populated v6, leaving grants and view/history untouched',async()=>{
    await db.transaction(async(query:Query)=>{
      const migration=`${schema}_v6`;await query(`create schema ${migration}`);await query(`set local search_path to ${migration}`);
      await query(SCHEMA_SQL.split('do $$ begin').slice(0,6).join('do $$ begin'));
      const auth=randomUUID(),host=randomUUID(),controller=randomUUID(),grant=randomUUID(),epoch=randomUUID(),id=randomUUID();
      await query(`insert into sync_auth_sessions(id,token_hash,csrf_hash,account_id,account_name,permission,platform,access_token_encrypted,
        refresh_token_encrypted,access_token_expires_at,expires_at) values($1,'synthetic','synthetic','fixture','Fixture','member','ios',
        'synthetic','synthetic',now()+interval '1 hour',now()+interval '1 day')`,[auth]);
      for(const device of [host,controller]) await query(`insert into sync_devices(id,owner_account_id,name,platform,public_key_der)
        values($1,'fixture','Preserved','android',$2)`,[device,Buffer.from('synthetic-key')]);
      await query(`insert into sync_device_grants(id,owner_account_id,host_device_id,controller_device_id,scope) values($1,'fixture',$2,$3,'view')`,[grant,host,controller]);
      await query(`insert into sync_remote_sessions(id,owner_account_id,host_device_id,controller_device_id,controller_kind,scope,mode_epoch,
        auth_session_id,expires_at) values($1,'fixture',$2,$3,'native','view',$4,$5,now()+interval '1 hour')`,[id,host,controller,epoch,auth]);
      const before=(await query('select * from sync_remote_sessions order by id')).rows;
      const grants=(await query('select * from sync_device_grants')).rows;
      await query(SCHEMA_SQL);await query(SCHEMA_SQL);
      expect((await query('select max(version) as version from sync_schema_migrations')).rows[0]!.version).toBe(7);
      expect((await query('select * from sync_remote_sessions order by id')).rows.map(({android_control_protocol_version,...row})=>{
        expect(android_control_protocol_version).toBeNull();return row;
      })).toEqual(before);
      expect((await query('select * from sync_device_grants')).rows).toEqual(grants);
      await query(`update sync_remote_sessions set scope='control',protocol_version=2,capabilities='["input-host"]',
        authorization_grant_id=$2,host_endpoint_id='original',android_control_protocol_version=1 where id=$1`,[id,grant]);
      for(const assignment of ['android_control_protocol_version=2',"scope='view'","controller_kind='browser'",'controller_device_id=null',
        'controller_device_id=host_device_id','authorization_grant_id=null','host_endpoint_id=null','protocol_version=1',
        'cli_protocol_version=1','cli_chat_protocol_version=1',"purpose='cli'","capabilities='[]'","capabilities='[\"input-host\",\"access-code\"]'"]) {
        await query('savepoint invalid_android');
        await expect(query(`update sync_remote_sessions set ${assignment} where id=$1`,[id])).rejects.toMatchObject({code:'23514'});
        await query('rollback to savepoint invalid_android');
      }
      await query(`drop schema ${migration} cascade`);
    });
  });
});
