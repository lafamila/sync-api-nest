import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { SYNC_LIMITS } from "../src/generated/sync-wire";
import type { RemoteConnection } from "../src/remoteConnection";

interface State {
  connectCount:number; activeSessionId:string; activityCount:number;
  connectBodies:Array<Record<string,unknown>>; recoveryBodies:Array<Record<string,unknown>>;
  endedSessionIds:string[]; signalingSessionIds:string[];
  jsonPingCount:number; jsonPongCount:number; protocolPongCount:number;
  accesses:Array<{id:string;active:boolean;lastActivityAt:string;idleDeadline:string}>;
}
interface Message {type:string;seq:number;epoch:string;inputEpoch?:string;requestId?:string;sessionId?:string;displayId?:string;down?:boolean;button?:string;dx?:number;dy?:number}
interface HostState { __hostReady:boolean; __frames:number; __messages:Message[]; __acceptedMessages:Message[]; __rejectedMessages:Message[]; __signals:Message[]; __peerGeneration:number; __displayBehavior:Record<string,unknown>; __sendSignal:(message:object)=>void }
interface LifetimeProbe { peers:RTCPeerConnection[]; lastPong:number; connection:RemoteConnection }

const test = base.extend<{host:Page}>({
  host:async ({browser},use) => {
    const context=await browser.newContext();
    const host=await context.newPage();
    await host.goto('/__test/host');
    await expect.poll(()=>host.evaluate(()=>(window as unknown as HostState).__hostReady)).toBe(true);
    await use(host);
    await context.close();
  },
});

test.beforeEach(async ({request})=>{await request.post('/__test/reset');});

async function authorize(context:BrowserContext) {
  await context.addCookies([
    {name:'sync_test_auth',value:'1',domain:'127.0.0.1',path:'/',httpOnly:true,sameSite:'Lax'},
    {name:'sync_csrf',value:'csrf-test',domain:'127.0.0.1',path:'/',sameSite:'Strict'},
  ]);
}
async function connect(context:BrowserContext,page:Page,scope='Control',beforeConnect?:()=>Promise<void>) {
  await authorize(context);
  await page.goto('/');
  await beforeConnect?.();
  await expect(page.getByText('Desk Windows')).toBeVisible();
  await page.getByRole('button',{name:/Studio Mac/}).click();
  await page.getByRole('button',{name:scope,exact:true}).click();
  await page.getByLabel('6-digit access code').fill('123456');
  await page.getByRole('button',{name:'Connect',exact:true}).click();
  await expect(page.getByText('Connected',{exact:true})).toBeVisible();
  await expect.poll(()=>page.getByTestId('remote-video').evaluate((video:HTMLVideoElement)=>video.videoWidth)).toBeGreaterThan(0);
  if(scope === 'Control') await expect(page.getByText('Input active',{exact:true})).toBeVisible();
}
async function state(page:Page):Promise<State> {return page.request.get('/__test/state').then(response=>response.json());}
async function videoPixels(page:Page) {
  return page.getByTestId('remote-video').evaluate((video:HTMLVideoElement)=>{
    const canvas=document.createElement('canvas');canvas.width=80;canvas.height=45;
    const context=canvas.getContext('2d')!;context.drawImage(video,0,0,80,45);
    const bytes=context.getImageData(0,0,80,45).data;let colorful=0;
    for(let i=0;i<bytes.length;i+=4) if(bytes[i]+bytes[i+1]+bytes[i+2]>30 && Math.max(bytes[i],bytes[i+1],bytes[i+2])-Math.min(bytes[i],bytes[i+1],bytes[i+2])>10) colorful++;
    return colorful;
  });
}

async function observeLifetime(context:BrowserContext) {
  await context.addInitScript(()=>{
    const probe={peers:[] as RTCPeerConnection[],lastPong:0};
    Object.defineProperty(window,'__lifetimeProbe',{value:probe});
    const NativePeer=window.RTCPeerConnection;
    window.RTCPeerConnection=new Proxy(NativePeer,{construct(Target,args:ConstructorParameters<typeof RTCPeerConnection>){
      const peer=new Target(...args);probe.peers.push(peer);return peer;
    }});
    const NativeSocket=window.WebSocket;
    window.WebSocket=new Proxy(NativeSocket,{construct(Target,args:ConstructorParameters<typeof WebSocket>){
      const socket=new Target(...args);
      socket.addEventListener('message',event=>{
        try { if(JSON.parse(String(event.data)).type === 'pong') probe.lastPong=performance.now(); } catch {}
      });
      return socket;
    }});
  });
}

