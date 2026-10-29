import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import pg from 'pg';
import Redis from 'ioredis';
import playwright from '../../web/node_modules/playwright/index.js';
import { HostFixtureServer } from './host-fixture.mjs';
import { OidcFixture } from './oidc-fixture.mjs';

const {SYNC_PROTOCOL_VERSION,validateWire}=createRequire(import.meta.url)('../../dist/generated/sync-wire.js');
const HOST_FEATURES={protocolVersion:SYNC_PROTOCOL_VERSION,capabilities:['screen-host','input-host','host-displays','mode-duration','bounded-lifetime']};
const CONTROLLER_FEATURES={protocolVersion:SYNC_PROTOCOL_VERSION,capabilities:['viewer-displays']};
const CONNECTION_TIMEOUT_SECONDS=10;
const IDLE_TIMEOUT_SECONDS=60;

const {Pool}=pg;
const {chromium}=playwright;
const ROOT=resolve(import.meta.dirname,'../..');
const ARTIFACTS=resolve(import.meta.dirname,'artifacts');
const runId=randomUUID();
const accountId=`sync-system-${runId}`;
const redisPrefix=`sync:test:system:${runId}`;
const clientId='sync-system-fixture';
const clientSecret=opaque(32);
const sessionEncryptionKey=randomBytes(32).toString('base64');
const pinPepper=opaque(48);
const fileEnv=await readEnv(resolve(ROOT,'.env'));
const databaseUrl=process.env.SYNC_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/sync_test';
const redisUrl=process.env.SYNC_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
assert.equal(new URL(databaseUrl).pathname,'/sync_test','System test may only use sync_test');
for(const value of [databaseUrl,redisUrl]) assert(['localhost','127.0.0.1','[::1]'].includes(new URL(value).hostname),'System dependencies must be local');
const turnUrls=process.env.SYNC_TEST_TURN_URLS ?? fileEnv.SYNC_TURN_URLS;
const turnSecret=process.env.SYNC_TEST_TURN_SECRET ?? fileEnv.SYNC_TURN_SECRET;
assert(turnUrls && turnSecret,'System test requires configured local SYNC_TURN_URLS and SYNC_TURN_SECRET');

await mkdir(ARTIFACTS,{recursive:true});
const pool=new Pool({connectionString:databaseUrl});
const redis=new Redis(redisUrl,{lazyConnect:true,maxRetriesPerRequest:2});
let oidc;
let hostServer;
let apiProcess;
let browser;
let releaseRecovery;
const contexts=[];
const metadata={runId,startedAt:new Date().toISOString(),loginCsrf:false,http:null,hidden:null,direct:null,restart:null,relay:null,refreshRotations:0,status:'running'};

