import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { SyncConfigService } from '../src/config/config.service';
import { loadConfig } from '../src/config/app-config';
import { DatabaseService, Query } from '../src/database/database.service';
import { QueryResultRow } from 'pg';
import { RedisService } from '../src/redis/redis.service';
import { RevocationBusService } from '../src/common/revocation-bus.service';
import { RemoteSessionRepository } from '../src/sessions/remote-session.repository';
import { RemoteSessionService } from '../src/sessions/remote-session.service';
import { RemoteSessionController } from '../src/sessions/remote-session.controller';
import { DeviceRepository } from '../src/devices/device.repository';
import { DeviceProofService } from '../src/devices/device-proof.service';
import { ModeService } from '../src/devices/mode.service';
import { TicketService } from '../src/signaling/ticket.service';
import { SessionRepository } from '../src/auth/session.repository';
import { SessionService } from '../src/auth/session.service';
import { AuthService } from '../src/auth/auth.service';
import { randomOpaque, sha256 } from '../src/common/crypto';
import { RequestSecurityService } from '../src/common/request-security.service';
import { IceService } from '../src/ice/ice.service';
import { SignalingService } from '../src/signaling/signaling.service';
import { DeviceService } from '../src/devices/device.service';
import { RuntimeIdentityService } from '../src/runtime/runtime-identity.service';
import { SCHEMA_SQL } from '../src/database/schema';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { SessionGuard } from '../src/auth/session.guard';
import { validateWire } from '../src/generated/sync-wire';

const integration=process.env.SYNC_INTEGRATION_TESTS==='1' ? describe : describe.skip;