async function captureConnection(page:Page) {
  await page.evaluate(async ()=>{
    const source='/src/remoteConnection.ts';
    const {RemoteConnection:Connection}=await import(source);
    const start=Connection.prototype.start;
    Connection.prototype.start=function(this:RemoteConnection,ticket:string) {
      (window as unknown as {__lifetimeProbe:LifetimeProbe}).__lifetimeProbe.connection=this;
      return start.call(this,ticket);
    };
  });
}

async function inboundBytes(page:Page):Promise<number> {
  return page.evaluate(async ()=>{
    const peer=(window as unknown as {__lifetimeProbe:LifetimeProbe}).__lifetimeProbe.peers[0];
    const reports=await peer.getStats();let bytes=0;
    reports.forEach(report=>{if(report.type === 'inbound-rtp' && report.kind === 'video') bytes+=report.bytesReceived ?? 0;});
    return bytes;
  });
}

test('JSON pong loss closes healthy RTP and protocol-pong transport within the shared liveness bound',async ({context,page,host})=>{
  test.setTimeout(40000);
  await observeLifetime(context);
  await connect(context,page);
  await expect.poll(async ()=>(await state(page)).jsonPongCount).toBeGreaterThan(0);
  const baselinePongs=(await state(page)).jsonPongCount;
  const lastPong=await page.evaluate(()=>(window as unknown as {__lifetimeProbe:LifetimeProbe}).__lifetimeProbe.lastPong);
  await page.request.post('/__test/options',{data:{dropJsonPongs:true}});
  const before=await inboundBytes(page);
  await page.waitForTimeout(4000);
  const middle=await inboundBytes(page);
  await page.waitForTimeout(4000);
  expect(middle).toBeGreaterThan(before);
  expect(await inboundBytes(page)).toBeGreaterThan(middle);
  expect(await videoPixels(page)).toBeGreaterThan(3000);
  const healthy=await state(page);
  expect(healthy.connectCount).toBe(1);
  expect(healthy.protocolPongCount).toBeGreaterThan(0);
  expect(healthy.jsonPingCount).toBeGreaterThan(1);
  expect(healthy.jsonPongCount).toBe(baselinePongs);
  await expect.poll(async ()=>(await state(page)).recoveryBodies.length,{timeout:10000}).toBe(1);
  const elapsed=await page.evaluate(previous=>performance.now()-previous,lastPong);
  expect(elapsed).toBeLessThan(SYNC_LIMITS.signalingLivenessTimeoutSeconds*1000+1500);
  expect(await page.evaluate(()=>(window as unknown as {__lifetimeProbe:LifetimeProbe}).__lifetimeProbe.peers[0].connectionState)).toBe('closed');
  await page.request.post('/__test/options',{data:{dropJsonPongs:false}});
  await expect(page.getByText('Input active',{exact:true})).toBeVisible();
  expect((await state(page)).connectBodies).toHaveLength(1);
  expect(await host.evaluate(()=>(window as unknown as HostState).__peerGeneration)).toBe(2);
});