try {
  assert.equal((await pool.query('select current_database() as name')).rows[0].name,'sync_test');
  await redis.connect();
  oidc=await new OidcFixture({accountId,clientId,clientSecret}).start();
  hostServer=await new HostFixtureServer().start();
  const apiPort=await freePort();
  const apiBase=`http://127.0.0.1:${apiPort}`;
  apiProcess=startApi({apiPort,apiBase,oidc});
  await waitForApi(apiBase,apiProcess);
  await verifyProductionSurface(apiBase);
  await verifyLoginCsrfBinding(apiBase);
  metadata.loginCsrf=true;

  const native=await nativeLogin(apiBase);
  const host=await registerDevice(apiBase,native,'System Host','macos',HOST_FEATURES);
  const controller=await registerDevice(apiBase,native,'System Controller','ios',CONTROLLER_FEATURES);
  const mode=await apiJson(apiBase,`/api/devices/${host.id}/mode`,{
    method:'POST',session:native.sessionId,body:{...await deviceProof(apiBase,native,host),enabled:true,allowBrowser:true,ttlSeconds:300},
  });
  assert.match(mode.code,/^\d{6}$/);
  await apiJson(apiBase,`/api/devices/${host.id}/grants`,{
    method:'POST',session:native.sessionId,body:{...await deviceProof(apiBase,native,host),controllerDeviceId:controller.id},
  });

  browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--no-sandbox']});
  const directHost=await openHost(browser,hostServer,apiBase,
    await issueHostTicket(apiBase,native,host),false,contexts);

  const controllerProof=await deviceProof(apiBase,native,controller);
  const trusted=await apiJson(apiBase,`/api/devices/${host.id}/connect`,{
    method:'POST',session:native.sessionId,
    body:{scope:'control',controllerDeviceId:controller.id,challengeId:controllerProof.challengeId,signature:controllerProof.signature,...CONTROLLER_FEATURES},
  });
  assert(typeof trusted.ticket==='string' && trusted.ticket.length>20,'Trusted native connect did not issue a ticket');
  assertV2(trusted);
  await apiJson(apiBase,`/api/sessions/${trusted.session.id}`,{
    method:'DELETE',session:native.sessionId,body:await deviceProof(apiBase,native,controller),
  });

  metadata.http=await verifyHttpContract({browser,apiBase,host,code:mode.code,contexts});
  const direct=await runBrowserScenario({browser,apiBase,host,code:mode.code,hostPage:directHost.page,
    forceRelay:false,screenshot:resolve(ARTIFACTS,'direct.png'),contexts});
  assert.notEqual(direct.controllerCandidate.local,'relay','Direct controller unexpectedly selected relay');
  assert.notEqual(direct.hostCandidate.local,'relay','Direct host unexpectedly selected relay');
  metadata.direct={controllerCandidate:direct.controllerCandidate,hostCandidate:direct.hostCandidate,pixels:direct.pixels};
  metadata.hidden=await verifyHiddenRecovery(direct,directHost.page);
  const crashedSession=await activeSession(pool,accountId);
  assert(crashedSession,'Direct session was not durable before crash');

  // Hold one real HTTP request across the deliberate outage; modern recovery never retries.
  const recoveryGate=new Promise((resolve)=>{releaseRecovery=resolve;});
  let crashRecoveryRequests=0;
  const holdRecovery=async(route)=>{crashRecoveryRequests+=1; await recoveryGate; await route.continue();};
  await direct.page.route('**/api/sessions/*/recover',holdRecovery);
  const beforeCrash=await sessionRow(crashedSession.id);
  const recoveredResponse=observeResponse(direct.page,(response)=>response.url().endsWith(`/api/sessions/${crashedSession.id}/recover`),{timeout:25_000});
  await crashChild(apiProcess); apiProcess=undefined;
  await waitFor(()=>crashRecoveryRequests===1,5_000,'Crash did not initiate exactly one modern recovery');
  await directHost.context.close();

  await new Promise((resolve)=>setTimeout(resolve,6_500));
  apiProcess=startApi({apiPort,apiBase,oidc});
  await waitForApi(apiBase,apiProcess);
  await assertEndedSession(pool,crashedSession.id,'server_restarted');
  const restartHost=await openHost(browser,hostServer,apiBase,
    await issueHostTicket(apiBase,native,host),false,contexts);
  releaseRecovery(); releaseRecovery=undefined;
  const recovered=await recoveredResponse;
  assert.equal(recovered.status(),201,'Crash recovery failed');
  const recoveredResult=await recovered.json(); assertV2(recoveredResult);
  const reconnected=await inspectConnection({page:direct.page,hostPage:restartHost.page,screenshot:resolve(ARTIFACTS,'restart.png'),exerciseInput:false});
  await assertContinuity(beforeCrash,recoveredResult);
  assert.equal(crashRecoveryRequests,1,'Modern crash recovery retried');
  assert.equal(direct.traffic.connect,1,'Crash recovery reused the PIN');
  await direct.page.unroute('**/api/sessions/*/recover',holdRecovery);
  const gracefulSession=await activeSession(pool,accountId);
  assert(gracefulSession,'Reconnected session was not durable before SIGTERM');
  const recoveriesBeforeShutdown=direct.traffic.recover;
  const graceful=await stopChild(apiProcess); apiProcess=undefined;
  assert.equal(graceful.forced,false,'SIGTERM required forced process termination');
  assert(graceful.code===0 || (graceful.code===null && graceful.signal==='SIGTERM'),'SIGTERM API child exited abnormally');
  await assertEndedSession(pool,gracefulSession.id,'server_shutdown');
  await direct.page.getByRole('alert').waitFor({timeout:5_000});
  await waitFor(()=>direct.page.evaluate(()=>window.__systemPeers.every((peer)=>peer.connectionState==='closed')),3_000,'SIGTERM retained local media');
  await direct.page.waitForTimeout(2_200);
  assert.equal(direct.traffic.connect,1,'SIGTERM reused the PIN');
  assert(direct.traffic.recover-recoveriesBeforeShutdown<=1,'SIGTERM recovery retried');
  console.log('System lifecycle: crash orphan cleanup, one-shot recovery and clean SIGTERM exit passed');
  metadata.restart={crashRecovered:true,reconnectedCandidate:reconnected.controllerCandidate,gracefulShutdown:true,exit:graceful,oneRecoveryRequest:true,noPinReuse:true,deadlinesPreserved:true};
  await restartHost.context.close();
  await direct.context.close();

  apiProcess=startApi({apiPort,apiBase,oidc});
  await waitForApi(apiBase,apiProcess);

  const relayHost=await openHost(browser,hostServer,apiBase,
    await issueHostTicket(apiBase,native,host),true,contexts);
  const relay=await runBrowserScenario({browser,apiBase,host,code:mode.code,hostPage:relayHost.page,
    forceRelay:true,screenshot:resolve(ARTIFACTS,'relay.png'),contexts});
  assert.equal(relay.controllerCandidate.local,'relay','Forced controller did not select a relay candidate');
  assert.equal(relay.hostCandidate.local,'relay','Forced host did not select a relay candidate');
  metadata.relay={controllerCandidate:relay.controllerCandidate,hostCandidate:relay.hostCandidate,pixels:relay.pixels};

  await waitFor(()=>oidc.refreshCount>0,27_000,'Active BFF session did not perform rotating-token authorization refresh');
  metadata.refreshRotations=oidc.refreshCount;
  await apiJson(apiBase,`/api/devices/${host.id}/mode`,{
    method:'POST',session:native.sessionId,body:{...await deviceProof(apiBase,native,host),enabled:false,allowBrowser:false},
  });
  await relay.page.getByRole('alert').waitFor({timeout:5_000});
  const endedText=await relay.page.getByRole('alert').textContent();
  assert.match(endedText ?? '',/mode_disabled/);
  const rejected=await browserJson(relay.page,`/api/devices/${host.id}/connect`,{scope:'control',code:mode.code,...CONTROLLER_FEATURES});
  assert.equal(rejected.status,403,'A disabled mode accepted a new browser connection');
  assert.equal(relay.traffic.recover,0,'Mode disable initiated recovery');

  await relay.context.close();
  await relayHost.context.close();
  metadata.status='passed';
  metadata.finishedAt=new Date().toISOString();
  await writeFile(resolve(ARTIFACTS,'metadata.json'),`${JSON.stringify(metadata,null,2)}\n`);
} catch(error) {
  metadata.status='failed';
  metadata.finishedAt=new Date().toISOString();
  metadata.error=safeMessage(error);
  metadata.failureState={apiPid:apiProcess?.pid,apiExitCode:apiProcess?.exitCode,apiSignal:apiProcess?.signalCode,
    auth:await pool.query(`select count(*)::int as rows,count(*) filter(where revoked_at is not null)::int as revoked
      from sync_auth_sessions where account_id=$1`,[accountId]).then((result)=>result.rows[0]).catch(()=>null)};
  await writeFile(resolve(ARTIFACTS,'metadata.json'),`${JSON.stringify(metadata,null,2)}\n`).catch(()=>undefined);
  throw error;
} finally {
  releaseRecovery?.();
  for(const context of contexts.reverse()) await context.close().catch(()=>undefined);
  await browser?.close().catch(()=>undefined);
  await stopChild(apiProcess);
  await hostServer?.close().catch(()=>undefined);
  await oidc?.close().catch(()=>undefined);
  const cleanupErrors=[];
  await cleanupDatabase(pool,accountId).catch((error)=>cleanupErrors.push(`DB: ${safeMessage(error)}`));
  await cleanupRedis(redis,redisPrefix).catch((error)=>cleanupErrors.push(`Redis: ${safeMessage(error)}`));
  metadata.cleanup={database:!cleanupErrors.some((error)=>error.startsWith('DB:')),redis:!cleanupErrors.some((error)=>error.startsWith('Redis:'))};
  await pool.end().catch(()=>undefined);
  if(redis.status!=='end') await redis.quit().catch(()=>redis.disconnect());
  if(cleanupErrors.length) {
    metadata.status='failed'; metadata.cleanup.errors=cleanupErrors;
  }
  await writeFile(resolve(ARTIFACTS,'metadata.json'),`${JSON.stringify(metadata,null,2)}\n`);
  await writeFile(resolve(ARTIFACTS,`${runId}.metadata.json`),`${JSON.stringify(metadata,null,2)}\n`);
  assert.equal(cleanupErrors.length,0,`Fixture cleanup failed: ${cleanupErrors.join('; ')}`);
}
console.log(`Sync system test passed: direct=${metadata.direct.controllerCandidate.local}, relay=${metadata.relay.controllerCandidate.local}, refreshRotations=${metadata.refreshRotations}; fixture cleanup verified`);

