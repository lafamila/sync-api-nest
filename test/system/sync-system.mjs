import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import Redis from 'ioredis';
import playwright from '../../web/node_modules/playwright/index.js';
import { HostFixtureServer } from './host-fixture.mjs';
import { OidcFixture } from './oidc-fixture.mjs';

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
const turnUrls=fileEnv.SYNC_TURN_URLS;
const turnSecret=fileEnv.SYNC_TURN_SECRET;
assert(turnUrls && turnSecret,'System test requires configured local SYNC_TURN_URLS and SYNC_TURN_SECRET');

await mkdir(ARTIFACTS,{recursive:true});
const pool=new Pool({connectionString:databaseUrl});
const redis=new Redis(redisUrl,{lazyConnect:true,maxRetriesPerRequest:2});
let oidc;
let hostServer;
let apiProcess;
let browser;
const contexts=[];
const metadata={runId,startedAt:new Date().toISOString(),loginCsrf:false,direct:null,restart:null,relay:null,refreshRotations:0,status:'running'};

try {
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
  const host=await registerDevice(apiBase,native,'System Host','macos');
  const controller=await registerDevice(apiBase,native,'System Controller','ios');
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
    body:{scope:'control',controllerDeviceId:controller.id,challengeId:controllerProof.challengeId,signature:controllerProof.signature},
  });
  assert(typeof trusted.ticket==='string' && trusted.ticket.length>20,'Trusted native connect did not issue a ticket');
  await apiJson(apiBase,`/api/sessions/${trusted.session.id}`,{
    method:'DELETE',session:native.sessionId,body:await deviceProof(apiBase,native,controller),
  });

  const direct=await runBrowserScenario({browser,apiBase,host,code:mode.code,hostPage:directHost.page,
    forceRelay:false,screenshot:resolve(ARTIFACTS,'direct.png'),contexts});
  assert.notEqual(direct.controllerCandidate.local,'relay','Direct controller unexpectedly selected relay');
  assert.notEqual(direct.hostCandidate.local,'relay','Direct host unexpectedly selected relay');
  metadata.direct={controllerCandidate:direct.controllerCandidate,hostCandidate:direct.hostCandidate,pixels:direct.pixels};
  const crashedSession=await activeSession(pool,accountId);
  assert(crashedSession,'Direct session was not durable before crash');
  await crashChild(apiProcess); apiProcess=undefined;
  await direct.page.getByRole('alert').waitFor({timeout:5_000}).catch(()=>undefined);
  await directHost.context.close();

  await new Promise((resolve)=>setTimeout(resolve,6_500));
  apiProcess=startApi({apiPort,apiBase,oidc});
  await waitForApi(apiBase,apiProcess);
  await assertEndedSession(pool,crashedSession.id,'server_restarted');
  const restartHost=await openHost(browser,hostServer,apiBase,
    await issueHostTicket(apiBase,native,host),false,contexts);
  const reconnected=await reconnectBrowserScenario({page:direct.page,host,code:mode.code,hostPage:restartHost.page,
    screenshot:resolve(ARTIFACTS,'restart.png')});
  const gracefulSession=await activeSession(pool,accountId);
  assert(gracefulSession,'Reconnected session was not durable before SIGTERM');
  const graceful=await stopChild(apiProcess); apiProcess=undefined;
  assert.equal(graceful.forced,false,'SIGTERM required forced process termination');
  await assertEndedSession(pool,gracefulSession.id,'server_shutdown');
  metadata.restart={crashRecovered:true,reconnectedCandidate:reconnected.controllerCandidate,gracefulShutdown:true};
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
  const rejected=await relay.page.evaluate(async({hostId,code})=>{
    const csrf=document.cookie.split(';').map((part)=>part.trim()).find((part)=>part.startsWith('sync_csrf='))?.split('=',2)[1];
    const response=await fetch(`/api/devices/${hostId}/connect`,{method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json','x-csrf-token':decodeURIComponent(csrf??'')},body:JSON.stringify({scope:'control',code})});
    return response.status;
  },{hostId:host.id,code:mode.code});
  assert.equal(rejected,403,'A disabled mode accepted a new browser connection');

  await relay.context.close();
  await relayHost.context.close();
  metadata.status='passed';
  metadata.finishedAt=new Date().toISOString();
  await writeFile(resolve(ARTIFACTS,'metadata.json'),`${JSON.stringify(metadata,null,2)}\n`);
  console.log(`Sync system test passed: direct=${metadata.direct.controllerCandidate.local}, relay=${metadata.relay.controllerCandidate.local}, refreshRotations=${metadata.refreshRotations}`);
} catch(error) {
  metadata.status='failed';
  metadata.finishedAt=new Date().toISOString();
  metadata.error=error instanceof Error?error.message:'unknown failure';
  await writeFile(resolve(ARTIFACTS,'metadata.json'),`${JSON.stringify(metadata,null,2)}\n`).catch(()=>undefined);
  throw error;
} finally {
  for(const context of contexts.reverse()) await context.close().catch(()=>undefined);
  await browser?.close().catch(()=>undefined);
  await stopChild(apiProcess);
  await hostServer?.close().catch(()=>undefined);
  await oidc?.close().catch(()=>undefined);
  await cleanupDatabase(pool,accountId).catch((error)=>console.error(`System DB cleanup failed: ${safeMessage(error)}`));
  await cleanupRedis(redis,redisPrefix).catch((error)=>console.error(`System Redis cleanup failed: ${safeMessage(error)}`));
  await pool.end().catch(()=>undefined);
  if(redis.status!=='end') await redis.quit().catch(()=>redis.disconnect());
}

function startApi({apiPort,apiBase,oidc}) {
  const child=spawn(process.execPath,['dist/main.js'],{cwd:ROOT,env:{...process.env,
    NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(apiPort),SYNC_PUBLIC_URL:apiBase,SYNC_ALLOWED_ORIGINS:'',
    DATABASE_URL:databaseUrl,DATABASE_SSL:'false',SYNC_AUTO_MIGRATE:'true',REDIS_URL:redisUrl,SYNC_REDIS_KEY_PREFIX:redisPrefix,
    SYNC_AUTH_ISSUER_URL:oidc.issuer,SYNC_AUTH_JWKS_URL:`${oidc.issuer}/oauth/jwks`,SYNC_AUTH_AUDIENCE:'service:sync',
    SYNC_OIDC_CLIENT_ID:clientId,SYNC_OIDC_CLIENT_SECRET:clientSecret,SYNC_OIDC_REDIRECT_URI:`${apiBase}/api/session/oidc/callback`,
    SYNC_SESSION_ENCRYPTION_KEY:sessionEncryptionKey,SYNC_PIN_PEPPER:pinPepper,
    SYNC_AUTH_RECHECK_SECONDS:'20',SYNC_AUTH_HTTP_TIMEOUT_MS:'2000',SYNC_STUN_URLS:fileEnv.SYNC_STUN_URLS ?? '',
    SYNC_INSTANCE_LEASE_TTL_SECONDS:'6',
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

async function registerDevice(apiBase,native,name,platform) {
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const challenge=await apiJson(apiBase,'/api/devices/challenge',{method:'POST',session:native.sessionId,body:{}});
  const signature=sign('sha256',Buffer.from(`sync:register:${challenge.id}:${challenge.nonce}`),keys.privateKey).toString('base64');
  const result=await apiJson(apiBase,'/api/devices',{method:'POST',session:native.sessionId,body:{name,platform,
    publicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64'),challengeId:challenge.id,signature}});
  return {...result.device,privateKey:keys.privateKey};
}

async function deviceProof(apiBase,native,device) {
  const challenge=await apiJson(apiBase,'/api/devices/challenge',{method:'POST',session:native.sessionId,body:{deviceId:device.id}});
  return {deviceId:device.id,challengeId:challenge.id,
    signature:sign('sha256',Buffer.from(`sync:device:${device.id}:${challenge.id}:${challenge.nonce}`),device.privateKey).toString('base64')};
}

async function issueHostTicket(apiBase,native,host) {
  const result=await apiJson(apiBase,'/api/signaling/tickets',{method:'POST',session:native.sessionId,body:await deviceProof(apiBase,native,host)});
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
  await page.goto(apiBase);
  await page.getByRole('button',{name:'Sign in'}).waitFor({timeout:8_000});
  await page.getByRole('button',{name:'Sign in'}).click();
  await page.getByRole('heading',{name:'Online Macs'}).waitFor({timeout:10_000});
  const connected=await connectPage({page,host,code,hostPage,screenshot});
  return {context,page,...connected};
}

async function reconnectBrowserScenario({page,host,code,hostPage,screenshot}) {
  await page.reload();
  await page.getByRole('heading',{name:'Online Macs'}).waitFor({timeout:10_000});
  return connectPage({page,host,code,hostPage,screenshot});
}

async function connectPage({page,host,code,hostPage,screenshot}) {
  await page.getByRole('button',{name:new RegExp(host.name)}).click();
  await page.getByLabel('6-digit access code').fill(code);
  await page.getByRole('button',{name:'Connect'}).click();
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
  const stage=page.getByTestId('video-stage');
  const box=await stage.boundingBox(); assert(box,'Remote video stage has no bounds');
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  await page.getByRole('button',{name:'Escape'}).click();
  await waitFor(()=>hostPage.evaluate(()=>window.__messages.some((message)=>message.type==='button') &&
    window.__messages.some((message)=>message.type==='key') && window.__messages.some((message)=>message.type==='heartbeat')),
  8_000,'Control messages did not round-trip through data channels');
  await waitFor(async()=>Number(await page.getByTestId('data-rx').textContent())>0,5_000,'Controller did not receive echoed data');
  const channels=await hostPage.evaluate(()=>window.__channels);
  assert(channels.some((channel)=>channel.label==='sync-control' && channel.ordered===true));
  assert(channels.some((channel)=>channel.label==='sync-motion' && channel.ordered===false && channel.maxRetransmits===0));
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