for(const clock of ['rollback','sleep-forward'] as const) {
  test(`input checks close stale authority before throttled callbacks with ${clock}`,async ({context,page,host})=>{
    await observeLifetime(context);
    await connect(context,page,'Control',()=>captureConnection(page));
    await page.request.post('/__test/options',{data:{dropJsonPongs:true}});
    const result=await page.evaluate(({clock,timeout})=>{
      const probe=(window as unknown as {__lifetimeProbe:LifetimeProbe}).__lifetimeProbe;
      const performanceNow=performance.now.bind(performance);const wallNow=Date.now;
      const frozen=performanceNow();
      Object.defineProperty(performance,'now',{configurable:true,value:clock === 'rollback' ? ()=>performanceNow()+timeout+1 : ()=>frozen});
      Date.now=clock === 'rollback' ? ()=>wallNow()-3600000 : ()=>wallNow()+timeout+1;
      try {
        const allowed=probe.connection.canControl();
        const sent=probe.connection.sendReliable({type:'text',text:'must-not-cross-stale-signaling'});
        return {allowed,sent,peer:probe.peers[0].connectionState};
      } finally { Object.defineProperty(performance,'now',{configurable:true,value:performanceNow});Date.now=wallNow; }
    },{clock,timeout:SYNC_LIMITS.signalingLivenessTimeoutSeconds*1000});
    expect(result).toEqual({allowed:false,sent:false,peer:'closed'});
    await page.request.post('/__test/options',{data:{dropJsonPongs:false}});
    await expect.poll(async ()=>(await state(page)).recoveryBodies.length).toBe(1);
    expect(await host.evaluate(()=>(window as unknown as HostState).__messages.some(message=>(message as Message&{text?:string}).text === 'must-not-cross-stale-signaling'))).toBe(false);
  });
}

test('absolute expiry rejects input before timers even when wall time rolls back and liveness is not yet stale',async ({context,page,host})=>{
  await observeLifetime(context);
  await page.request.post('/__test/options',{data:{sessionSeconds:10}});
  await connect(context,page,'Control',()=>captureConnection(page));
  const result=await page.evaluate(()=>{
    const probe=(window as unknown as {__lifetimeProbe:LifetimeProbe}).__lifetimeProbe;
    const performanceNow=performance.now.bind(performance);const wallNow=Date.now;
    Object.defineProperty(performance,'now',{configurable:true,value:()=>performanceNow()+10001});
    Date.now=()=>wallNow()-3600000;
    try {
      const allowed=probe.connection.canControl();
      const sent=probe.connection.sendReliable({type:'text',text:'must-not-cross-absolute-expiry'});
      return {allowed,sent,peer:probe.peers[0].connectionState};
    } finally { Object.defineProperty(performance,'now',{configurable:true,value:performanceNow});Date.now=wallNow; }
  });
  expect(result).toEqual({allowed:false,sent:false,peer:'closed'});
  await expect(page.getByRole('alert')).toContainText('Remote access expired');
  expect((await state(page)).recoveryBodies).toEqual([]);
  expect(await host.evaluate(()=>(window as unknown as HostState).__messages.some(message=>(message as Message&{text?:string}).text === 'must-not-cross-absolute-expiry'))).toBe(false);
});

test('hidden page proactively closes view-only RTP and defers untouched recovery authority until visible',async ({context,page,host})=>{
  await page.clock.install();
  await observeLifetime(context);
  await connect(context,page,'View',()=>captureConnection(page));
  const initial=await state(page);
  const frame=await host.evaluate(()=>(window as unknown as HostState).__frames);
  const closed=await page.evaluate(()=>{
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
    document.dispatchEvent(new Event('visibilitychange'));
    return (window as unknown as {__lifetimeProbe:LifetimeProbe}).__lifetimeProbe.peers[0].connectionState;
  });
  expect(closed).toBe('closed');
  await page.clock.fastForward(20000);
  await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));});
  await page.waitForTimeout(200);
  expect(await host.evaluate(()=>(window as unknown as HostState).__frames)).toBeGreaterThan(frame);
  expect((await state(page)).recoveryBodies).toEqual([]);
  expect((await state(page)).connectCount).toBe(1);
  await page.evaluate(()=>{
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async ()=>(await state(page)).recoveryBodies.length).toBe(1);
  await expect.poll(()=>host.evaluate(()=>(window as unknown as HostState).__peerGeneration)).toBe(2);
  const recovered=await state(page);
  expect(recovered.accesses[1].idleDeadline).toBe(initial.accesses[0].idleDeadline);
  expect(recovered.accesses[1].lastActivityAt).toBe(initial.accesses[0].lastActivityAt);
});