function startApi({apiPort,apiBase,oidc}) {
  const child=spawn(process.execPath,['dist/main.js'],{cwd:ROOT,env:{...process.env,
    NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(apiPort),SYNC_PUBLIC_URL:apiBase,SYNC_ALLOWED_ORIGINS:'',
    DATABASE_URL:databaseUrl,DATABASE_SSL:'false',SYNC_AUTO_MIGRATE:'true',REDIS_URL:redisUrl,SYNC_REDIS_KEY_PREFIX:redisPrefix,
    SYNC_AUTH_ISSUER_URL:oidc.issuer,SYNC_AUTH_JWKS_URL:`${oidc.issuer}/oauth/jwks`,SYNC_AUTH_AUDIENCE:'service:sync',
    SYNC_OIDC_AUTHORIZATION_URL:`${oidc.issuer}/oauth/authorize`,
    SYNC_OIDC_CLIENT_ID:clientId,SYNC_OIDC_CLIENT_SECRET:clientSecret,SYNC_OIDC_REDIRECT_URI:`${apiBase}/api/session/oidc/callback`,
    SYNC_SESSION_ENCRYPTION_KEY:sessionEncryptionKey,SYNC_PIN_PEPPER:pinPepper,
    SYNC_AUTH_RECHECK_SECONDS:'20',SYNC_AUTH_HTTP_TIMEOUT_MS:'2000',SYNC_STUN_URLS:fileEnv.SYNC_STUN_URLS ?? '',
    SYNC_INSTANCE_LEASE_TTL_SECONDS:'6',
    SYNC_TICKET_TTL_SECONDS:String(CONNECTION_TIMEOUT_SECONDS),SYNC_WEB_IDLE_TIMEOUT_SECONDS:String(IDLE_TIMEOUT_SECONDS),
    SYNC_REQUIRE_BOUNDED_HOSTS:'true',SYNC_REMOTE_SESSION_TTL_SECONDS:'300',
    SYNC_TURN_URLS:turnUrls,SYNC_TURN_SECRET:turnSecret,SYNC_TURN_TTL_SECONDS:fileEnv.SYNC_TURN_TTL_SECONDS ?? '600',
    SYNC_TURN_USERNAME_PREFIX:'sync-system'},stdio:['ignore','pipe','pipe']});
  child.logs=[];
  for(const stream of [child.stdout,child.stderr]) stream.on('data',(chunk)=>{
    child.logs.push(...chunk.toString().split('\n').filter(Boolean));
    if(child.logs.length>120) child.logs.splice(0,child.logs.length-120);
  });
  return child;
}

async function waitForApi(apiBase,child) {
  await waitFor(async()=>{
    if(child.exitCode!==null) throw new Error(`API exited during startup\n${child.logs.slice(-20).join('\n')}`);
    try { const response=await fetch(`${apiBase}/api/health`); return response.ok && (await response.json()).ready===true; }
    catch { return false; }
  },12_000,'Production API did not become ready');
}