integration('PostgreSQL and Redis security integration', () => {
  const prefix=`sync:test:${randomUUID()}`;
  const configService=new SyncConfigService(loadConfig({
    NODE_ENV:'test',
    DATABASE_URL:process.env.SYNC_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/sync_test',
    REDIS_URL:process.env.SYNC_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379',
    SYNC_REDIS_KEY_PREFIX:prefix,
    SYNC_PUBLIC_URL:'http://localhost:3053',
    SYNC_AUTH_ISSUER_URL:'http://localhost:3032', SYNC_AUTH_JWKS_URL:'http://localhost:3032/oauth/jwks',
    SYNC_OIDC_CLIENT_ID:'sync-api',SYNC_OIDC_CLIENT_SECRET:'integration-secret',
    SYNC_SESSION_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),SYNC_PIN_PEPPER:'integration-pin-pepper',
  }));
  const testDatabaseName = decodeURIComponent(new URL(configService.config.databaseUrl).pathname.slice(1));
  if (testDatabaseName !== 'sync_test') {
    throw new Error('Destructive integration fixtures require an isolated sync_test database');
  }
  const db=new DatabaseService(configService);
  const redis=new RedisService(configService);
  const revocations=new RevocationBusService();
  const identity=new RuntimeIdentityService(configService);
  const remoteRepository=new RemoteSessionRepository(db);
  const remoteSessions=new RemoteSessionService(remoteRepository,revocations,identity);
  const devices=new DeviceRepository(db);
  const proofs=new DeviceProofService(configService,redis,devices);
  const modes=new ModeService(configService,redis,remoteSessions);
  const tickets=new TicketService(configService,redis);
  const sessionRepository=new SessionRepository(db,configService);
  const account={id:'account-integration',name:'Integration Owner',permission:'member' as const};

  beforeAll(async()=>{
    await db.onModuleInit(); await redis.onModuleInit(); remoteSessions.onModuleInit();
    await db.query(`truncate sync_access_events,sync_remote_sessions,sync_device_grants,sync_devices,sync_auth_sessions restart identity cascade`);
  });
  afterAll(async()=>{
    await db.query(`truncate sync_access_events,sync_remote_sessions,sync_device_grants,sync_devices,sync_auth_sessions restart identity cascade`);
    await removeFixtureKeys(redis,prefix); remoteSessions.onModuleDestroy();
    await redis.onApplicationShutdown(); await db.onApplicationShutdown();
  });

  it.each(['ios','android','windows'] as const)('binds %s native completion to the initiating app verifier and consumes it once', async(platform)=>{
    const auth={
      assertConfigured:jest.fn(),
      exchangeCode:jest.fn(async()=>({access_token:'provider-access',refresh_token:'provider-refresh',expires_in:900})),
      verifyAccessToken:jest.fn(async()=>({...account,subject:account.id,claims:{}})),
      refresh:jest.fn(async()=>{ await new Promise((resolve)=>setTimeout(resolve,25)); return {access_token:'provider-access-2',refresh_token:'provider-refresh-2',expires_in:900}; }),
      revoke:jest.fn(),
    } as unknown as AuthService;
    const service=new SessionService(configService,redis,auth,sessionRepository,revocations);
    const verifier=randomOpaque(48);
    const started=await service.start({platform,challenge:sha256(verifier),returnUri:'sync://auth'});
    const state=new URL(started.authorizeUrl).searchParams.get('state')!;
    const callback=await service.callback({code:'authorization-code',state});
    expect(callback).toMatchObject({platform,transactionId:started.transactionId});
    const handoffCode=callback.handoffCode!;
    expect(handoffCode).toBeTruthy();
    await expect(service.complete({transactionId:started.transactionId,verifier:'wrong-verifier-that-is-long-enough',handoffCode})).rejects.toThrow();
    await expect(service.complete({transactionId:started.transactionId,verifier,handoffCode:''})).rejects.toThrow();
    await expect(service.complete({transactionId:started.transactionId,verifier,handoffCode:'incorrect-callback-code-that-is-long-enough'})).rejects.toThrow();
    const completed=await service.complete({transactionId:started.transactionId,verifier,handoffCode});
    expect(completed.account).toEqual(account);
    expect(completed.sessionId).not.toContain('provider');
    await db.query(`update sync_auth_sessions set auth_checked_at=now()-interval '1 minute' where token_hash=$1`,[sha256(completed.sessionId)]);
    const secondProcess=new SessionService(configService,redis,auth,sessionRepository,revocations);
    await Promise.all(Array.from({length:8},(_,index)=>(index%2===0?service:secondProcess)
      .requireRequest({headers:{'x-sync-session':completed.sessionId}} as never)));
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    await expect(service.complete({transactionId:started.transactionId,verifier,handoffCode})).rejects.toThrow();
    const stored=await db.query<{access_token_encrypted:string;refresh_token_encrypted:string}>('select access_token_encrypted,refresh_token_encrypted from sync_auth_sessions limit 1');
    expect(stored.rows[0]?.access_token_encrypted).not.toContain('provider-access');
    expect(stored.rows[0]?.refresh_token_encrypted).not.toContain('provider-refresh');
  });

  it('keeps browser and native session credentials in their issued transport', async()=>{
    const webToken=randomOpaque(48);
    const nativeToken=randomOpaque(48);
    for(const [token,platform] of [[webToken,'web'],[nativeToken,'android']] as const) {
      await sessionRepository.create({token,csrfToken:randomOpaque(),account,platform,
        accessToken:'fixture-access',refreshToken:'fixture-refresh',accessTokenExpiresAt:new Date(Date.now()+900_000)});
    }
    await expect(sessionRepository.findByToken(webToken,'web')).resolves.toBeDefined();
    await expect(sessionRepository.findByToken(webToken,'native')).resolves.toBeUndefined();
    await expect(sessionRepository.findByToken(nativeToken,'native')).resolves.toBeDefined();
    await expect(sessionRepository.findByToken(nativeToken,'web')).resolves.toBeUndefined();
  });

  it('applies schema2 additively to a populated v1 schema without changing identity or existing sessions',async()=>{
    await db.transaction(async(query)=>{
      const schema=`sync_migration_${randomUUID().replace(/-/g,'')}`;
      await query(`create schema ${schema}`);
      await query(`set local search_path to ${schema}`);
      await query(SCHEMA_SQL.split('do $$ begin')[0]!);
      const authId=randomUUID(),deviceId=randomUUID(),sessionId=randomUUID(),epoch=randomUUID();
      await query(`insert into sync_auth_sessions(id,token_hash,csrf_hash,account_id,account_name,permission,platform,
        access_token_encrypted,refresh_token_encrypted,access_token_expires_at,expires_at)
        values($1,'preserved-token','csrf','owner','name','member','macos','encrypted-access','encrypted-refresh',now()+interval '1 hour',now()+interval '1 day')`,[authId]);
      await query(`insert into sync_devices(id,owner_account_id,name,platform,public_key_der) values($1,'owner','Original Mac','macos',$2)`,[deviceId,Buffer.from('original-spki')]);
      await query(`insert into sync_remote_sessions(id,owner_account_id,host_device_id,controller_kind,scope,mode_epoch,auth_session_id,expires_at)
        values($1,'owner',$2,'native','control',$3,$4,now()+interval '1 hour')`,[sessionId,deviceId,epoch,authId]);
      await query(SCHEMA_SQL);
      await query(SCHEMA_SQL);
      const device=await query(`select * from sync_devices where id=$1`,[deviceId]);
      expect(device.rows[0]).toMatchObject({name:'Original Mac',platform:'macos',public_key_der:Buffer.from('original-spki'),protocol_version:1,capabilities:[]});
      expect((await query(`select * from sync_remote_sessions where id=$1`,[sessionId])).rows[0])
        .toMatchObject({mode_epoch:epoch,auth_session_id:authId,ended_at:null,protocol_version:1,capabilities:[]});
      expect((await query(`select token_hash,access_token_encrypted from sync_auth_sessions where id=$1`,[authId])).rows[0])
        .toEqual({token_hash:'preserved-token',access_token_encrypted:'encrypted-access'});
      await query(`drop schema ${schema} cascade`);
    });
  });

  it('applies schema3 to populated schema2 without imposing reservation deadlines on existing rows',async()=>{
    await db.transaction(async(query)=>{
      const schema=`sync_migration_${randomUUID().replace(/-/g,'')}`;
      await query(`create schema ${schema}`);
      await query(`set local search_path to ${schema}`);
      const [base,v2]=SCHEMA_SQL.split('do $$ begin');
      await query(`${base}do $$ begin${v2}`);
      expect((await query('select max(version) as version from sync_schema_migrations')).rows[0]!.version).toBe(2);
      const authId=randomUUID(),hostId=randomUUID(),sessionId=randomUUID();
      await query(`insert into sync_auth_sessions(id,token_hash,csrf_hash,account_id,account_name,permission,platform,
        access_token_encrypted,refresh_token_encrypted,access_token_expires_at,expires_at)
        values($1,'preserved-v2-token','csrf','owner','name','member','windows','access','refresh',now()+interval '1 hour',now()+interval '1 day')`,[authId]);
      await query(`insert into sync_devices(id,owner_account_id,name,platform,public_key_der)
        values($1,'owner','Existing native','windows',$2)`,[hostId,Buffer.from('preserved-key')]);
      await query(`insert into sync_remote_sessions(id,owner_account_id,host_device_id,controller_kind,scope,mode_epoch,auth_session_id,expires_at)
        values($1,'owner',$2,'native','control',$3,$4,now()+interval '1 hour')`,[sessionId,hostId,randomUUID(),authId]);
      await query(SCHEMA_SQL);
      await query(SCHEMA_SQL);
      expect((await query('select max(version) as version from sync_schema_migrations')).rows[0]!.version).toBe(3);
      expect((await query('select * from sync_remote_sessions where id=$1',[sessionId])).rows[0])
        .toMatchObject({ended_at:null,connection_deadline:null,connected_at:null,authorization_grant_id:null});
      expect((await query('select public_key_der from sync_devices where id=$1',[hostId])).rows[0]!.public_key_der).toEqual(Buffer.from('preserved-key'));
      await query(`drop schema ${schema} cascade`);
    });
  });

  async function browserFixture(hostProtocol=1) {
    const owner={...account,id:`browser-${randomUUID()}`};
    const host=await devices.create(owner.id,{name:'Desktop',platform:'windows',publicKeyDer:Buffer.from('fixture'),protocolVersion:2,capabilities:['host-displays']});
    const enabled=await modes.set(owner,host,{enabled:true,allowBrowser:true,ttlSeconds:300});
    const authSessionId=await sessionRepository.create({token:randomOpaque(48),csrfToken:randomOpaque(),account:owner,platform:'web',
      accessToken:'fixture-access',refreshToken:'fixture-refresh',accessTokenExpiresAt:new Date(Date.now()+900000)});
    const auth={databaseId:authSessionId,token:'opaque',source:'web' as const,csrfHash:'hash',account:owner,platform:'web' as const};
    await redis.client.set(redis.key('presence',host.id),JSON.stringify({id:randomUUID(),protocolVersion:hostProtocol,capabilities:hostProtocol===2?['host-displays']:[]}),'EX',60);
    const service=new DeviceService(devices,proofs,modes,remoteSessions,tickets,new IceService(configService),redis,revocations,configService);
    const input={scope:'control' as const,code:enabled.code!,protocolVersion:2,capabilities:['viewer-displays' as const]};
    const connected=await service.connect(auth,host.id,input,'127.0.0.1');
    return {owner,host,auth,service,connected,input};
  }

  async function nativeFixture() {
    const owner={...account,id:`native-race-${randomUUID()}`};
    const hostPair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const controllerPair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const host=await registerWithProof(proofs,owner,'Race Host','macos',hostPair);
    const controller=await registerWithProof(proofs,owner,'Race Controller','ios',controllerPair);
    const grant=await devices.rememberGrant(owner.id,host.id,controller.id,'control');
    const mode=await modes.set(owner,host,{enabled:true,allowBrowser:true,ttlSeconds:300});
    const token=randomOpaque(48);
    const authId=await sessionRepository.create({token,csrfToken:randomOpaque(),account:owner,platform:'ios',
      accessToken:'fixture-access',refreshToken:'fixture-refresh',accessTokenExpiresAt:new Date(Date.now()+900000)});
    const auth={databaseId:authId,token,source:'native' as const,csrfHash:'hash',account:owner,platform:'ios' as const};
    await redis.client.set(redis.key('presence',host.id),randomUUID(),'EX',60);
    const service=new DeviceService(devices,proofs,modes,remoteSessions,tickets,new IceService(configService),redis,revocations,configService);
    const connectInput=async()=>{
      const proof=await signedDeviceProof(proofs,owner,controller.id,controllerPair.privateKey);
      return {scope:'control' as const,controllerDeviceId:controller.id,challengeId:proof.challengeId,signature:proof.signature};
    };
    const input=await connectInput();
    const revoke=async(kind:'device'|'grant'|'auth')=>{
      if(kind==='auth') {
        const end=jest.spyOn(remoteSessions,'endForAuthSession');
        const authService=new SessionService(configService,redis,{revoke:jest.fn()} as unknown as AuthService,sessionRepository,revocations);
        try {
          await authService.logout(auth);
          for(const result of end.mock.results) if(result.type==='return') await result.value;
        } finally { end.mockRestore(); }
        return;
      }
      const hostProof=await signedDeviceProof(proofs,owner,host.id,hostPair.privateKey);
      if(kind==='device') await service.remove(auth,controller.id,hostProof);
      else await service.revokeGrant(auth,host.id,grant.id,hostProof);
    };
    return {owner,host,controller,grant,mode,auth,service,input,revoke,connectInput};
  }

  function hostPolicyConfig(env:NodeJS.ProcessEnv) {
    return new SyncConfigService(loadConfig({DATABASE_URL:configService.config.databaseUrl,REDIS_URL:configService.config.redisUrl,...env}));
  }

  function deviceServiceFor(config:SyncConfigService) {
    return new DeviceService(devices,proofs,modes,remoteSessions,tickets,new IceService(config),redis,revocations,config);
  }

  it.each([
    {NODE_ENV:'production'},
    {NODE_ENV:'test',SYNC_REQUIRE_BOUNDED_HOSTS:'true'},
  ])('rejects an unbounded active host before INSERT with $NODE_ENV policy',async(env)=>{
    const f=await nativeFixture();
    // Persisted metadata cannot upgrade an older running socket endpoint.
    await devices.updateCapabilities(f.owner.id,f.host.id,{protocolVersion:2,capabilities:['bounded-lifetime']});
    const config=hostPolicyConfig(env);
    expect(config.config.requireBoundedHosts).toBe(true);
    const create=jest.spyOn(remoteSessions,'create');
    try {
      await expect(deviceServiceFor(config).connect(f.auth,f.host.id,f.input,'127.0.0.1')).rejects.toMatchObject({
        status:426,response:{statusCode:426,error:'host-update-required'},
      });
      expect(create).not.toHaveBeenCalled();
      expect(await remoteSessions.listOwned(f.owner.id)).toEqual([]);
    } finally { create.mockRestore(); }
  });

  it('allows an unchanged native v1 controller on a bounded v2 host under the production default',async()=>{
    const f=await nativeFixture();
    await redis.client.set(redis.key('presence',f.host.id),JSON.stringify({id:randomUUID(),protocolVersion:2,capabilities:['bounded-lifetime']}),'EX',60);
    expect(f.input).not.toHaveProperty('protocolVersion');
    const connected=await deviceServiceFor(hostPolicyConfig({NODE_ENV:'production'})).connect(f.auth,f.host.id,f.input,'127.0.0.1');
    expect(connected.session).toMatchObject({protocolVersion:1,capabilities:[],controllerId:f.controller.id});
    expect(await remoteSessions.findActive(connected.session.id)).toBeDefined();
  });

  it('permits explicit legacy opt-out without claiming the bounded-host policy is enabled',async()=>{
    const f=await nativeFixture();
    const config=hostPolicyConfig({NODE_ENV:'production',SYNC_REQUIRE_BOUNDED_HOSTS:'false'});
    expect(config.config.requireBoundedHosts).toBe(false);
    expect((await deviceServiceFor(config).connect(f.auth,f.host.id,f.input,'127.0.0.1')).session.protocolVersion).toBe(1);
  });

  it('gates recovery before consuming authority or creating a row, then allows media-v1 recovery on an updated host',async()=>{
    const f=await browserFixture();
    const service=deviceServiceFor(hostPolicyConfig({NODE_ENV:'production'}));
    const recover=jest.spyOn(remoteSessions,'recover');
    const input={activityToken:f.connected.webAccess!.activityToken,protocolVersion:2};
    try {
      await expect(service.recover(f.auth,f.connected.session.id,input)).rejects.toMatchObject({status:426,response:{error:'host-update-required'}});
      expect(recover).not.toHaveBeenCalled();
      expect(await remoteSessions.findActive(f.connected.session.id)).toBeDefined();
      await redis.client.set(redis.key('presence',f.host.id),JSON.stringify({id:randomUUID(),protocolVersion:2,capabilities:['bounded-lifetime']}),'EX',60);
      const recovered=await service.recover(f.auth,f.connected.session.id,input);
      expect(recovered.session.protocolVersion).toBe(1);
      expect(recovered.webAccess.idleDeadline).toBe(f.connected.webAccess!.idleDeadline);
    } finally { recover.mockRestore(); }
  });

  it.each(['device','grant','auth'] as const)('rejects native connect when %s revocation wins after proof/trust lookup',async(kind)=>{
    const f=await nativeFixture();
    const reached=deferred(),release=deferred();
    const activeEndpoint=tickets.activeEndpoint.bind(tickets);
    const spy=jest.spyOn(tickets,'activeEndpoint').mockImplementationOnce(async(id)=>{
      reached.resolve(); await release.promise; return activeEndpoint(id);
    });
    const connecting=f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1');
    const result=connecting.then(value=>({value}),error=>({error}));
    try {
      await reached.promise;
      await f.revoke(kind);
      release.resolve();
      expect(await result).toHaveProperty('error');
      expect(await remoteSessions.listOwned(f.owner.id)).toEqual([]);
    } finally { release.resolve(); await result; spy.mockRestore(); }
  });

  it('retains valid native PIN authority independently of a revoked trust grant',async()=>{
    const f=await nativeFixture();
    await f.revoke('grant');
    const connected=await f.service.connect(f.auth,f.host.id,{...f.input,code:f.mode.code!},'127.0.0.1');
    expect(connected.session.scope).toBe('control');
    const snapshot=(await remoteSessions.findActive(connected.session.id))!;
    expect(snapshot.authorizationGrantId).toBeNull();
    await expect(remoteSessions.installController(snapshot,()=>true)).resolves.toMatchObject({id:snapshot.id});
    await remoteSessions.endOwned(f.owner.id,connected.session.id,'revoked');
  });

  it.each(['device','grant','auth'] as const)('serializes %s revocation behind authorized INSERT and then ends the new row',async(kind)=>{
    const f=await nativeFixture();
    const reached=deferred(),release=deferred();
    const create=remoteRepository.create.bind(remoteRepository);
    const spy=jest.spyOn(remoteRepository,'create').mockImplementationOnce((input)=>db.transaction((query)=>
      create(input,holdQuery(query,'insert into sync_remote_sessions',reached,release))));
    const connecting=f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1');
    const result=connecting.then(value=>({value}),error=>({error}));
    let revoking:Promise<void>|undefined;
    try {
      await reached.promise;
      revoking=f.revoke(kind);
      await waitForBlockedQuery(kind==='auth'?'update sync_auth_sessions set revoked_at%':
        kind==='device'?'update sync_devices set revoked_at%':'update sync_device_grants set revoked_at%');
      release.resolve();
      const connected=await result;
      expect(connected).toHaveProperty('value');
      await revoking;
      expect(await remoteSessions.listOwned(f.owner.id)).toEqual([]);
      if('value' in connected) expect(await remoteSessions.findOwned(f.owner.id,connected.value.session.id))
        .toMatchObject({endReason:kind==='auth'?'logout':kind==='device'?'device_revoked':'grant_revoked'});
    } finally { release.resolve(); await result; await revoking; spy.mockRestore(); }
  });

  it('reaps cancelled/quit clients with no controller socket, but preserves installed and legacy native sessions',async()=>{
    const f=await nativeFixture();
    const pending=await f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1');
    const row=(await remoteSessions.findOwned(f.owner.id,pending.session.id))!;
    expect(row.connectedAt).toBeNull();
    expect(Date.parse(row.connectionDeadline!)-Date.parse(row.createdAt)).toBeLessThanOrEqual((configService.config.ticketTtlSeconds+1)*1000);
    expect(Date.parse(row.connectionDeadline!)-Date.parse(row.createdAt)).toBeGreaterThan(0);
    const browser=await browserFixture();
    const installed=(await remoteSessions.findOwned(browser.owner.id,browser.connected.session.id))!;
    let installs=0;
    await remoteSessions.installController(installed,()=>{installs++;return true;});
    expect(installs).toBe(1);
    const legacyHost=await devices.create(f.owner.id,{name:'Preserved v1 native',platform:'macos',publicKeyDer:Buffer.from('fixture')});
    const legacy=await remoteSessions.create({ownerAccountId:f.owner.id,hostId:legacyHost.id,controllerKind:'native',scope:'view',
      epoch:randomUUID(),authSessionId:f.auth.databaseId,expiresAt:new Date(Date.now()+60000)});
    await db.query(`update sync_remote_sessions set connection_deadline=clock_timestamp()-interval '1 second' where id=any($1::uuid[])`,
      [[pending.session.id,installed.id]]);
    expect(await remoteSessions.findActive(pending.session.id)).toBeUndefined();
    await remoteSessions.endExpired();
    expect(await remoteSessions.findOwned(f.owner.id,pending.session.id)).toMatchObject({endReason:'connection_timeout'});
    expect(await remoteSessions.findActive(installed.id)).toMatchObject({id:installed.id,connectedAt:expect.any(String)});
    expect(await remoteSessions.findActive(legacy.id)).toMatchObject({protocolVersion:1,connectionDeadline:null,connectedAt:null});
    const replacement=await f.service.connect(f.auth,f.host.id,await f.connectInput(),'127.0.0.1');
    expect(replacement.session.id).not.toBe(pending.session.id);
  });

  function hostSignalingFixture(f:Awaited<ReturnType<typeof nativeFixture>>) {
    const signaling=new SignalingService(tickets,new RequestSecurityService(configService),devices,remoteSessions,modes,
      new IceService(configService),redis,{revalidateById:async()=>{}} as unknown as SessionService,
      {namespace:identity.namespace,instanceId:randomUUID()} as RuntimeIdentityService,revocations,configService);
    const connection=()=>({id:randomUUID(),ticket:{role:'device' as const,ownerAccountId:f.owner.id,deviceId:f.host.id,
      platform:f.host.platform,authSessionId:f.auth.databaseId},lastPongAt:Date.now(),lastPingAt:0,
      socket:{readyState:WebSocket.OPEN,send:jest.fn(),close:jest.fn()} as unknown as WebSocket});
    const internal=signaling as unknown as {
      registerDevice(peer:ReturnType<typeof connection>):Promise<void>;
      closed(peer:ReturnType<typeof connection>):Promise<void>;
    };
    return {signaling,internal,connection};
  }

  it('does not let delayed old-host disconnect SQL end a fresh replacement-endpoint session',async()=>{
    const f=await nativeFixture();
    const s=hostSignalingFixture(f);
    const old=s.connection(),replacement=s.connection();
    const reached=deferred(),release=deferred();
    let closing:Promise<void>|undefined;
    let dispatch:jest.SpyInstance|undefined;
    try {
      await s.internal.registerDevice(old);
      const transaction=db.transaction.bind(db);
      dispatch=jest.spyOn(db,'transaction').mockImplementationOnce(async(work)=>{
        reached.resolve();await release.promise;
        return transaction(work);
      });
      closing=s.internal.closed(old);
      await reached.promise;
      await s.internal.registerDevice(replacement);
      const fresh=await f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1');
      expect(await remoteSessions.findActive(fresh.session.id)).toMatchObject({hostEndpointId:replacement.id});
      release.resolve();await closing;
      expect(await remoteSessions.findActive(fresh.session.id)).toMatchObject({id:fresh.session.id,hostEndpointId:replacement.id});
      await s.internal.closed(replacement);
      expect(await remoteSessions.findOwned(f.owner.id,fresh.session.id)).toMatchObject({endReason:'device_disconnected'});
    } finally { release.resolve();await closing;dispatch?.mockRestore();await s.signaling.onModuleDestroy(); }
  });

  it.each([null,'previous-endpoint'])('adopts and rebinds a resumed native session with endpoint %s before sending session-start',async(endpoint)=>{
    const f=await nativeFixture();
    const remote=await remoteSessions.create({ownerAccountId:f.owner.id,hostId:f.host.id,controllerDeviceId:f.controller.id,
      controllerKind:'native',scope:'control',epoch:f.mode.mode!.epoch,authSessionId:f.auth.databaseId,
      authorizationGrantId:f.grant.id,expiresAt:new Date(Date.now()+60_000),hostEndpointId:endpoint ?? undefined});
    const s=hostSignalingFixture(f);
    const old=s.connection(),replacement=s.connection();
    try {
      await s.internal.registerDevice(old);
      expect(await remoteSessions.findActive(remote.id)).toMatchObject({hostEndpointId:old.id,expiresAt:remote.expiresAt});
      await s.internal.registerDevice(replacement);
      expect(await remoteSessions.findActive(remote.id)).toMatchObject({hostEndpointId:replacement.id,expiresAt:remote.expiresAt,
        authSessionId:remote.authSessionId,scope:remote.scope,protocolVersion:remote.protocolVersion,capabilities:remote.capabilities});
      expect(replacement.socket.send).toHaveBeenCalledWith(expect.stringContaining('session-start'));
      await s.internal.closed(old);
      expect(await remoteSessions.findActive(remote.id)).toBeDefined();
      await s.internal.closed(replacement);
      expect(await remoteSessions.findOwned(f.owner.id,remote.id)).toMatchObject({endReason:'device_disconnected'});
    } finally { await s.signaling.onModuleDestroy(); }
  });

  it('rejects an expired reservation snapshot after waiting for its row lock without installing it',async()=>{
    const f=await browserFixture();
    const snapshot=(await remoteSessions.findActive(f.connected.session.id))!;
    let installing:Promise<unknown>|undefined;
    let installs=0;
    await db.transaction(async(query)=>{
      await query(`update sync_remote_sessions set connection_deadline=clock_timestamp()+interval '150 milliseconds' where id=$1`,[snapshot.id]);
      installing=remoteSessions.installController(snapshot,()=>{installs++;return true;}).catch(error=>error);
      await waitForBlockedQuery('select id from sync_remote_sessions where id=$1 for update%');
      await query('select pg_sleep(0.2)');
    });
    expect(await installing).toBeInstanceOf(Error);
    expect(installs).toBe(0);
    await remoteSessions.endExpired();
    expect(await remoteSessions.findOwned(f.owner.id,snapshot.id)).toMatchObject({endReason:'connection_timeout',connectedAt:null});
    await expect(f.service.recover(f.auth,snapshot.id,{activityToken:f.connected.webAccess!.activityToken,protocolVersion:2})).rejects.toThrow();
  });

  it('resets only the connection deadline on recovery, preserving browser activity and absolute expiry',async()=>{
    const f=await browserFixture();
    const snapshot=(await remoteSessions.findActive(f.connected.session.id))!;
    await remoteSessions.installController(snapshot,()=>true);
    await db.query(`update sync_remote_sessions set connection_deadline=clock_timestamp()-interval '1 second' where id=$1`,[snapshot.id]);
    await remoteSessions.endIfActive(f.owner.id,snapshot.id,'controller_disconnected');
    const recovered=await f.service.recover(f.auth,snapshot.id,{activityToken:f.connected.webAccess!.activityToken,protocolVersion:2});
    const row=(await remoteSessions.findActive(recovered.session.id))!;
    expect(row).toMatchObject({expiresAt:snapshot.expiresAt,lastActivityAt:snapshot.lastActivityAt,idleDeadline:snapshot.idleDeadline,connectedAt:null});
    expect(Date.parse(row.connectionDeadline!)).toBeGreaterThan(Date.now());
    expect(Date.parse(row.connectionDeadline!)).toBeLessThanOrEqual(Date.now()+configService.config.ticketTtlSeconds*1000);
    expect(recovered.webAccess.idleDeadline).toBe(snapshot.idleDeadline);
  });

  it('rolls back the connected marker when a cancelled/background controller refuses installation',async()=>{
    const f=await nativeFixture();
    const connected=await f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1');
    const snapshot=(await remoteSessions.findActive(connected.session.id))!;
    await expect(remoteSessions.installController(snapshot,()=>false)).rejects.toThrow('closed during controller installation');
    expect(await remoteSessions.findOwned(f.owner.id,snapshot.id)).toMatchObject({connectedAt:null,endedAt:null});
    await db.query(`update sync_remote_sessions set connection_deadline=clock_timestamp()-interval '1 second' where id=$1`,[snapshot.id]);
    await remoteSessions.endExpired();
    expect(await remoteSessions.findOwned(f.owner.id,snapshot.id)).toMatchObject({endReason:'connection_timeout'});
  });

  it('does not reap a verified controller when the timeout sweep waits on its uncommitted installation',async()=>{
    const f=await browserFixture();
    const snapshot=(await remoteSessions.findActive(f.connected.session.id))!;
    await db.query(`update sync_remote_sessions set connection_deadline=clock_timestamp()+interval '300 milliseconds' where id=$1`,[snapshot.id]);
    const reached=deferred(),release=deferred();
    const transaction=db.transaction.bind(db);
    const spy=jest.spyOn(db,'transaction').mockImplementationOnce((work)=>transaction(async(query)=>{
      const result=await work(query);
      reached.resolve();
      await release.promise;
      return result;
    }));
    const installing=remoteSessions.installController(snapshot,()=>true);
    let sweeping:Promise<unknown>|undefined;
    try {
      await reached.promise;
      await db.query('select pg_sleep(0.35)');
      sweeping=remoteSessions.endExpired();
      await waitForBlockedQuery('update sync_remote_sessions set recovery_consumed=true%');
      release.resolve();
      await installing;
      await sweeping;
      expect(await remoteSessions.findActive(snapshot.id)).toMatchObject({connectedAt:expect.any(String),endedAt:null});
      expect((await db.query(`select recovery_consumed,activity_token_hash from sync_remote_sessions where id=$1`,[snapshot.id])).rows[0])
        .toMatchObject({recovery_consumed:false,activity_token_hash:expect.any(String)});
    } finally { release.resolve();await installing;await sweeping;spy.mockRestore(); }
  });

  it.each(['device','grant','auth'] as const)('does not install a previously issued native ticket after %s revocation',async(kind)=>{
    const f=await nativeFixture();
    const result=await f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1');
    const snapshot=(await remoteSessions.findActive(result.session.id))!;
    await f.revoke(kind);
    const install=jest.fn(()=>true);
    await expect(remoteSessions.installController(snapshot,install)).rejects.toThrow();
    expect(install).not.toHaveBeenCalled();
  });

  it.each(['account','source','expiry'] as const)('checks local auth %s under the creation transaction',async(kind)=>{
    const f=await nativeFixture();
    if(kind==='expiry') await db.query(`update sync_auth_sessions set expires_at=clock_timestamp()-interval '1 second' where id=$1`,[f.auth.databaseId]);
    await expect(remoteSessions.create({ownerAccountId:kind==='account'?'another-owner':f.owner.id,hostId:f.host.id,
      controllerDeviceId:f.controller.id,controllerKind:kind==='source'?'browser':'native',scope:'control',
      authorizationGrantId:f.grant.id,epoch:f.mode.mode!.epoch,authSessionId:f.auth.databaseId,
      expiresAt:new Date(Date.now()+60000)})).rejects.toThrow('Local authentication session');
    expect(await remoteSessions.listOwned(f.owner.id)).toEqual([]);
  });

  it('rejects auth expiry after acquiring the auth lock while waiting on a participant lock',async()=>{
    const f=await nativeFixture();
    await db.query(`update sync_auth_sessions set expires_at=clock_timestamp()+interval '200 milliseconds' where id=$1`,[f.auth.databaseId]);
    let connecting:Promise<unknown>|undefined;
    await db.transaction(async(query)=>{
      await query(`select id from sync_devices where id=$1 for update`,[f.host.id]);
      connecting=f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1').catch(error=>error);
      await waitForBlockedQuery('select id from sync_devices where owner_account_id=$1%');
      await query('select pg_sleep(0.25)');
    });
    expect(await connecting).toBeInstanceOf(Error);
    expect(await remoteSessions.listOwned(f.owner.id)).toEqual([]);
  });

  it('waits for the existing auth refresh row lock without acquiring later authorization locks first',async()=>{
    const f=await nativeFixture();
    const reached=deferred(),release=deferred();
    const refreshing=sessionRepository.refreshLocked(f.auth.databaseId,0,async()=>{
      reached.resolve();await release.promise;
      return {accessToken:'fixture-access-2',refreshToken:'fixture-refresh-2',accessTokenExpiresAt:new Date(Date.now()+900000),account:f.owner};
    });
    let connecting:ReturnType<DeviceService['connect']>|undefined;
    try {
      await reached.promise;
      connecting=f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1');
      await waitForBlockedQuery('select id from sync_auth_sessions where id=$1%');
      release.resolve();
      await refreshing;
      expect(await connecting).toMatchObject({session:{hostId:f.host.id}});
    } finally { release.resolve();await refreshing;await connecting; }
  });

  it('rejects local auth expiry while a verified controller waits for the remote-session row lock',async()=>{
    const f=await nativeFixture();
    const connected=await f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1');
    const snapshot=(await remoteSessions.findActive(connected.session.id))!;
    await db.query(`update sync_auth_sessions set expires_at=clock_timestamp()+interval '200 milliseconds' where id=$1`,[f.auth.databaseId]);
    let installing:Promise<unknown>|undefined;
    const install=jest.fn(()=>true);
    await db.transaction(async(query)=>{
      await query(`select id from sync_remote_sessions where id=$1 for update`,[snapshot.id]);
      installing=remoteSessions.installController(snapshot,install).catch(error=>error);
      await waitForBlockedQuery('select id from sync_remote_sessions where id=$1 for update%');
      await query('select pg_sleep(0.25)');
    });
    expect(await installing).toBeInstanceOf(Error);
    expect(install).not.toHaveBeenCalled();
    expect(await remoteSessions.findOwned(f.owner.id,snapshot.id)).toMatchObject({connectedAt:null});
  });

  async function waitForBlockedQuery(pattern:string) {
    const deadline=Date.now()+2000;
    while(Date.now()<deadline) {
      const blocked=await db.query(`select 1 from pg_stat_activity where datname=current_database()
        and pid<>pg_backend_pid() and wait_event_type='Lock' and query like $1`,[pattern]);
      if(blocked.rowCount) return;
      await new Promise((resolve)=>setTimeout(resolve,5));
    }
    throw new Error(`Expected blocked query: ${pattern}`);
  }

  it('requires browser declaration2 while allowing v1 media and preserves deadline through one-use recovery',async()=>{
    const f=await browserFixture(1);
    expect(f.connected.session).toMatchObject({protocolVersion:1,capabilities:[]});
    await expect(f.service.connect(f.auth,f.host.id,{scope:'view',code:f.input.code},'127.0.0.1')).rejects.toThrow('Reload Sync');
    const access=f.connected.webAccess!;
    expect(access.activityToken).toHaveLength(43);
    const stored=await db.query(`select activity_token_hash from sync_remote_sessions where id=$1`,[f.connected.session.id]);
    expect(stored.rows[0]!.activity_token_hash).toBe(sha256(access.activityToken));
    await expect(f.service.webActivity({...f.auth,databaseId:randomUUID()},f.connected.session.id,access.activityToken)).rejects.toThrow();
    await expect(f.service.webActivity(f.auth,f.connected.session.id,randomOpaque(32))).rejects.toThrow();
    const active=await f.service.webActivity(f.auth,f.connected.session.id,access.activityToken);
    await remoteSessions.endOwned(f.owner.id,f.connected.session.id,'controller_disconnected');
    const attempts=await Promise.allSettled(Array.from({length:2},()=>f.service.recover(f.auth,f.connected.session.id,
      {activityToken:access.activityToken,protocolVersion:2,capabilities:['viewer-displays']})));
    expect(attempts.filter((r)=>r.status==='fulfilled')).toHaveLength(1);
    const recovery=attempts.find((r):r is PromiseFulfilledResult<Awaited<ReturnType<DeviceService['recover']>>>=>r.status==='fulfilled')!.value;
    expect(recovery.session.protocolVersion).toBe(1);
    expect(recovery.webAccess).toMatchObject({lastActivityAt:active.lastActivityAt,idleDeadline:active.idleDeadline});
    expect(recovery.webAccess.activityToken).not.toBe(access.activityToken);
    await expect(f.service.webActivity(f.auth,recovery.session.id,access.activityToken)).rejects.toThrow();
  });

  it('ends migrated browser authority without an idle deadline and frees its host without deleting history',async()=>{
    const f=await browserFixture(1);
    const id=f.connected.session.id;
    await db.query(`update sync_remote_sessions set protocol_version=1,last_activity_at=null,
      idle_deadline=null,activity_token_hash=null where id=$1`,[id]);
    await expect(remoteSessions.findActive(id)).resolves.toBeUndefined();

    const ended=await remoteSessions.endExpired();

    expect(ended).toEqual(expect.arrayContaining([expect.objectContaining({id,endReason:'idle_timeout'})]));
    await expect(remoteSessions.findOwned(f.owner.id,id)).resolves.toMatchObject({id,endReason:'idle_timeout'});
    const next=await f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1');
    expect(next.session.id).not.toBe(id);
    expect(next.session.hostId).toBe(f.host.id);
  });

  it('never revives idle authority after expiry or while blocked on a row lock',async()=>{
    const f=await browserFixture(2);
    const id=f.connected.session.id,token=f.connected.webAccess!.activityToken;
    let activity:Promise<unknown>|undefined;
    await db.transaction(async(query)=>{
      await query(`update sync_remote_sessions set idle_deadline=clock_timestamp()+interval '150 milliseconds' where id=$1`,[id]);
      activity=f.service.webActivity(f.auth,id,token);
      await query('select pg_sleep(0.25)');
    });
    await expect(activity).rejects.toThrow();
    await remoteSessions.endExpired();
    await expect(f.service.recover(f.auth,id,{activityToken:token,protocolVersion:2,capabilities:['viewer-displays']})).rejects.toThrow();
    expect(await remoteSessions.findOwned(f.owner.id,id)).toMatchObject({endReason:'idle_timeout'});
  });

  it('serves the exact browser activity/recovery routes and response contract through HTTP',async()=>{
    const f=await browserFixture(1);
    const module=await Test.createTestingModule({controllers:[RemoteSessionController],providers:[
      {provide:RemoteSessionService,useValue:{}},{provide:DeviceProofService,useValue:proofs},
      {provide:RequestSecurityService,useValue:{assertMutation:jest.fn()}},{provide:DeviceService,useValue:f.service},
    ]}).overrideGuard(SessionGuard).useValue({canActivate:(context:{switchToHttp():{getRequest():{syncSession:unknown}}})=>{
      context.switchToHttp().getRequest().syncSession=f.auth;return true;
    }}).compile();
    const app=module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));
    await app.init();
    try {
      const token=f.connected.webAccess!.activityToken;
      const activity=await request(app.getHttpServer()).post(`/api/sessions/${f.connected.session.id}/activity`).send({activityToken:token}).expect(201);
      expect(validateWire('WireBrowserActivityState',activity.body)).toBe(true);
      await request(app.getHttpServer()).post(`/api/sessions/${f.connected.session.id}/activity`).send({activityToken:token,deadline:'2099-01-01'}).expect(400);
      const recovery=await request(app.getHttpServer()).post(`/api/sessions/${f.connected.session.id}/recover`)
        .send({activityToken:token,protocolVersion:2,capabilities:['viewer-displays']}).expect(201);
      expect(validateWire('WireConnectResult',recovery.body)).toBe(true);
      expect(recovery.body.session.protocolVersion).toBe(1);
      expect(recovery.body.webAccess.idleDeadline).toBe(activity.body.idleDeadline);
      await request(app.getHttpServer()).post(`/api/sessions/${f.connected.session.id}/recover`)
        .send({activityToken:token,protocolVersion:2,capabilities:['viewer-displays']}).expect(403);
    } finally { await app.close(); }
  });

  it('invalidates disconnected recovery authority on mode disable and explicit revoke',async()=>{
    for(const reason of ['revoked','mode_disabled']) {
      const f=await browserFixture();
      const id=f.connected.session.id;
      await remoteSessions.endOwned(f.owner.id,id,'controller_disconnected');
      await remoteSessions.endOwned(f.owner.id,id,reason);
      await expect(f.service.recover(f.auth,id,{activityToken:f.connected.webAccess!.activityToken,protocolVersion:2,capabilities:[]})).rejects.toThrow();
    }
  });

  it('keeps mobile hosts view-only with no PIN and allows Windows desktop modes',async()=>{
    const owner={...account,id:`mobile-${randomUUID()}`};
    const android=await devices.create(owner.id,{name:'Android',platform:'android',publicKeyDer:Buffer.from('fixture')});
    expect(await modes.set(owner,android,{enabled:true,allowBrowser:false,ttlSeconds:300})).not.toHaveProperty('code');
    await expect(modes.set(owner,android,{enabled:true,allowBrowser:true})).rejects.toThrow('desktop-only');
    const f=await browserFixture();
    await expect(f.service.connect({...f.auth,account:owner},android.id,{scope:'control',protocolVersion:2},'127.0.0.1')).rejects.toThrow('view-only');
  });

  it('bounds login initiation per client before allocating transactions', async()=>{
    const service=new SessionService(configService,redis,{} as AuthService,sessionRepository,revocations);
    const address=`fixture-${randomUUID()}`;
    for(let count=0;count<configService.config.loginRatePerIp;count++) await service.assertStartAllowed(address);
    await expect(service.assertStartAllowed(address)).rejects.toThrow('Too many login attempts');
  });

  it('verifies P-256 SPKI registration, consumes nonce once, and enforces ownership', async()=>{
    const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const publicKey=pair.publicKey.export({format:'der',type:'spki'});
    const challenge=await proofs.challenge(account);
    const signature=sign('sha256',Buffer.from(`sync:register:${challenge.id}:${challenge.nonce}`),pair.privateKey).toString('base64');
    const input={name:'Test Mac',platform:'macos' as const,publicKey:publicKey.toString('base64'),challengeId:challenge.id,signature};
    const device=await proofs.register(account,input);
    expect(device.platform).toBe('macos');
    await expect(proofs.register(account,input)).rejects.toThrow('already used');
    await expect(devices.findOwned('different-owner',device.id)).resolves.toBeUndefined();
  });

  it('requires same-device owner proof for capability changes, consumes it once, and leaves sessions immutable',async()=>{
    const owner={...account,id:`capabilities-${randomUUID()}`};
    const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const host=await registerWithProof(proofs,owner,'Upgraded Native','macos',pair);
    const other=await devices.create(owner.id,{name:'Other',platform:'windows',publicKeyDer:Buffer.from('fixture')});
    const authId=await sessionRepository.create({token:randomOpaque(48),csrfToken:randomOpaque(),account:owner,platform:'windows',
      accessToken:'access',refreshToken:'refresh',accessTokenExpiresAt:new Date(Date.now()+900000)});
    const auth={databaseId:authId,token:'opaque',source:'native' as const,csrfHash:'hash',account:owner,platform:'windows' as const};
    const remote=await remoteSessions.create({ownerAccountId:owner.id,hostId:host.id,controllerKind:'native',scope:'view',
      epoch:randomUUID(),authSessionId:authId,expiresAt:new Date(Date.now()+60000)});
    const service=new DeviceService(devices,proofs,modes,remoteSessions,tickets,new IceService(configService),redis,revocations,configService);
    const proof=await signedDeviceProof(proofs,owner,host.id,pair.privateKey);
    const input={...proof,protocolVersion:2,clientVersion:'2.0.0',capabilities:['host-displays' as const]};
    await expect(service.updateCapabilities(auth,other.id,input)).rejects.toThrow('does not match');
    await expect(service.updateCapabilities({...auth,account:{...owner,id:'different-owner'}},host.id,input)).rejects.toThrow();
    await expect(service.updateCapabilities(auth,host.id,input)).resolves.toMatchObject({device:{protocolVersion:2,capabilities:['host-displays']}});
    await expect(service.updateCapabilities(auth,host.id,input)).rejects.toThrow('already used');
    expect(await remoteSessions.findActive(remote.id)).toMatchObject({protocolVersion:1,capabilities:[]});
    await redis.client.set(redis.key('presence',host.id),randomUUID(),'EX',60);
    expect(await tickets.activeEndpoint(host.id)).toMatchObject({protocolVersion:1,capabilities:[]});
  });

  it('permits three distinct hosts per controller while preserving the unique host constraint and host-only disconnect',async()=>{
    const owner={...account,id:`multi-${randomUUID()}`};
    const controller=await devices.create(owner.id,{name:'Controller',platform:'windows',publicKeyDer:Buffer.from('fixture')});
    const authId=await sessionRepository.create({token:randomOpaque(48),csrfToken:randomOpaque(),account:owner,platform:'windows',
      accessToken:'access',refreshToken:'refresh',accessTokenExpiresAt:new Date(Date.now()+900000)});
    const hosts=await Promise.all(Array.from({length:3},(_,i)=>devices.create(owner.id,{name:`Host ${i}`,platform:'macos',publicKeyDer:Buffer.from('fixture')})));
    const sessions=await Promise.all(hosts.map((host)=>remoteSessions.create({ownerAccountId:owner.id,hostId:host.id,controllerDeviceId:controller.id,
      controllerKind:'native',scope:'control',epoch:randomUUID(),authSessionId:authId,expiresAt:new Date(Date.now()+60000)})));
    await expect(remoteSessions.create({ownerAccountId:owner.id,hostId:hosts[0]!.id,controllerDeviceId:controller.id,
      controllerKind:'native',scope:'view',epoch:randomUUID(),authSessionId:authId,expiresAt:new Date(Date.now()+60000)})).rejects.toThrow('Host already has an active controller');
    await remoteSessions.endForHost(controller.id,'device_disconnected');
    await remoteSessions.endExpired();
    expect(await remoteSessions.listOwned(owner.id)).toHaveLength(3);
    await remoteSessions.endOwned(owner.id,sessions[0]!.id,'revoked');
    expect(await remoteSessions.listOwned(owner.id)).toHaveLength(2);
    await remoteSessions.endForDevice(controller.id,'device_revoked');
    expect(await remoteSessions.listOwned(owner.id)).toEqual([]);
  });

  it('atomically locks a mode after five PIN failures and permits a fresh epoch', async()=>{
    const host=(await devices.listOwned(account.id))[0]!;
    const enabled=await modes.set(account,host,{enabled:true,allowBrowser:true,ttlSeconds:300});
    expect(enabled.code).toMatch(/^\d{6}$/);
    for(let attempt=1;attempt<=5;attempt++) await expect(modes.verifyPin(account,host.id,'000000','203.0.113.4')).rejects.toThrow();
    await expect(modes.get(account.id,host.id)).resolves.toBeNull();
    const replacement=await modes.set(account,host,{enabled:true,allowBrowser:true,ttlSeconds:300});
    await expect(modes.verifyPin(account,host.id,replacement.code!,'203.0.113.4')).resolves.toMatchObject({epoch:replacement.mode!.epoch});
  });

  it('creates durable trust only from an explicit host-key approval', async()=>{
    const hostPair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const controllerPair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const host=await registerWithProof(proofs,account,'Approval Host','macos',hostPair);
    const controller=await registerWithProof(proofs,account,'Approval Controller','ios',controllerPair);
    const hostChallenge=await proofs.challenge(account,host.id);
    const hostSignature=sign('sha256',Buffer.from(`sync:device:${host.id}:${hostChallenge.id}:${hostChallenge.nonce}`),hostPair.privateKey).toString('base64');
    const service=new DeviceService(devices,proofs,modes,remoteSessions,tickets,new IceService(configService),redis,revocations,configService);
    const nativeSession={databaseId:randomUUID(),token:'opaque',source:'native' as const,csrfHash:'hash',account,platform:'macos' as const};
    await expect(service.approveGrant(nativeSession,host.id,{deviceId:host.id,challengeId:hostChallenge.id,
      signature:hostSignature,controllerDeviceId:controller.id})).resolves.toMatchObject({grant:{controllerDeviceId:controller.id}});
    await expect(devices.findGrant(account.id,host.id,controller.id)).resolves.toMatchObject({scope:'control'});
    await expect(service.connect(nativeSession,host.id,{scope:'control',rememberDevice:true},'127.0.0.1'))
      .rejects.toThrow('rememberDevice cannot create trust');
    await modes.set(account,host,{enabled:true,allowBrowser:false,ttlSeconds:300});
    const trustedChallenge=await proofs.challenge(account,controller.id);
    const trustedSignature=sign('sha256',Buffer.from(`sync:device:${controller.id}:${trustedChallenge.id}:${trustedChallenge.nonce}`),controllerPair.privateKey).toString('base64');
    await expect(service.connect(nativeSession,host.id,{scope:'control',controllerDeviceId:controller.id,
      challengeId:trustedChallenge.id,signature:trustedSignature},'127.0.0.1')).rejects.toThrow('Host device is offline');
    const untrustedPair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const untrusted=await registerWithProof(proofs,account,'Untrusted Controller','ios',untrustedPair);
    const untrustedChallenge=await proofs.challenge(account,untrusted.id);
    const untrustedSignature=sign('sha256',Buffer.from(`sync:device:${untrusted.id}:${untrustedChallenge.id}:${untrustedChallenge.nonce}`),untrustedPair.privateKey).toString('base64');
    await expect(service.connect(nativeSession,host.id,{scope:'control',controllerDeviceId:untrusted.id,code:'123456',
      challengeId:untrustedChallenge.id,signature:untrustedSignature},'127.0.0.1'))
      .rejects.toThrow('Untrusted temporary connections are disabled');
  });

  it('lets an active owned actor revoke a lost target but rejects cross-owner and revoked actors', async()=>{
    const actorPair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const targetPair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const actor=await registerWithProof(proofs,account,'Revocation Actor','macos',actorPair);
    const target=await registerWithProof(proofs,account,'Lost Device','ios',targetPair);
    const service=new DeviceService(devices,proofs,modes,remoteSessions,tickets,new IceService(configService),redis,revocations,configService);
    const nativeSession={databaseId:randomUUID(),token:'opaque',source:'native' as const,csrfHash:'hash',account,platform:'macos' as const};
    const actorProof=await signedDeviceProof(proofs,account,actor.id,actorPair.privateKey);
    await expect(service.remove(nativeSession,target.id,actorProof)).resolves.toEqual({ok:true});
    await expect(devices.findOwned(account.id,target.id)).resolves.toBeUndefined();
    await expect(devices.findOwned(account.id,actor.id)).resolves.toBeDefined();

    const otherTarget=await devices.create('another-account',{name:'Other Owner',platform:'ios',publicKeyDer:Buffer.from('fixture')});
    const crossOwnerProof=await signedDeviceProof(proofs,account,actor.id,actorPair.privateKey);
    await expect(service.remove(nativeSession,otherTarget.id,crossOwnerProof)).rejects.toThrow('Device not found');
    await expect(devices.findOwned('another-account',otherTarget.id)).resolves.toBeDefined();

    const revokedPair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const revokedActor=await registerWithProof(proofs,account,'Soon Revoked','macos',revokedPair);
    const remaining=await registerWithProof(proofs,account,'Remaining Device','ios',generateKeyPairSync('ec',{namedCurve:'prime256v1'}));
    const staleProof=await signedDeviceProof(proofs,account,revokedActor.id,revokedPair.privateKey);
    await devices.revoke(account.id,revokedActor.id);
    await expect(service.remove(nativeSession,remaining.id,staleProof)).rejects.toThrow('Device not found');
    await expect(devices.findOwned(account.id,remaining.id)).resolves.toBeDefined();
  });

  it('consumes signaling tickets exactly once without global Redis cleanup', async()=>{
    const ticket=await tickets.issue({role:'device',ownerAccountId:account.id,deviceId:randomUUID(),platform:'macos',authSessionId:randomUUID()});
    await expect(tickets.consume(ticket)).resolves.toMatchObject({role:'device',ownerAccountId:account.id});
    await expect(tickets.consume(ticket)).rejects.toThrow('already used');
  });

  it('lists only live owned sessions after mode-off or controller disconnect', async()=>{
    const owner={...account,id:`session-list-${randomUUID()}`};
    const authSessionId=await sessionRepository.create({token:randomOpaque(48),csrfToken:randomOpaque(),account:owner,platform:'web',
      accessToken:'fixture-access',refreshToken:'fixture-refresh',accessTokenExpiresAt:new Date(Date.now()+900_000)});
    async function createSession(ownerId:string,expiresAt:Date) {
      const host=await devices.create(ownerId,{name:'Session list host',platform:'macos',publicKeyDer:Buffer.from('fixture')});
      const authId=ownerId===owner.id?authSessionId:await sessionRepository.create({token:randomOpaque(48),csrfToken:randomOpaque(),
        account:{...owner,id:ownerId},platform:'web',accessToken:'fixture-access',refreshToken:'fixture-refresh',
        accessTokenExpiresAt:new Date(Date.now()+900_000)});
      return remoteSessions.create({ownerAccountId:ownerId,hostId:host.id,controllerKind:'browser',scope:'control',
        epoch:randomUUID(),authSessionId:authId,expiresAt});
    }
    const active=await createSession(owner.id,new Date(Date.now()+120_000));
    const ended=await createSession(owner.id,new Date(Date.now()+120_000));
    const expired=await createSession(owner.id,new Date(Date.now()-1_000));
    await createSession('other-session-list-owner',new Date(Date.now()+120_000));
    await remoteSessions.endOwned(owner.id,ended.id,'controller_disconnected');
    const controller=new RemoteSessionController(remoteSessions,proofs,{} as never);
    const request={syncSession:{account:owner}} as never;
    expect((await controller.list(request)).sessions.map((session)=>session.id)).toEqual([active.id]);

    // Expiry must be filtered even before the maintenance sweep persists ended_at.
    expect((await remoteSessions.findOwned(owner.id,expired.id))?.endedAt).toBeNull();
    const host=(await devices.findOwned(owner.id,active.hostId))!;
    await modes.set(owner,host,{enabled:false,allowBrowser:false});
    await expect(controller.list(request)).resolves.toEqual({sessions:[]});
    const originalEnd=await remoteSessions.findOwned(owner.id,ended.id);
    await expect(remoteSessions.endOwned(owner.id,ended.id,'revoked')).resolves.toEqual(originalEnd);
  });

  it('routes only valid signaling roles and replaces host sockets without stale offline cleanup', async()=>{
    const host=await devices.create(account.id,{name:'Socket Mac',platform:'macos',publicKeyDer:Buffer.from('fixture')});
    const mode=await modes.set(account,host,{enabled:true,allowBrowser:true,ttlSeconds:300});
    const authToken=randomOpaque(48); const csrf=randomOpaque();
    const authSessionId=await sessionRepository.create({token:authToken,csrfToken:csrf,account,platform:'web',
      accessToken:'access',refreshToken:'refresh',accessTokenExpiresAt:new Date(Date.now()+900_000)});
    const remote=await remoteSessions.create({ownerAccountId:account.id,hostId:host.id,controllerKind:'browser',scope:'control',
      epoch:mode.mode!.epoch,authSessionId,expiresAt:new Date(Date.now()+120_000)});
    const authService={refresh:jest.fn(),verifyAccessToken:jest.fn()} as unknown as AuthService;
    const authSessions=new SessionService(configService,redis,authService,sessionRepository,revocations);
    const signaling=new SignalingService(tickets,new RequestSecurityService(configService),devices,remoteSessions,modes,
      new IceService(configService),redis,authSessions,identity,revocations,configService);
    const server=createServer(); signaling.attach(server);
    await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
    const port=(server.address() as AddressInfo).port;
    const hostTicket=await tickets.issue({role:'device',ownerAccountId:account.id,deviceId:host.id,platform:'macos',authSessionId});
    const controllerTicket=await tickets.issue({role:'controller',ownerAccountId:account.id,sessionId:remote.id,browser:true,authSessionId});
    const hostSocket=new WebSocket(`ws://127.0.0.1:${port}/api/signaling?ticket=${hostTicket}`);
    const hostReady=nextJson(hostSocket,(value)=>value.type==='ready');
    await opened(hostSocket); await hostReady;
    const controller=new WebSocket(`ws://127.0.0.1:${port}/api/signaling?ticket=${controllerTicket}`,{origin:'http://localhost:3053'});
    const controllerReady=nextJson(controller,(value)=>value.type==='ready');
    await opened(controller); await controllerReady;

    const replacementTicket=await tickets.issue({role:'device',ownerAccountId:account.id,deviceId:host.id,platform:'macos',authSessionId});
    const replaced=closed(hostSocket);
    const replacement=new WebSocket(`ws://127.0.0.1:${port}/api/signaling?ticket=${replacementTicket}`);
    const replacementReady=nextJson(replacement,(value)=>value.type==='ready');
    await opened(replacement); await replacementReady;
    await expect(replaced).resolves.toMatchObject({code:4001});
    expect(await redis.client.get(redis.key('presence',host.id))).toBeTruthy();
    await expect(remoteSessions.findActive(remote.id)).resolves.toBeDefined();

    const relayed=nextJson(replacement,(value)=>value.type==='offer');
    controller.send(JSON.stringify({type:'offer',sessionId:remote.id,sdp:'v=0\r\n'}));
    await expect(relayed).resolves.toMatchObject({type:'offer',sessionId:remote.id,sdp:'v=0\r\n'});
    const denied=closed(controller);
    controller.send(JSON.stringify({type:'answer',sessionId:remote.id,sdp:'v=0\r\n'}));
    await expect(denied).resolves.toMatchObject({code:1008});

    const replay=new WebSocket(`ws://127.0.0.1:${port}/api/signaling?ticket=${hostTicket}`);
    await expect(closed(replay)).resolves.toMatchObject({code:1008});
    await signaling.onModuleDestroy();
    await new Promise<void>((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));
  });
});