test('input sees hidden state before a throttled visibility callback and cannot create hidden recovery',async ({context,page,host})=>{
  await observeLifetime(context);
  await connect(context,page,'Control',()=>captureConnection(page));
  const result=await page.evaluate(()=>{
    const probe=(window as unknown as {__lifetimeProbe:LifetimeProbe}).__lifetimeProbe;
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
    // Deliberately leave visibilitychange queued: the input boundary must inspect state itself.
    return {allowed:probe.connection.canControl(),sent:probe.connection.sendReliable({type:'text',text:'must-not-cross-hidden-state'}),peer:probe.peers[0].connectionState};
  });
  expect(result).toEqual({allowed:false,sent:false,peer:'closed'});
  expect((await state(page)).recoveryBodies).toEqual([]);
  expect(await host.evaluate(()=>(window as unknown as HostState).__messages.some(message=>(message as Message&{text?:string}).text === 'must-not-cross-hidden-state'))).toBe(false);
  await page.evaluate(()=>{
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async ()=>(await state(page)).recoveryBodies.length).toBe(1);
});

test('a row already created by in-flight recovery is deleted rather than installed while hidden',async ({context,page,host})=>{
  await connect(context,page);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  let childID:string|null=null;let delivered=false;
  await page.route('**/api/sessions/*/recover',async route=>{
    const response=await route.fetch();
    childID=(await response.json() as {session:{id:string}}).session.id;
    await gate;await route.fulfill({response});delivered=true;
  });
  try {
    await page.request.post('/__test/drop-controller');
    await expect.poll(()=>childID).not.toBeNull();
    expect((await state(page)).accesses.find(access=>access.id === childID)?.active).toBe(true);
    await page.evaluate(()=>{
      Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    release();await expect.poll(()=>delivered).toBe(true);
    await expect.poll(async ()=>(await state(page)).endedSessionIds.filter(id=>id === childID).length).toBe(1);
    expect((await state(page)).signalingSessionIds).not.toContain(childID);
    expect(await host.evaluate(()=>(window as unknown as HostState).__peerGeneration)).toBe(1);
    await page.evaluate(()=>{
      Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(100);
    expect((await state(page)).connectCount).toBe(2);
    expect((await state(page)).recoveryBodies).toHaveLength(1);
    await expect(page.getByTestId('video-stage')).toHaveCount(0);
  } finally { release(); }
});

test('visible unfocused window releases held input but keeps its renderer and authority',async ({context,page,host})=>{
  await observeLifetime(context);
  await connect(context,page);
  const before=await inboundBytes(page);
  const count=await host.evaluate(()=>(window as unknown as HostState).__messages.length);
  const box=(await page.getByTestId('video-stage').boundingBox())!;
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  await expect.poll(()=>host.evaluate(offset=>(window as unknown as HostState).__messages.slice(offset).some(message=>message.type === 'release-all'),count)).toBe(true);
  await page.waitForTimeout(300);
  expect(await inboundBytes(page)).toBeGreaterThan(before);
  expect(await page.evaluate(()=>(window as unknown as {__lifetimeProbe:LifetimeProbe}).__lifetimeProbe.peers[0].connectionState)).toBe('connected');
  expect((await state(page)).connectCount).toBe(1);
});

test('display switch blocks input, correlates requestId and arms only a fresh inputEpoch heartbeat',async ({context,page,host})=>{
  await context.addInitScript(()=>{
    const Native=window.RTCPeerConnection;
    const channels:RTCDataChannel[]=[];
    Object.defineProperty(window,'__testChannels',{value:channels});
    window.RTCPeerConnection=new Proxy(Native,{construct(Target,args:ConstructorParameters<typeof RTCPeerConnection>){
      const peer=new Target(...args);const create=peer.createDataChannel.bind(peer);
      peer.createDataChannel=(...parameters)=>{const channel=create(...parameters);channels.push(channel);return channel;};return peer;
    }});
  });
  await connect(context,page);
  await host.evaluate(()=>(window as unknown as HostState).__displayBehavior.delayMs=500);
  const before=await host.evaluate(()=>(window as unknown as HostState).__messages.length);
  await page.getByLabel('Display',{exact:true}).selectOption('portrait');
  await expect(page.getByText('Input locked',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Display',{exact:true})).toBeDisabled();
  const box=(await page.getByTestId('video-stage').boundingBox())!;
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  const pending=await host.evaluate(()=>(window as unknown as HostState).__messages.slice(-1)[0]);
  expect(pending.type).toBe('release-all');
  await expect(page.getByText('Input active',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Display',{exact:true})).toHaveValue('portrait');
  await expect.poll(()=>page.getByTestId('remote-video').evaluate((video:HTMLVideoElement)=>video.videoWidth)).toBe(360);
  const messages=await host.evaluate(offset=>(window as unknown as HostState).__messages.slice(offset),before);
  const heartbeat=messages.find(message=>message.type === 'heartbeat')!;
  expect(heartbeat.inputEpoch).toMatch(/^[0-9a-f-]{36}$/);
  expect(heartbeat.inputEpoch).not.toBe(heartbeat.epoch);
  expect(messages.filter(message=>message.type === 'button')).toEqual([]);
  await page.evaluate(({epoch})=>{
    const channels=(window as unknown as {__testChannels:RTCDataChannel[]}).__testChannels;
    channels.find(channel=>channel.label === 'sync-control')!.send(JSON.stringify({type:'button',seq:999999,epoch,inputEpoch:epoch,x:.5,y:.5,button:'left',down:true}));
  },{epoch:heartbeat.epoch});
  await expect.poll(()=>host.evaluate(()=>(window as unknown as HostState).__rejectedMessages.some(message=>message.seq === 999999))).toBe(true);
  expect(await host.evaluate(()=>(window as unknown as HostState).__peerGeneration)).toBe(1);
  expect(await videoPixels(page)).toBeGreaterThan(3000);
});

test('late/duplicate display replies cannot rearm or roll back a correlated selection',async ({context,page,host})=>{
  await connect(context,page);
  await host.evaluate(()=>(window as unknown as HostState).__displayBehavior.delayMs=700);
  await page.getByLabel('Display',{exact:true}).selectOption('portrait');
  const selection=await host.evaluate(()=>(window as unknown as HostState).__signals.filter(message=>message.type === 'select-display').slice(-1)[0]);
  await host.evaluate(message=>(window as unknown as HostState).__sendSignal({type:'displays',sessionId:message.sessionId,requestId:crypto.randomUUID(),displays:[{id:'main',name:'Main',width:640,height:360,isPrimary:true}],selectedDisplayId:'main',inputEpoch:crypto.randomUUID()}),selection);
  await expect(page.getByText('Input locked',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Display',{exact:true})).toHaveValue('portrait');
  await expect(page.getByText('Input active',{exact:true})).toBeVisible();
  await host.evaluate(message=>(window as unknown as HostState).__sendSignal({type:'displays',sessionId:message.sessionId,requestId:message.requestId,displays:[{id:'main',name:'Main',width:640,height:360,isPrimary:true}],selectedDisplayId:'main',inputEpoch:message.inputEpoch}),selection);
  await page.waitForTimeout(100);
  await expect(page.getByLabel('Display',{exact:true})).toHaveValue('portrait');
});

test('display timeout makes one authoritative query while input stays blocked then closes',async ({context,page,host})=>{
  await page.clock.install();
  await connect(context,page);
  await host.evaluate(()=>(window as unknown as HostState).__displayBehavior={ignoreSelection:true,ignoreQueries:true});
  await page.getByLabel('Display',{exact:true}).selectOption('portrait');
  await page.clock.fastForward(10001);
  await expect(page.getByText('Input locked',{exact:true})).toBeVisible();
  await expect.poll(()=>host.evaluate(()=>(window as unknown as HostState).__signals.filter(message=>message.type === 'get-displays').length)).toBe(2);
  await page.clock.fastForward(5001);
  await expect(page.getByRole('alert')).toContainText('Display selection timed out');
  expect((await state(page)).connectCount).toBe(1);
});

test('removed/invalid selected display closes the affected session without recovery',async ({context,page,host})=>{
  await connect(context,page);
  const sessionId=(await state(page)).activeSessionId;
  await host.evaluate(id=>(window as unknown as HostState).__sendSignal({type:'displays',sessionId:id,displays:[{id:'portrait',name:'Portrait',width:360,height:640,isPrimary:false}],selectedDisplayId:'main',inputEpoch:crypto.randomUUID()}),sessionId);
  await expect(page.getByRole('alert')).toContainText('selected display is unavailable');
  await expect(page.getByTestId('video-stage')).toHaveCount(0);
  expect((await state(page)).recoveryBodies).toEqual([]);
});

test('display failure or malformed epoch never restores the old input lease',async ({context,page,host})=>{
  await connect(context,page);
  await host.evaluate(()=>(window as unknown as HostState).__displayBehavior.error='unavailable');
  const before=await host.evaluate(()=>(window as unknown as HostState).__messages.length);
  await page.getByLabel('Display',{exact:true}).selectOption('portrait');
  await expect(page.getByRole('alert')).toContainText('Display unavailable');
  const messages=await host.evaluate(offset=>(window as unknown as HostState).__messages.slice(offset),before);
  expect(messages.every(message=>message.type === 'release-all')).toBe(true);
  expect((await state(page)).recoveryBodies).toEqual([]);
});

test('logout invalidates a pending display selection before its late completion',async ({context,page,host})=>{
  await connect(context,page);
  await host.evaluate(()=>(window as unknown as HostState).__displayBehavior.delayMs=600);
  await page.getByLabel('Display',{exact:true}).selectOption('portrait');
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.getByTestId('video-stage')).toHaveCount(0);
  expect((await state(page)).connectCount).toBe(1);
  expect((await state(page)).recoveryBodies).toEqual([]);
});

test('v2 browser with v1 host sends declaration2 but never display signals or inputEpoch',async ({context,page,host})=>{
  await page.request.post('/__test/options',{data:{hostProtocol:1}});
  await connect(context,page);
  expect((await state(page)).connectBodies[0].protocolVersion).toBe(2);
  await expect(page.getByLabel('Display',{exact:true})).toHaveCount(0);
  expect(await host.evaluate(()=>(window as unknown as HostState).__signals.some(message=>message.type === 'get-displays'))).toBe(false);
  const messages=await host.evaluate(()=>(window as unknown as HostState).__messages);
  expect(messages.length).toBeGreaterThan(0);
  expect(messages.every(message=>message.inputEpoch === undefined)).toBe(true);
});

test('view-only explicit video interaction counts as activity; hover/focus/heartbeats do not',async ({context,page,host})=>{
  await connect(context,page,'View');
  const box=(await page.getByTestId('video-stage').boundingBox())!;
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForTimeout(700);
  expect((await state(page)).activityCount).toBe(0);
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  await expect.poll(async ()=>(await state(page)).activityCount).toBe(1);
  await page.getByLabel('Display',{exact:true}).selectOption('portrait');
  await expect(page.getByLabel('Display',{exact:true})).toHaveValue('portrait');
  expect(await host.evaluate(()=>(window as unknown as HostState).__messages.length)).toBe(0);
});

test('one-use recovery preserves last activity/deadline and never sends cached PIN',async ({context,page,host})=>{
  await connect(context,page);
  const initial=await state(page);
  await page.request.post('/__test/drop-controller');
  await expect.poll(async ()=>(await state(page)).connectCount).toBe(2);
  await expect(page.getByText('Input active',{exact:true})).toBeVisible();
  const recovered=await state(page);
  expect(recovered.connectBodies).toHaveLength(1);
  expect(recovered.recoveryBodies).toHaveLength(1);
  expect(recovered.recoveryBodies[0]).not.toHaveProperty('code');
  expect(recovered.recoveryBodies[0].protocolVersion).toBe(2);
  expect(recovered.accesses[1].idleDeadline).toBe(initial.accesses[0].idleDeadline);
  expect(recovered.accesses[1].lastActivityAt).toBe(initial.accesses[0].lastActivityAt);
  const replay=await page.request.post(`/api/sessions/${initial.activeSessionId}/recover`,{headers:{'X-CSRF-Token':'csrf-test'},data:recovered.recoveryBodies[0]});
  expect(replay.status()).toBe(403);
  expect(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length,query:location.search}))).toEqual({local:0,session:0,query:''});
  expect(await host.evaluate(()=>(window as unknown as HostState).__peerGeneration)).toBe(2);
});

test('another tab cannot refresh or recover access without its private activity token',async ({context,page,host})=>{
  await connect(context,page);
  const initial=await state(page);
  const other=await context.newPage();await other.goto('/');
  for(const action of ['activity','recover']) {
    const response=await other.request.post(`/api/sessions/${initial.activeSessionId}/${action}`,{headers:{'X-CSRF-Token':'csrf-test'},data:{activityToken:'public-test-wrong-tab-token-only',protocolVersion:2,capabilities:['viewer-displays']}});
    expect(response.status()).toBe(403);
  }
  const after=await state(page);
  expect(after.activityCount).toBe(0);
  expect(after.accesses[0].idleDeadline).toBe(initial.accesses[0].idleDeadline);
  await other.close();
  expect(await host.evaluate(()=>(window as unknown as HostState).__peerGeneration)).toBe(1);
});

test('uncertain recovery transport failure does not retry authority or fall back to a cached PIN',async ({context,page,host})=>{
  await connect(context,page);
  let recoveryAttempts=0;
  await page.route('**/api/sessions/*/recover',route=>{recoveryAttempts++;return route.abort('failed');});
  await page.request.post('/__test/drop-controller');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('video-stage')).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect(recoveryAttempts).toBe(1);
  expect((await state(page)).connectBodies).toHaveLength(1);
  expect(await host.evaluate(()=>(window as unknown as HostState).__peerGeneration)).toBe(1);
});

for (const legacy of [false,true]) {
  test(`disconnect after ${legacy ? 'legacy auto-connect' : 'modern recovery'} creates a row still deletes its held late response exactly once`,async ({context,page,host})=>{
    await context.addInitScript(()=>{
      const fetch=window.fetch.bind(window);
      const signals:Array<AbortSignal|null>=[];
      Object.defineProperty(window,'__rowCreationSignals',{value:signals});
      window.fetch=(input,init)=>{
        const url=input instanceof Request ? input.url : String(input);
        if(init?.method === 'POST' && /\/(connect|recover)$/.test(url)) signals.push(init.signal ?? null);
        return fetch(input,init);
      };
    });
    if(legacy) await page.request.post('/__test/options',{data:{legacy:true}});
    await connect(context,page);
    const initial=await state(page);
    const routePattern=legacy ? '**/api/devices/mac-online/connect' : '**/api/sessions/*/recover';
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    let createdID:string|null=null;
    let delivered=false;
    let creationFailures=0;
    const requestSuffix=legacy ? '/api/devices/mac-online/connect' : '/recover';
    page.on('requestfailed',request=>{
      if(request.method() === 'POST' && request.url().endsWith(requestSuffix)) creationFailures++;
    });
    await page.route(routePattern,async route=>{
      // This request reaches the real local fixture before withholding bytes from browser fetch.
      const response=await route.fetch();
      expect(response.status()).toBe(200);
      createdID=(await response.json() as {session:{id:string}}).session.id;
      await gate;
      await route.fulfill({response});
      delivered=true;
    });

    try {
      await page.request.post('/__test/drop-controller');
      await expect.poll(()=>createdID).not.toBeNull();
      const created=await state(page);
      expect(created.connectCount).toBe(2);
      expect(createdID).not.toBe(initial.activeSessionId);
      expect(created.accesses.find(access=>access.id === createdID)?.active).toBe(true);
      expect(created.signalingSessionIds).not.toContain(createdID);
      expect(delivered).toBe(false);

      // Explicit Disconnect, not logout: cookie+CSRF authority remains available for late DELETE.
      await page.getByRole('button',{name:'End session',exact:true}).click();
      await expect(page.getByRole('heading',{name:'Online desktops',exact:true})).toBeVisible();
      await expect(page.getByTestId('video-stage')).toHaveCount(0);
      const creationAborted=await page.evaluate(()=>{
        const signals=(window as unknown as {__rowCreationSignals:Array<AbortSignal|null>}).__rowCreationSignals;
        return signals[signals.length-1]?.aborted;
      });

      release();
      await expect.poll(()=>delivered).toBe(true);
      await expect.poll(async ()=>(await state(page)).endedSessionIds.filter(id=>id === createdID).length).toBe(1);
      await page.waitForTimeout(200);
      const ended=await state(page);
      expect(ended.accesses.find(access=>access.id === createdID)?.active).toBe(false);
      expect(ended.endedSessionIds.filter(id=>id === createdID)).toHaveLength(1);
      expect(ended.signalingSessionIds).not.toContain(createdID);
      expect(ended.connectBodies).toHaveLength(legacy ? 2 : 1);
      expect(ended.recoveryBodies).toHaveLength(legacy ? 0 : 1);
      expect(creationAborted).toBe(false);
      expect(creationFailures).toBe(0);
      expect(await host.evaluate(()=>(window as unknown as HostState).__peerGeneration)).toBe(1);
      await expect(page.getByTestId('video-stage')).toHaveCount(0);
      await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
    } finally {
      release();
    }
  });
}

test('hidden/lost-terminal idle deadline locks locally and requires fresh explicit PIN',async ({context,page,host})=>{
  await page.clock.install();
  await page.request.post('/__test/options',{data:{loseTerminal:true,serverOffsetMs:-600000}});
  await connect(context,page);
  await page.evaluate(()=>{
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(900001);
  await expect(page.getByRole('alert')).toContainText('Remote access expired');
  await expect(page.getByTestId('video-stage')).toHaveCount(0);
  await page.evaluate(()=>{
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
    document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('online'));
  });
  expect((await state(page)).connectCount).toBe(1);
  expect((await state(page)).recoveryBodies).toEqual([]);
  await page.getByRole('button',{name:/Studio Mac/}).click();
  await expect(page.getByLabel('6-digit access code')).toHaveValue('');
});

test('late in-flight activity response cannot revive terminal access',async ({context,page,host})=>{
  await page.clock.install();
  await page.request.post('/__test/options',{data:{idleSeconds:8,loseTerminal:true}});
  await connect(context,page,'View');
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let captured=false;
  await page.route('**/api/sessions/*/activity',async route=>{const response=await route.fetch();captured=true;await gate;await route.fulfill({response});});
  const box=(await page.getByTestId('video-stage').boundingBox())!;
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  await expect.poll(()=>captured).toBe(true);
  await page.clock.fastForward(8001);
  await expect(page.getByRole('alert')).toContainText('Remote access expired');
  release();await page.waitForTimeout(100);
  await expect(page.getByTestId('video-stage')).toHaveCount(0);
  expect((await state(page)).connectCount).toBe(1);
});

test('only explicit legacy config omits new fields; configuration errors never downgrade',async ({context,page,host})=>{
  await page.request.post('/__test/options',{data:{legacy:true}});
  await connect(context,page);
  expect((await state(page)).connectBodies[0]).toEqual({code:'123456',scope:'control'});
  await expect(page.getByLabel('Display',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'End session',exact:true}).click();
  await page.route('**/api/config',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Config unavailable'})}));
  await page.reload();
  await page.getByRole('button',{name:/Studio Mac/}).click();
  await page.getByLabel('6-digit access code').fill('123456');
  await page.getByRole('button',{name:'Connect',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Config unavailable');
  expect((await state(page)).connectBodies).toHaveLength(1);
  expect(await host.evaluate(()=>(window as unknown as HostState).__signals.some(message=>message.type === 'get-displays'))).toBe(false);
});

test('desktop/mobile video stays nonblank and compact with display controls and no horizontal overflow',async ({context,page,host})=>{
  await connect(context,page);
  for(const viewport of [{width:1280,height:800},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    expect(await videoPixels(page)).toBeGreaterThan(3000);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const selector=(await page.getByLabel('Display',{exact:true}).boundingBox())!;
    expect(selector.x).toBeGreaterThanOrEqual(0);expect(selector.x+selector.width).toBeLessThanOrEqual(viewport.width);
    const screenshot=await page.screenshot({path:test.info().outputPath(`v2-${viewport.width}.png`),fullPage:true});
    await mkdir('artifacts',{recursive:true});
    await writeFile(`artifacts/v2-${viewport.width}.png`,screenshot);
  }
  expect(await host.evaluate(()=>(window as unknown as HostState).__peerGeneration)).toBe(1);
});