async function verifyProductionSurface(apiBase) {
  const config=await fetch(`${apiBase}/api/config`).then((response)=>response.json());
  assert.equal(config.authConfigured,true,'Fixture OIDC was not configured');
  assert(validateWire('WirePublicConfig',config),'Invalid production config contract');
  assert.equal(config.protocolVersion,2);
  assert.equal(config.minimumWebProtocolVersion,2);
  assert.equal(config.requireBoundedHosts,true);
  assert.equal(config.webIdleTimeoutSeconds,IDLE_TIMEOUT_SECONDS);
  assert.deepEqual(config.features,{displaySelection:true,browserIdle:true,browserRecovery:true});
  const response=await fetch(apiBase);
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-security-policy') ?? '',/frame-ancestors 'none'/);
  assert.match(await response.text(),/id="root"/);
}

async function verifyLoginCsrfBinding(apiBase) {
  const startedResponse=await fetch(`${apiBase}/api/session/oidc/start`,{method:'POST',redirect:'manual',
    headers:{origin:apiBase,'content-type':'application/json'},body:JSON.stringify({platform:'web'})});
  assert.equal(startedResponse.status,201);
  const started=await startedResponse.json();
  const bindingHeader=startedResponse.headers.getSetCookie().find((value)=>value.startsWith('sync_oidc_'));
  assert(bindingHeader,'Web OIDC start did not set a per-state binding cookie');
  assert.match(bindingHeader,/; HttpOnly/i);
  assert.match(bindingHeader,/; SameSite=Lax/i);
  const bindingCookie=bindingHeader.split(';',1)[0];
  const cookieName=bindingCookie.slice(0,bindingCookie.indexOf('='));
  const authorized=await fetch(started.authorizeUrl,{redirect:'manual'});
  assert.equal(authorized.status,302);
  const callback=authorized.headers.get('location');
  assert(callback?.startsWith(`${apiBase}/api/session/oidc/callback`));

  const missing=await fetch(callback,{redirect:'manual'});
  assert.equal(missing.status,401,'Missing browser binding consumed or accepted the callback');
  const wrong=await fetch(callback,{redirect:'manual',headers:{cookie:`${cookieName}=wrong-binding-value`}});
  assert.equal(wrong.status,401,'Wrong browser binding consumed or accepted the callback');
  const legitimate=await fetch(callback,{redirect:'manual',headers:{cookie:bindingCookie}});
  assert.equal(legitimate.status,302,'Legitimate browser binding did not complete the untouched transaction');
  assert.equal(legitimate.headers.get('location'),'/');
  assert(legitimate.headers.getSetCookie().some((value)=>value.startsWith('sync_session=')),'Successful callback did not issue a Sync session');
  const replay=await fetch(callback,{redirect:'manual',headers:{cookie:bindingCookie}});
  assert.equal(replay.status,401,'Completed web callback was replayable');
}

async function nativeLogin(apiBase) {
  const verifier=opaque(48);
  const started=await apiJson(apiBase,'/api/session/oidc/start',{method:'POST',body:{platform:'macos',challenge:s256(verifier),returnUri:'sync://auth'}});
  const authorized=await fetch(started.authorizeUrl,{redirect:'manual'});
  assert.equal(authorized.status,302);
  const callback=authorized.headers.get('location');
  assert(callback?.startsWith(`${apiBase}/api/session/oidc/callback`));
  const completedCallback=await fetch(callback,{redirect:'manual'});
  assert.equal(completedCallback.status,302);
  assert.match(completedCallback.headers.get('location') ?? '',/^sync:\/\/auth\?transactionId=/);
  const appCallback=new URL(completedCallback.headers.get('location'));
  const handoffCode=appCallback.searchParams.get('handoffCode');
  assert(handoffCode,'Native callback must contain a one-time completion code');
  const missingCode=await fetch(`${apiBase}/api/session/oidc/complete`,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({transactionId:started.transactionId,verifier})});
  assert.equal(missingCode.status,400,'Callback code is required for native completion');
  const completed=await apiJson(apiBase,'/api/session/oidc/complete',{method:'POST',body:{transactionId:started.transactionId,verifier,handoffCode}});
  assert.equal(completed.account.id,accountId);
  return completed;
}