async function removeFixtureKeys(redis:RedisService,prefix:string):Promise<void> {
  let cursor='0';
  do {
    const [next,keys]=await redis.client.scan(cursor,'MATCH',`${prefix}:*`,'COUNT',100);
    cursor=next;
    if(keys.length) await redis.client.unlink(...keys);
  } while(cursor!=='0');
}

function deferred() {
  let resolve!:()=>void;
  const promise=new Promise<void>((done)=>{resolve=done;});
  return {promise,resolve};
}

function holdQuery(query:Query,prefix:string,reached:ReturnType<typeof deferred>,release:ReturnType<typeof deferred>):Query {
  return async <T extends QueryResultRow=QueryResultRow>(sql:string,params?:readonly unknown[])=>{
    if(sql.trimStart().startsWith(prefix)) { reached.resolve();await release.promise; }
    return query<T>(sql,params);
  };
}

function opened(socket:WebSocket):Promise<void> {
  return new Promise((resolve,reject)=>{ socket.once('open',resolve); socket.once('error',reject); });
}

function closed(socket:WebSocket):Promise<{code:number;reason:string}> {
  return new Promise((resolve)=>socket.once('close',(code,reason)=>resolve({code,reason:reason.toString()})));
}

function nextJson(socket:WebSocket,predicate:(value:Record<string,unknown>)=>boolean):Promise<Record<string,unknown>> {
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{ socket.off('message',listener); reject(new Error('Timed out waiting for WebSocket message')); },2_000);
    const listener=(data:import('ws').RawData)=>{
      const value=JSON.parse(data.toString()) as Record<string,unknown>;
      if(!predicate(value)) return;
      clearTimeout(timeout); socket.off('message',listener); resolve(value);
    };
    socket.on('message',listener);
  });
}

async function registerWithProof(
  proofs:DeviceProofService,
  account:{id:string;name:string;permission:'member'},
  name:string,
  platform:'macos'|'ios',
  pair:ReturnType<typeof generateKeyPairSync>,
) {
  const challenge=await proofs.challenge(account);
  const signature=sign('sha256',Buffer.from(`sync:register:${challenge.id}:${challenge.nonce}`),pair.privateKey).toString('base64');
  return proofs.register(account,{name,platform,publicKey:pair.publicKey.export({format:'der',type:'spki'}).toString('base64'),challengeId:challenge.id,signature});
}

async function signedDeviceProof(
  proofs:DeviceProofService,
  account:{id:string;name:string;permission:'member'},
  deviceId:string,
  privateKey:ReturnType<typeof generateKeyPairSync>['privateKey'],
) {
  const challenge=await proofs.challenge(account,deviceId);
  return {deviceId,challengeId:challenge.id,
    signature:sign('sha256',Buffer.from(`sync:device:${deviceId}:${challenge.id}:${challenge.nonce}`),privateKey).toString('base64')};
}
