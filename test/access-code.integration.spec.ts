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

const integration=process.env.SYNC_ACCESS_CODE_INTEGRATION_TESTS==='1'?describe:describe.skip;
integration('access-code isolated DB authority, migrations and real lock races',()=>{
  const suffix=randomUUID().replace(/-/g,'');
  const schema=`sync_access_code_${suffix}`;
  const prefix=`sync:test:access-code:${suffix}`;
  const database=new URL(process.env.SYNC_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/sync_test');
  if(decodeURIComponent(database.pathname.slice(1))!=='sync_test' || !['localhost','127.0.0.1','[::1]'].includes(database.hostname)) {
    throw new Error('Access-code integration requires loopback sync_test');
  }
  const redisUrl=new URL(process.env.SYNC_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379');
  if(!['localhost','127.0.0.1','[::1]'].includes(redisUrl.hostname)) throw new Error('Access-code integration requires loopback Redis');
  const administration=new URL(database);administration.searchParams.set('options','-c search_path=pg_catalog');
  database.searchParams.set('options',`-c search_path=${schema}`);database.searchParams.set('application_name',schema);
  const admin=new Pool({connectionString:administration.toString(),max:1,connectionTimeoutMillis:3000});
  const config=new SyncConfigService(loadConfig({NODE_ENV:'test',DATABASE_URL:database.toString(),
    REDIS_URL:redisUrl.toString(),SYNC_REDIS_KEY_PREFIX:prefix,SYNC_PUBLIC_URL:'http://localhost:3053',
    SYNC_AUTH_ISSUER_URL:'http://localhost:3032',SYNC_AUTH_JWKS_URL:'http://localhost:3032/oauth/jwks',
    SYNC_OIDC_CLIENT_ID:'synthetic-test-client',SYNC_OIDC_CLIENT_SECRET:'synthetic-test-secret',
    SYNC_SESSION_ENCRYPTION_KEY:Buffer.alloc(32,17).toString('base64'),SYNC_PIN_PEPPER:'synthetic-test-pepper'}));
  const db=new DatabaseService(config),redis=new RedisService(config),bus=new RevocationBusService();
  const repository=new RemoteSessionRepository(db);
  const sessions=new RemoteSessionService(repository,bus,new RuntimeIdentityService(config));
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
        do {
          const [next,keys]=await redis.client.scan(cursor,'MATCH',`${prefix}:*`,'COUNT',100);cursor=next;
          if(keys.length) await redis.client.del(...keys);
        } while(cursor!=='0');
        await redis.onApplicationShutdown();
      } else redis.client.disconnect();
    } finally {
      await db.onApplicationShutdown();
      try { if(created) await admin.query(`drop schema ${schema} cascade`); } finally { await admin.end(); }
    }
  },15000);

  async function fixture(platform:'macos'|'windows'='macos') {
    const account={id:`access-code-test-${randomUUID()}`,name:'Synthetic Fixture',permission:'member' as const};
    const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),key=pair.publicKey.export({format:'der',type:'spki'});
    const host=await devices.create(account.id,{name:'Synthetic desktop',platform,publicKeyDer:key,protocolVersion:2});
    const controller=await devices.create(account.id,{name:'Synthetic native',platform:'android',publicKeyDer:key,protocolVersion:2});
    const grant=await devices.rememberGrant(account.id,host.id,controller.id,'control');
    const authId=await authSessions.create({token:randomOpaque(48),csrfToken:randomOpaque(),account,platform:'android',
      accessToken:'synthetic-access',refreshToken:'synthetic-refresh',accessTokenExpiresAt:new Date(Date.now()+600000)});
    const auth={databaseId:authId,source:'native' as const,platform:'android' as const,token:'synthetic',csrfHash:'synthetic',account};
    const mode=await modes.set(account,host,{enabled:true,allowBrowser:true,ttlSeconds:300});
    const endpoint={id:randomUUID(),protocolVersion:2,capabilities:['access-code','bounded-lifetime'],cliProtocolVersion:1,cliChatProtocolVersion:1};
    await redis.client.set(redis.key('presence',host.id),JSON.stringify(endpoint),'EX',60);
    const input=async(controllerId=controller.id):Promise<ConnectDeviceDto>=>{
      const challenge=await proofs.challenge(account,controllerId);
      return {protocolVersion:2,purpose:'access-code',scope:'control',capabilities:['access-code','bounded-lifetime'],
        controllerDeviceId:controllerId,challengeId:challenge.id,
        signature:sign('sha256',Buffer.from(deviceProof(controllerId,challenge.id,challenge.nonce)),pair.privateKey).toString('base64')};
    };
    const connect=async()=>service.connect(auth,host.id,await input(),'127.0.0.1');
    return {account,host,controller,grant,auth,mode,endpoint,input,connect,key};
  }

  async function hold(sql:string,params:unknown[]) {
    let reached!:()=>void,release!:()=>void;
    const locked=new Promise<void>(resolve=>{reached=resolve;}),waiting=new Promise<void>(resolve=>{release=resolve;});
    const transaction=db.transaction(async(query)=>{await query(sql,params);reached();await waiting;});
    await Promise.race([locked,transaction.then(()=>{throw new Error('lock not acquired');})]);
    return {release,transaction};
  }
  function liveAuthority(snapshot:RemoteSession) {
    return async()=>{
      const mode=await modes.get(snapshot.ownerAccountId,snapshot.hostId),endpoint=await tickets.activeEndpoint(snapshot.hostId);
      return Boolean(mode?.allowBrowser && mode.epoch===snapshot.epoch && endpoint?.id===snapshot.hostEndpointId && supportsSession(endpoint,snapshot));
    };
  }
  async function waitBlocked() {
    const deadline=Date.now()+3000;
    while(Date.now()<deadline) {
      const blocked=await admin.query(`select 1 from pg_stat_activity where application_name=$1 and cardinality(pg_blocking_pids(pid))>0`,[schema]);
      if(blocked.rowCount) return;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error('Expected actual PostgreSQL lock contention');
  }
  async function rejectWithLock(lock:Awaited<ReturnType<typeof hold>>,start:()=>Promise<unknown>) {
    // Attach rejection immediately; release in finally so failed assertions cannot strand a connection.
    const result=start().then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    try { await waitBlocked(); } finally { lock.release();await lock.transaction; }
    const settled=await result;expect(settled.error).toMatchObject({status:403});
  }

  it('confines all tables, migrations and keys to a fresh schema/prefix',async()=>{
    expect((await db.query('show search_path')).rows[0]!.search_path).toBe(schema);
    expect((await db.query('select max(version) as version from sync_schema_migrations')).rows[0]!.version).toBe(6);
    expect((await db.query('select tablename from pg_tables where schemaname=$1 order by tablename',[schema])).rows.map(row=>row.tablename))
      .toEqual(['sync_access_events','sync_auth_sessions','sync_device_grants','sync_devices','sync_remote_sessions','sync_schema_migrations']);
  });
  it('applies migration6 twice over populated v5 without changing any rows',async()=>{
    await db.transaction(async(query:Query)=>{
      const migration=`${schema}_v5`;await query(`create schema ${migration}`);await query(`set local search_path to ${migration}`);
      await query(SCHEMA_SQL.split('do $$ begin').slice(0,5).join('do $$ begin'));
      const auth=randomUUID(),host=randomUUID(),cliHost=randomUUID(),controller=randomUUID(),grant=randomUUID(),cliGrant=randomUUID(),epoch=randomUUID(),id=randomUUID();
      await query(`insert into sync_auth_sessions(id,token_hash,csrf_hash,account_id,account_name,permission,platform,access_token_encrypted,
        refresh_token_encrypted,access_token_expires_at,expires_at) values($1,'synthetic','synthetic','fixture','Fixture','member','android',
        'synthetic','synthetic',now()+interval '1 hour',now()+interval '1 day')`,[auth]);
      for(const device of [host,cliHost,controller]) await query(`insert into sync_devices(id,owner_account_id,name,platform,public_key_der)
        values($1,'fixture','Preserved','windows',$2)`,[device,Buffer.from('synthetic-key')]);
      await query(`insert into sync_device_grants(id,owner_account_id,host_device_id,controller_device_id,scope) values($1,'fixture',$2,$3,'control')`,[grant,host,controller]);
      await query(`insert into sync_device_grants(id,owner_account_id,host_device_id,controller_device_id,scope) values($1,'fixture',$2,$3,'control')`,[cliGrant,cliHost,controller]);
      await query(`insert into sync_remote_sessions(id,owner_account_id,host_device_id,controller_device_id,controller_kind,scope,mode_epoch,
        auth_session_id,expires_at) values($1,'fixture',$2,$3,'native','control',$4,$5,now()+interval '1 hour')`,[id,host,controller,epoch,auth]);
      await query(`insert into sync_remote_sessions(id,owner_account_id,host_device_id,controller_device_id,controller_kind,scope,mode_epoch,
        auth_session_id,expires_at,purpose,protocol_version,cli_protocol_version,cli_chat_protocol_version,authorization_grant_id,host_endpoint_id)
        values($1,'fixture',$2,$3,'native','control',$4,$5,now()+interval '1 hour','cli',2,1,1,$6,'preserved-endpoint')`,
        [randomUUID(),cliHost,controller,epoch,auth,cliGrant]);
      const before=await query('select * from sync_remote_sessions order by id');
      await query(SCHEMA_SQL);await query(SCHEMA_SQL);
      expect((await query('select * from sync_remote_sessions order by id')).rows).toEqual(before.rows);
      const indices=await query('select indexname,indexdef from pg_indexes where schemaname=$1',[migration]);
      expect(indices.rows.find(row=>row.indexname==='sync_one_controller_per_host_idx')!.indexdef).toContain("purpose <> 'access-code'");
      expect(indices.rows.find(row=>row.indexname==='sync_one_access_code_per_pair_idx')!.indexdef).toContain('host_device_id, controller_device_id');
      for(const assignment of ["purpose='access-code'",`purpose='access-code',protocol_version=2,capabilities='["access-code"]',authorization_grant_id='${grant}',host_endpoint_id='original',scope='view'`]) {
        await query('savepoint invalid_code');
        await expect(query(`update sync_remote_sessions set ${assignment} where id=$1`,[id])).rejects.toMatchObject({code:'23514'});
        await query('rollback to savepoint invalid_code');
      }
      await query(`update sync_remote_sessions set purpose='access-code',protocol_version=2,capabilities='["access-code"]',
        authorization_grant_id=$2,host_endpoint_id='original' where id=$1`,[id,grant]);
      for(const assignment of ["scope='view'","controller_kind='browser'","controller_device_id=null","controller_device_id=host_device_id",
        'authorization_grant_id=null','host_endpoint_id=null','protocol_version=1','cli_protocol_version=1','cli_chat_protocol_version=1',
        "capabilities='[]'","capabilities='[\"access-code\",\"screen-host\"]'"]) {
        await query('savepoint invalid_code');
        await expect(query(`update sync_remote_sessions set ${assignment} where id=$1`,[id])).rejects.toMatchObject({code:'23514'});
        await query('rollback to savepoint invalid_code');
      }
      await query(`drop schema ${migration} cascade`);
    });
  });
  it.each(['macos','windows'] as const)('creates and installs actual %s data-only snapshots with CLI/chat stripped',async(platform)=>{
    const f=await fixture(platform);
    const connected=await service.connect(f.auth,f.host.id,{...await f.input(),cliProtocolVersion:1,cliChatProtocolVersion:1},'127.0.0.1');
    const snapshot=(await sessions.findActive(connected.session.id))!;
    expect(snapshot).toMatchObject({purpose:'access-code',authorizationGrantId:f.grant.id,hostEndpointId:f.endpoint.id,capabilities:['bounded-lifetime','access-code']});
    expect(snapshot).not.toHaveProperty('cliProtocolVersion');expect(snapshot).not.toHaveProperty('cliChatProtocolVersion');
    await expect(sessions.installController(snapshot,()=>true,liveAuthority(snapshot))).resolves.toMatchObject({purpose:'access-code'});
    await expect(sessions.bindHostEndpoint(snapshot,'replacement',()=>true,liveAuthority(snapshot))).resolves.toBeUndefined();
    await expect(sessions.bindHostEndpoint(snapshot,f.endpoint.id,()=>true,liveAuthority(snapshot))).resolves.toMatchObject({id:snapshot.id});
  });
  it('does not create plaintext-code storage, transcript tables or audit payloads',async()=>{
    const f=await fixture(),connected=await f.connect();
    const stored=JSON.parse((await redis.client.get(redis.key('mode',f.host.id)))!);
    expect(stored).toHaveProperty('codeHash');expect(stored).not.toHaveProperty('code');
    const columns=await db.query('select column_name from information_schema.columns where table_schema=$1',[schema]);
    expect(columns.rows.some(row=>['code','access_code','request_body','transcript','messages'].includes(row.column_name))).toBe(false);
    const row=(await db.query('select * from sync_remote_sessions where id=$1',[connected.session.id])).rows[0]!;
    expect(row).not.toHaveProperty('code');expect(row).not.toHaveProperty('requestId');
    const events=await db.query('select metadata from sync_access_events where session_id=$1',[connected.session.id]);
    expect(events.rows.map(event=>event.metadata)).toEqual([{scope:'control',controllerKind:'native'}]);
  });
  it('requires live-authority callbacks at every code-only repository boundary',async()=>{
    const f=await fixture(),connected=await f.connect(),snapshot=(await sessions.findActive(connected.session.id))!;
    const input={...snapshot,controllerDeviceId:snapshot.controllerDeviceId!,hostEndpointId:snapshot.hostEndpointId!,
      authorizationGrantId:snapshot.authorizationGrantId!,expiresAt:new Date(snapshot.expiresAt)};
    await expect(repository.create(input)).rejects.toMatchObject({status:403});
    const install=jest.fn(()=>true);
    await expect(sessions.installController(snapshot,install)).rejects.toMatchObject({status:403});
    await expect(sessions.bindHostEndpoint(snapshot,f.endpoint.id,install)).rejects.toMatchObject({status:403});
    expect(install).not.toHaveBeenCalled();
  });
  it('coexists with ordinary screen/CLI but serializes duplicate code pairs and ordinary hosts',async()=>{
    const f=await fixture();
    const screen=await service.connect(f.auth,f.host.id,{...await f.input(),purpose:'screen'},'127.0.0.1');
    const results=await Promise.allSettled([f.connect(),f.connect()]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
    await expect(service.connect(f.auth,f.host.id,{...await f.input(),purpose:'screen'},'127.0.0.1')).rejects.toMatchObject({status:409});
    const other=await devices.create(f.account.id,{name:'Other native',platform:'ios',publicKeyDer:f.key,protocolVersion:2});
    await devices.rememberGrant(f.account.id,f.host.id,other.id,'control');
    await service.connect(f.auth,f.host.id,await f.input(other.id),'127.0.0.1');
    const active=await sessions.listOwned(f.account.id);expect(active).toHaveLength(3);
    for(const code of active.filter(row=>row.purpose==='access-code')) await sessions.endOwned(f.account.id,code.id,'controller_ended');
    expect((await sessions.findActive(screen.session.id))!.id).toBe(screen.session.id);
    await sessions.endOwned(f.account.id,screen.session.id,'controller_ended');
    const cli=await service.connect(f.auth,f.host.id,{...await f.input(),purpose:'cli',cliProtocolVersion:1},'127.0.0.1');
    await f.connect();expect(await sessions.findActive(cli.session.id)).toBeDefined();
  });
  it.each(['browser','pin','view','view-grant','reverse-grant','self','cross-owner','bad-proof','mobile','allowBrowser'] as const)
  ('rejects actual %s without code rows or PIN consumption',async(kind)=>{
    const f=await fixture();const input=await f.input(),auth={...f.auth};
    if(kind==='browser') Object.assign(auth,{source:'web',platform:'web'});
    if(kind==='pin') input.code=f.mode.code;
    if(kind==='view') input.scope='view';
    if(kind==='view-grant') await db.query("update sync_device_grants set scope='view' where id=$1",[f.grant.id]);
    if(kind==='reverse-grant') { await devices.revokeGrant(f.account.id,f.host.id,f.grant.id);await devices.rememberGrant(f.account.id,f.controller.id,f.host.id,'control'); }
    if(kind==='self') input.controllerDeviceId=f.host.id;
    if(kind==='cross-owner') auth.account={...f.account,id:'unrelated-synthetic-owner'};
    if(kind==='bad-proof') input.signature=Buffer.alloc(64).toString('base64');
    if(kind==='mobile') await db.query("update sync_devices set platform='android' where id=$1",[f.host.id]);
    if(kind==='allowBrowser') await modes.set(f.account,f.host,{enabled:true,allowBrowser:false,ttlSeconds:300});
    const pin=jest.spyOn(modes,'verifyPin');
    try {
      await expect(service.connect(auth,f.host.id,input,'127.0.0.1')).rejects.toMatchObject({status:403});
      expect(pin).not.toHaveBeenCalled();expect(await sessions.listOwned(f.account.id)).toEqual([]);
    } finally { pin.mockRestore(); }
  });
  it.each(['host','controller','auth','grant'] as const)('rechecks %s revocation while create waits on real row locks',async(kind)=>{
    const f=await fixture();const input=await f.input();
    const table=kind==='auth'?'sync_auth_sessions':kind==='grant'?'sync_device_grants':'sync_devices';
    const id=kind==='host'?f.host.id:kind==='controller'?f.controller.id:kind==='auth'?f.auth.databaseId:f.grant.id;
    const lock=await hold(`update ${table} set revoked_at=clock_timestamp() where id=$1`,[id]);
    await rejectWithLock(lock,()=>service.connect(f.auth,f.host.id,input,'127.0.0.1'));
    expect(await sessions.listOwned(f.account.id)).toEqual([]);
  });
  it.each(['install','bind'] as const)('rechecks grant revocation while %s waits on the real grant lock',async(operation)=>{
    const f=await fixture(),connected=await f.connect(),snapshot=(await sessions.findActive(connected.session.id))!;
    const install=jest.fn(()=>true);
    const lock=await hold('update sync_device_grants set revoked_at=clock_timestamp() where id=$1',[f.grant.id]);
    await rejectWithLock(lock,()=>operation==='install'?sessions.installController(snapshot,install,liveAuthority(snapshot)):
      sessions.bindHostEndpoint(snapshot,f.endpoint.id,install,liveAuthority(snapshot)));
    expect(install).not.toHaveBeenCalled();
  });
  it('evaluates expiry after waiting for the remote row lock, not at transaction start',async()=>{
    const f=await fixture(),connected=await f.connect(),snapshot=(await sessions.findActive(connected.session.id))!;
    const install=jest.fn(()=>true);
    const lock=await hold("update sync_remote_sessions set expires_at=clock_timestamp()-interval '1 second' where id=$1",[snapshot.id]);
    await rejectWithLock(lock,()=>sessions.installController(snapshot,install,liveAuthority(snapshot)));expect(install).not.toHaveBeenCalled();
  });
  it.each(['scope','controller','capabilities','purpose'] as const)('refuses forged %s discovery snapshots during install/bind',async(kind)=>{
    const f=await fixture(),connected=await f.connect(),snapshot=(await sessions.findActive(connected.session.id))!;
    if(kind==='scope') snapshot.scope='view';
    if(kind==='controller') snapshot.controllerDeviceId=f.host.id;
    if(kind==='capabilities') snapshot.capabilities=['access-code'];
    if(kind==='purpose') snapshot.purpose='screen';
    const install=jest.fn(()=>true);
    await expect(sessions.installController(snapshot,install,liveAuthority(snapshot))).rejects.toMatchObject({status:403});expect(install).not.toHaveBeenCalled();
    if(kind==='purpose') await expect(sessions.bindHostEndpoint(snapshot,f.endpoint.id,()=>true)).resolves.toBeUndefined();
    else await expect(sessions.bindHostEndpoint(snapshot,f.endpoint.id,()=>true,liveAuthority(snapshot))).rejects.toMatchObject({status:403});
  });
  it.each(['create','install','bind'] as const)('rechecks live allowBrowser inside %s locks after the initial mode snapshot',async(operation)=>{
    const f=await fixture();
    const connected=operation==='create'?undefined:await f.connect();
    const snapshot=connected?(await sessions.findActive(connected.session.id))!:undefined;
    const input=await f.input();
    const install=jest.fn(()=>true);
    const lock=await hold(operation==='create'?'select id from sync_device_grants where id=$1 for update':
      'select id from sync_remote_sessions where id=$1 for update',[snapshot?.id ?? f.grant.id]);
    const pending=(operation==='create'?service.connect(f.auth,f.host.id,input,'127.0.0.1'):
      operation==='install'?sessions.installController(snapshot!,install,liveAuthority(snapshot!)):
      sessions.bindHostEndpoint(snapshot!,f.endpoint.id,install,liveAuthority(snapshot!)))
      .then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    try {
      await waitBlocked();
      const mode=JSON.parse((await redis.client.get(redis.key('mode',f.host.id)))!);
      await redis.client.set(redis.key('mode',f.host.id),JSON.stringify({...mode,allowBrowser:false}),'EX',300);
    } finally { lock.release();await lock.transaction; }
    expect((await pending).error).toMatchObject({status:403});expect(install).not.toHaveBeenCalled();
    if(operation==='create') expect(await sessions.listOwned(f.account.id)).toEqual([]);
  });
  it.each(['mode','endpoint','allowBrowser'] as const)('ends only the new code reservation if %s changes after INSERT',async(kind)=>{
    const f=await fixture();
    const screen=await service.connect(f.auth,f.host.id,{...await f.input(),purpose:'screen'},'127.0.0.1');
    const create=sessions.create.bind(sessions);
    let inserted=false;
    const spy=jest.spyOn(sessions,'create').mockImplementationOnce(async(input,validateAuthority)=>{
      const snapshot=await create(input,validateAuthority);inserted=true;
      if(kind==='endpoint') await redis.client.set(redis.key('presence',f.host.id),JSON.stringify({...f.endpoint,id:randomUUID()}),'EX',60);
      else {
        // Simulate another mode writer's Redis publication before its durable cleanup; same epoch tests the explicit allowBrowser recheck.
        const mode=await redis.client.get(redis.key('mode',f.host.id));
        const current=JSON.parse(mode!);
        await redis.client.set(redis.key('mode',f.host.id),JSON.stringify({...current,...(kind==='mode'?{epoch:randomUUID()}:{allowBrowser:false})}),'EX',300);
      }
      return snapshot;
    });
    try {
      await expect(f.connect()).rejects.toMatchObject({status:403});
      expect(inserted).toBe(true);
      expect((await sessions.listOwned(f.account.id)).map(row=>row.id)).toEqual([screen.session.id]);
    } finally { spy.mockRestore(); }
  });
});