async function registerDevice(apiBase,native,name,platform,features) {
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const challenge=await apiJson(apiBase,'/api/devices/challenge',{method:'POST',session:native.sessionId,body:{}});
  const signature=sign('sha256',Buffer.from(`sync:register:${challenge.id}:${challenge.nonce}`),keys.privateKey).toString('base64');
  const result=await apiJson(apiBase,'/api/devices',{method:'POST',session:native.sessionId,body:{name,platform,...features,clientVersion:'2.0.0',
    publicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64'),challengeId:challenge.id,signature}});
  assert.equal(result.device.protocolVersion,2);
  assert.deepEqual(result.device.capabilities,features.capabilities);
  return {...result.device,privateKey:keys.privateKey};
}

async function deviceProof(apiBase,native,device) {
  const challenge=await apiJson(apiBase,'/api/devices/challenge',{method:'POST',session:native.sessionId,body:{deviceId:device.id}});
  return {deviceId:device.id,challengeId:challenge.id,
    signature:sign('sha256',Buffer.from(`sync:device:${device.id}:${challenge.id}:${challenge.nonce}`),device.privateKey).toString('base64')};
}

async function issueHostTicket(apiBase,native,host) {
  const result=await apiJson(apiBase,'/api/signaling/tickets',{method:'POST',session:native.sessionId,body:{...await deviceProof(apiBase,native,host),...HOST_FEATURES}});
  return result.ticket;
}

async function openHost(browser,server,apiBase,ticket,forceRelay,contexts) {
  const context=await browser.newContext({viewport:{width:800,height:500}}); contexts.push(context);
  await context.addInitScript((config)=>{ window.__SYNC_HOST_CONFIG=config; },{apiBase,ticket,forceRelay});
  const page=await context.newPage();
  await page.goto(server.url());
  await waitFor(()=>page.evaluate(()=>window.__hostReady===true),5_000,'Host signaling socket did not become ready');
  return {context,page};
}

async function runBrowserScenario({browser,apiBase,host,code,hostPage,forceRelay,screenshot,contexts}) {
  const context=await browser.newContext({viewport:{width:1280,height:800}}); contexts.push(context);
  await context.addInitScript((relay)=>{
    const Native=window.RTCPeerConnection;
    window.__systemPeers=[];
    class CapturedPeer extends Native {
      constructor(configuration={}) { super({...configuration,iceTransportPolicy:relay?'relay':configuration.iceTransportPolicy}); window.__systemPeers.push(this); }
    }
    Object.defineProperty(window,'RTCPeerConnection',{value:CapturedPeer,configurable:true});
  },forceRelay);
  const page=await context.newPage();
  const traffic={connect:0,recover:0,activity:0};
  page.on('request',(request)=>{
    if(request.method()!=='POST') return;
    const path=new URL(request.url()).pathname;
    if(/^\/api\/devices\/[^/]+\/connect$/.test(path)) traffic.connect+=1;
    if(/^\/api\/sessions\/[^/]+\/recover$/.test(path)) traffic.recover+=1;
    if(/^\/api\/sessions\/[^/]+\/activity$/.test(path)) traffic.activity+=1;
  });
  await page.goto(apiBase);
  await page.getByRole('button',{name:'Sign in'}).waitFor({timeout:8_000});
  await page.getByRole('button',{name:'Sign in'}).click();
  await page.getByRole('heading',{name:'Online desktops'}).waitFor({timeout:10_000});
  const responsePromise=observeResponse(page,(response)=>response.url().endsWith(`/api/devices/${host.id}/connect`) && response.request().method()==='POST');
  const connected=await connectPage({page,host,code,hostPage,screenshot});
  const response=await responsePromise; assert.equal(response.status(),201);
  const result=await response.json(); assertV2(result);
  return {context,page,traffic,result,...connected};
}

async function connectPage({page,host,code,hostPage,screenshot}) {
  await page.getByRole('button',{name:new RegExp(host.name)}).click();
  await page.getByLabel('6-digit access code').fill(code);
  await page.getByRole('button',{name:'Connect'}).click();
  return inspectConnection({page,hostPage,screenshot});
}

async function inspectConnection({page,hostPage,screenshot,exerciseInput=true}) {
  try {
    await page.getByText('Connected',{exact:true}).waitFor({timeout:15_000});
  } catch {
    const controller=await page.evaluate(()=>({
      alerts:Array.from(document.querySelectorAll('[role="alert"]')).map((element)=>element.textContent),
      peers:(window.__systemPeers??[]).map((peer)=>({connectionState:peer.connectionState,iceConnectionState:peer.iceConnectionState,signalingState:peer.signalingState})),
    }));
    const hostState=await hostPage.evaluate(()=>({hostReady:window.__hostReady,socketClosed:window.__socketClosed??false,
      peer:window.__peer?{connectionState:window.__peer.connectionState,iceConnectionState:window.__peer.iceConnectionState,signalingState:window.__peer.signalingState}:null,
      ended:window.__ended}));
    throw new Error(`WebRTC connection timeout: ${JSON.stringify({controller,host:hostState})}`);
  }
  await page.getByText('Input active',{exact:true}).waitFor({timeout:8_000});
  await waitFor(()=>page.getByTestId('remote-video').evaluate((video)=>video.videoWidth>0),8_000,'Remote video never received dimensions');
  const pixels=await waitForValue(async()=>sampleVideo(page),8_000,(value)=>value.nonBlack>100 && value.range>20,'Remote video remained blank');
  if(exerciseInput) {
    const stage=page.getByTestId('video-stage');
    const box=await stage.boundingBox(); assert(box,'Remote video stage has no bounds');
    await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
    await page.getByRole('button',{name:'Escape'}).click();
    await waitFor(()=>hostPage.evaluate(()=>window.__messages.some((message)=>message.type==='button') &&
      window.__messages.some((message)=>message.type==='key') && window.__messages.some((message)=>message.type==='heartbeat')),
    8_000,'Control messages did not round-trip through data channels');
    await waitFor(async()=>Number(await page.getByTestId('data-rx').textContent())>0,5_000,'Controller did not receive echoed data');
  }
  const channels=await hostPage.evaluate(()=>window.__channels);
  assert(channels.some((channel)=>channel.label==='sync-control' && channel.ordered===true));
  assert(channels.some((channel)=>channel.label==='sync-motion' && channel.ordered===false && channel.maxRetransmits===0));
  const fixture=await hostPage.evaluate(()=>({session:window.__sessions.at(-1),errors:window.__errors,messages:window.__messages}));
  assert.equal(fixture.session.protocolVersion,2);
  assert.deepEqual(fixture.session.capabilities,['host-displays','viewer-displays']);
  assert.deepEqual(fixture.errors,[],'Host fixture signaling failed');
  assert(fixture.messages.length>0,'V2 input heartbeat missing');
  assert(fixture.messages.every((message)=>message.epoch===fixture.session.epoch && message.inputEpoch===fixture.session.epoch),'V2 input epoch missing or stale');
  const controllerCandidate=await waitForValue(()=>selectedCandidate(page),8_000,Boolean,'Controller selected candidate unavailable');
  const hostCandidate=await waitForValue(()=>hostPage.evaluate(()=>window.__selectedCandidate()),8_000,Boolean,'Host selected candidate unavailable');
  await page.screenshot({path:screenshot,fullPage:true});
  return {controllerCandidate,hostCandidate,pixels};
}

async function selectedCandidate(page) {
  return page.evaluate(async()=>{
    const peer=window.__systemPeers?.at(-1); if(!peer) return null; const stats=await peer.getStats();
    for(const report of stats.values()) if(report.type==='candidate-pair' && report.state==='succeeded' && report.nominated) {
      const local=stats.get(report.localCandidateId); const remote=stats.get(report.remoteCandidateId);
      return {local:local?.candidateType??null,remote:remote?.candidateType??null};
    }
    return null;
  });
}

async function sampleVideo(page) {
  return page.getByTestId('remote-video').evaluate((video)=>{
    const canvas=document.createElement('canvas'); canvas.width=64; canvas.height=36;
    const context=canvas.getContext('2d'); context.drawImage(video,0,0,64,36);
    const data=context.getImageData(0,0,64,36).data; let nonBlack=0,min=255,max=0;
    for(let index=0;index<data.length;index+=4) { const value=data[index]+data[index+1]+data[index+2]; if(value>12) nonBlack+=1;
      min=Math.min(min,data[index],data[index+1],data[index+2]); max=Math.max(max,data[index],data[index+1],data[index+2]); }
    return {nonBlack,range:max-min};
  });
}

function assertV2(result) {
  assert(validateWire('WireConnectResult',result),'Invalid connect/recovery response contract');
  assert.equal(result.session.protocolVersion,2,'Fixture silently negotiated legacy media');
  assert.deepEqual(result.session.capabilities,['host-displays','viewer-displays']);
  if(result.session.controllerId==='browser') {
    assert(validateWire('WireBrowserAccess',result.webAccess),'Missing browser HTTP authority');
    assert(Date.parse(result.webAccess.idleDeadline)<=Date.parse(result.session.expiresAt),'Idle deadline exceeds absolute expiry');
  }
}

async function browserJson(page,path,body,{csrf=true}={}) {
  return page.evaluate(async({path,body,csrf})=>{
    const cookie=document.cookie.split(';').map((part)=>part.trim()).find((part)=>part.startsWith('sync_csrf='));
    const headers={'content-type':'application/json'};
    if(csrf && cookie) headers['x-csrf-token']=decodeURIComponent(cookie.slice('sync_csrf='.length));
    const response=await fetch(path,{method:'POST',credentials:'same-origin',headers,body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  },{path,body,csrf});
}

async function verifyHttpContract({browser,apiBase,host,code,contexts}) {
  const context=await browser.newContext(); contexts.push(context);
  const page=await context.newPage();
  await page.goto(apiBase);
  await page.getByRole('button',{name:'Sign in'}).click();
  await page.getByRole('heading',{name:'Online desktops'}).waitFor({timeout:10_000});
  const path=`/api/devices/${host.id}/connect`;
  const before=await pool.query('select count(*)::int as count from sync_remote_sessions where owner_account_id=$1',[accountId]);
  for(const declaration of [{},{protocolVersion:1}]) {
    const denied=await browserJson(page,path,{scope:'control',code,...declaration});
    assert.equal(denied.status,426,'Legacy browser declaration was not rejected');
    assert.equal(denied.body.error,'reload-required');
  }
  const after=await pool.query('select count(*)::int as count from sync_remote_sessions where owner_account_id=$1',[accountId]);
  assert.equal(after.rows[0].count,before.rows[0].count,'Rejected browser declaration created a reservation');
  const created=await browserJson(page,path,{scope:'control',code,...CONTROLLER_FEATURES});
  assert.equal(created.status,201); assertV2(created.body);
  const {session,webAccess}=created.body;
  const row=await sessionRow(session.id);
  assert.equal(row.connected_at,null,'Unclaimed ticket unexpectedly installed a controller');
  assert.equal(row.runtime_namespace,redisPrefix);
  assert(row.activity_token_hash===createHash('sha256').update(webAccess.activityToken).digest('base64url'),'Browser authority was not stored as a hash');
  const reservationMs=row.connection_deadline-row.created_at;
  assert(reservationMs>0 && reservationMs<=CONNECTION_TIMEOUT_SECONDS*1000+100,'Reservation deadline was not bounded');
  const activityPath=`/api/sessions/${session.id}/activity`;
  assert.equal((await browserJson(page,activityPath,{activityToken:webAccess.activityToken},{csrf:false})).status,403);
  assert.equal((await browserJson(page,activityPath,{activityToken:opaque()})).status,403);
  assert.equal((await browserJson(page,activityPath,{activityToken:webAccess.activityToken,deadline:'2099-01-01'})).status,400);
  const activity=await browserJson(page,activityPath,{activityToken:webAccess.activityToken});
  assert.equal(activity.status,201);
  assert(validateWire('WireBrowserActivityState',activity.body));
  const listed=await page.evaluate(()=>fetch('/api/sessions').then((response)=>response.json()));
  assert(listed.sessions.some((item)=>item.id===session.id),'Reservation missing from owned HTTP sessions');
  await waitFor(async()=>(await sessionRow(session.id)).end_reason==='connection_timeout',13_000,'Unclaimed controller reservation never expired');
  const expired=await sessionRow(session.id);
  assert.equal(expired.activity_token_hash,null,'Orphan retained browser authority');
  assert.equal(expired.recovery_consumed,true);
  assert.equal((await browserJson(page,`/api/sessions/${session.id}/recover`,{activityToken:webAccess.activityToken,...CONTROLLER_FEATURES})).status,403,'Expired orphan recovered');
  assert.equal((await browserJson(page,activityPath,{activityToken:webAccess.activityToken})).status,403,'Expired orphan renewed activity');
  await context.close();
  console.log('System HTTP: browser>=2, CSRF, strict activity DTO, orphan deadline and recovery rejection passed');
  return {minimumBrowserProtocol:2,csrf:true,activity:true,orphanDeadlineSeconds:CONNECTION_TIMEOUT_SECONDS,orphanRecoveryRejected:true};
}

async function verifyHiddenRecovery(scenario,hostPage) {
  const {page,result,traffic}=scenario;
  const id=result.session.id;
  await waitFor(async()=>(await sessionRow(id)).last_activity_at>Date.parse(result.webAccess.lastActivityAt),5_000,'Real user input did not report HTTP activity');
  const quiet=await sessionRow(id);
  const reports=traffic.activity;
  await page.waitForTimeout(5_500);
  const heartbeatOnly=await sessionRow(id);
  assert.equal(traffic.activity,reports,'Heartbeat reported user activity');
  assert.equal(heartbeatOnly.idle_deadline.toISOString(),quiet.idle_deadline.toISOString(),'Heartbeat extended idle authority');
  const activityResponse=observeResponse(page,(response)=>response.url().endsWith(`/api/sessions/${id}/activity`));
  await page.getByRole('button',{name:'Escape'}).click();
  const activity=await activityResponse;
  assert.equal(activity.status(),201); assert(validateWire('WireBrowserActivityState',await activity.json()));
  const before=await sessionRow(id);
  assert(before.last_activity_at>quiet.last_activity_at,'Explicit input did not renew activity');
  assert(before.idle_deadline>quiet.idle_deadline,'Explicit input did not extend idle deadline');
  const recoveryPath=`/api/sessions/${id}/recover`;
  const token=result.webAccess.activityToken;
  const legacy=await browserJson(page,recoveryPath,{activityToken:token});
  assert.equal(legacy.status,426); assert.equal(legacy.body.error,'reload-required');
  assert.equal((await browserJson(page,recoveryPath,{activityToken:token,...CONTROLLER_FEATURES},{csrf:false})).status,403);
  assert.equal((await browserJson(page,recoveryPath,{activityToken:opaque(),...CONTROLLER_FEATURES})).status,403);
  const recoveryCount=traffic.recover;
  const activityCount=traffic.activity;
  await visibility(page,'hidden');
  await waitFor(()=>page.evaluate(()=>window.__systemPeers.every((peer)=>peer.connectionState==='closed')),3_000,'Hidden page retained live media');
  await waitFor(async()=>(await sessionRow(id)).end_reason==='controller_disconnected',3_000,'Hidden controller did not close signaling');
  const messageCount=await hostPage.evaluate(()=>window.__messages.length);
  await page.waitForTimeout(1_650);
  assert.equal(await hostPage.evaluate(()=>window.__messages.length),messageCount,'Hidden page continued sending input');
  assert.equal(traffic.recover,recoveryCount,'Hidden page attempted recovery');
  assert.equal(traffic.activity,activityCount,'Hidden state reported activity');
  const responsePromise=observeResponse(page,(response)=>response.url().endsWith(recoveryPath));
  await visibility(page,'visible');
  const response=await responsePromise;
  assert.equal(response.status(),201);
  const recovered=await response.json(); assertV2(recovered);
  assert(recovered.webAccess.activityToken!==token,'Recovery did not rotate browser authority');
  await inspectConnection({page,hostPage,screenshot:resolve(ARTIFACTS,'hidden-recovery.png'),exerciseInput:false});
  await assertContinuity(before,recovered);
  assert.equal(traffic.connect,1,'Modern recovery reused a PIN');
  assert.equal(traffic.recover,recoveryCount+1,'Modern recovery retried');
  assert.equal(traffic.activity,activityCount,'Foreground/focus reported user activity');
  assert.equal((await browserJson(page,recoveryPath,{activityToken:token,...CONTROLLER_FEATURES})).status,403,'Consumed recovery was replayed');
  assert.equal((await browserJson(page,`/api/sessions/${recovered.session.id}/activity`,{activityToken:token})).status,403,'Old authority renewed the replacement');
  console.log('System browser: hidden media/input shutdown, deferred one-use HTTP recovery, token rotation and deadline continuity passed');
  return {localMediaClosed:true,inputStopped:true,deferredRecovery:true,oneUse:true,rotatedAuthority:true,noPinReuse:true,deadlinesPreserved:true};
}

async function visibility(page,state) {
  // Drive the real visibility handler deterministically in headless Chrome, without replacing API responses.
  await page.evaluate((state)=>{
    Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>state});
    document.dispatchEvent(new Event('visibilitychange'));
  },state);
}

function observeResponse(page,predicate,options) {
  const response=page.waitForResponse(predicate,options);
  // An earlier assertion can enter teardown before this observation is awaited.
  void response.catch(()=>undefined);
  return response;
}

async function sessionRow(id) {
  const result=await pool.query('select * from sync_remote_sessions where id=$1 and owner_account_id=$2',[id,accountId]);
  assert.equal(result.rows.length,1,'Fixture session missing');
  return result.rows[0];
}

async function assertContinuity(before,result) {
  assert.notEqual(result.session.id,before.id,'Recovery reused the original row');
  const after=await sessionRow(result.session.id);
  for(const key of ['expires_at','idle_deadline','last_activity_at']) assert.equal(after[key].toISOString(),before[key].toISOString(),`Recovery changed ${key}`);
  assert.equal(result.webAccess.idleDeadline,before.idle_deadline.toISOString());
  assert.equal(result.session.expiresAt,before.expires_at.toISOString());
  assert(after.connection_deadline>before.connection_deadline,'Recovery did not reset the connection deadline');
  assert(after.connected_at,'Recovered signaling controller was not installed');
  assert.notEqual(after.activity_token_hash,before.activity_token_hash,'Recovery retained authority hash');
  const old=await sessionRow(before.id);
  assert.equal(old.recovery_consumed,true);
  assert.equal(old.activity_token_hash,null);
}

async function apiJson(apiBase,path,{method='GET',session,body}={}) {
  const headers={accept:'application/json'};
  if(session) headers['x-sync-session']=session;
  if(body!==undefined) headers['content-type']='application/json';
  const response=await fetch(`${apiBase}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  const text=await response.text(); let value={};
  if(text) { try { value=JSON.parse(text); } catch { value={message:text.slice(0,200)}; } }
  if(!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${safeMessage(value.message)}`);
  return value;
}

async function cleanupDatabase(pool,owner) {
  const client=await pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from sync_access_events where owner_account_id=$1',[owner]);
    await client.query('delete from sync_remote_sessions where owner_account_id=$1',[owner]);
    await client.query('delete from sync_device_grants where owner_account_id=$1',[owner]);
    await client.query('delete from sync_devices where owner_account_id=$1',[owner]);
    await client.query('delete from sync_auth_sessions where account_id=$1',[owner]);
    const remaining=await client.query(`select
      (select count(*) from sync_access_events where owner_account_id=$1)+
      (select count(*) from sync_remote_sessions where owner_account_id=$1)+
      (select count(*) from sync_device_grants where owner_account_id=$1)+
      (select count(*) from sync_devices where owner_account_id=$1)+
      (select count(*) from sync_auth_sessions where account_id=$1) as count`,[owner]);
    assert.equal(Number(remaining.rows[0].count),0,'Fixture database rows remained');
    await client.query('commit');
  } catch(error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}

async function cleanupRedis(redis,prefix) {
  let cursor='0';
  do {
    const [next,keys]=await redis.scan(cursor,'MATCH',`${prefix}:*`,'COUNT',100); cursor=next;
    if(keys.length) await redis.unlink(...keys);
  } while(cursor!=='0');
  do {
    const [next,remaining]=await redis.scan(cursor,'MATCH',`${prefix}:*`,'COUNT',100); cursor=next;
    assert.equal(remaining.length,0,'Fixture Redis keys remained');
  } while(cursor!=='0');
}

async function stopChild(child) {
  if(!child || child.exitCode!==null) return {forced:false,code:child?.exitCode,signal:child?.signalCode};
  child.kill('SIGTERM');
  const result=await Promise.race([
    new Promise((resolve)=>child.once('exit',(code,signal)=>resolve({done:true,code,signal}))),
    new Promise((resolve)=>setTimeout(()=>resolve({done:false}),5_000)),
  ]);
  if(result.done) return {forced:false,code:result.code,signal:result.signal};
  child.kill('SIGKILL');
  await new Promise((resolve)=>child.once('exit',resolve));
  return {forced:true,code:child.exitCode,signal:child.signalCode};
}

async function crashChild(child) {
  assert(child && child.exitCode===null,'API child is not running');
  child.kill('SIGKILL');
  await new Promise((resolve)=>child.once('exit',resolve));
}

async function activeSession(pool,owner) {
  const result=await pool.query(`select id from sync_remote_sessions where owner_account_id=$1 and ended_at is null order by created_at desc limit 1`,[owner]);
  return result.rows[0];
}

async function assertEndedSession(pool,id,reason) {
  const result=await pool.query('select ended_at,end_reason from sync_remote_sessions where id=$1',[id]);
  assert.equal(result.rows.length,1,'Fixture session disappeared before cleanup; check for concurrent sync_test TRUNCATE');
  assert(result.rows[0]?.ended_at,`Session ${id} remained active`);
  assert.equal(result.rows[0].end_reason,reason);
}

async function freePort() {
  const server=http.createServer(); await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port; await new Promise((resolve)=>server.close(resolve)); return port;
}

async function waitFor(check,timeout,message) {
  const started=Date.now(); let lastError;
  while(Date.now()-started<timeout) {
    try { if(await check()) return true; } catch(error) { lastError=error; }
    await new Promise((resolve)=>setTimeout(resolve,100));
  }
  throw new Error(`${message}${lastError?`: ${safeMessage(lastError)}`:''}`);
}

async function waitForValue(read,timeout,accept,message) {
  let value;
  await waitFor(async()=>{ value=await read(); return accept(value); },timeout,message);
  return value;
}

async function readEnv(path) {
  const result={}; let source='';
  try { source=await readFile(path,'utf8'); } catch { return result; }
  for(const raw of source.split(/\r?\n/)) {
    const line=raw.trim(); if(!line || line.startsWith('#')) continue;
    const separator=line.indexOf('='); if(separator<1) continue;
    let value=line.slice(separator+1).trim();
    if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'"))) value=value.slice(1,-1);
    result[line.slice(0,separator).trim()]=value;
  }
  return result;
}

function opaque(bytes=32) { return randomBytes(bytes).toString('base64url'); }
function s256(value) { return createHash('sha256').update(value).digest('base64url'); }
function safeMessage(value) { return String(value instanceof Error?value.message:value ?? 'unknown').replace(/[A-Za-z0-9_-]{32,}/g,'<redacted>').slice(0,300); }
