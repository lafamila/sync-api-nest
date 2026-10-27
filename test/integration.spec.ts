import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { SyncConfigService } from '../src/config/config.service';
import { loadConfig } from '../src/config/app-config';
import { DatabaseService } from '../src/database/database.service';
import { RedisService } from '../src/redis/redis.service';
import { RevocationBusService } from '../src/common/revocation-bus.service';
import { RemoteSessionRepository } from '../src/sessions/remote-session.repository';
import { RemoteSessionService } from '../src/sessions/remote-session.service';
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
  if (!/^sync_test(?:_[A-Za-z0-9_]+)?$/.test(testDatabaseName)) {
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

  it('binds native completion to the initiating app verifier and consumes it once', async()=>{
    const auth={
      assertConfigured:jest.fn(),
      exchangeCode:jest.fn(async()=>({access_token:'provider-access',refresh_token:'provider-refresh',expires_in:900})),
      verifyAccessToken:jest.fn(async()=>({...account,subject:account.id,claims:{}})),
      refresh:jest.fn(async()=>{ await new Promise((resolve)=>setTimeout(resolve,25)); return {access_token:'provider-access-2',refresh_token:'provider-refresh-2',expires_in:900}; }),
      revoke:jest.fn(),
    } as unknown as AuthService;
    const service=new SessionService(configService,redis,auth,sessionRepository,revocations);
    const verifier=randomOpaque(48);
    const started=await service.start({platform:'ios',challenge:sha256(verifier),returnUri:'sync://auth'});
    const state=new URL(started.authorizeUrl).searchParams.get('state')!;
    const callback=await service.callback({code:'authorization-code',state});
    expect(callback).toMatchObject({platform:'ios',transactionId:started.transactionId});
    await expect(service.complete({transactionId:started.transactionId,verifier:'wrong-verifier-that-is-long-enough'})).rejects.toThrow();
    const completed=await service.complete({transactionId:started.transactionId,verifier});
    expect(completed.account).toEqual(account);
    expect(completed.sessionId).not.toContain('provider');
    await db.query(`update sync_auth_sessions set auth_checked_at=now()-interval '1 minute' where token_hash=$1`,[sha256(completed.sessionId)]);
    const secondProcess=new SessionService(configService,redis,auth,sessionRepository,revocations);
    await Promise.all(Array.from({length:8},(_,index)=>(index%2===0?service:secondProcess)
      .requireRequest({headers:{'x-sync-session':completed.sessionId}} as never)));
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    await expect(service.complete({transactionId:started.transactionId,verifier})).rejects.toThrow();
    const stored=await db.query<{access_token_encrypted:string;refresh_token_encrypted:string}>('select access_token_encrypted,refresh_token_encrypted from sync_auth_sessions limit 1');
    expect(stored.rows[0]?.access_token_encrypted).not.toContain('provider-access');
    expect(stored.rows[0]?.refresh_token_encrypted).not.toContain('provider-refresh');
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
      new IceService(configService),redis,authSessions,identity,revocations);
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
