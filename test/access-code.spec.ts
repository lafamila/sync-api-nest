import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { WebSocket } from 'ws';
import { ConnectDeviceDto } from '../src/devices/device.dto';
import { DeviceService } from '../src/devices/device.service';
import { HealthController } from '../src/health.controller';
import { SyncConfigService } from '../src/config/config.service';
import { testConfig } from './helpers';
import { RemoteSession } from '../src/sessions/remote-session.repository';
import { RevocationBusService } from '../src/common/revocation-bus.service';
import { SignalingService } from '../src/signaling/signaling.service';
import { TicketPayload } from '../src/signaling/ticket.service';
import { SYNC_CAPABILITIES, validateWire } from '../src/generated/sync-wire';

function fixture() {
  const host={id:randomUUID(),platform:'macos'};
  const controller={id:randomUUID(),platform:'ios'};
  const grant={id:randomUUID(),scope:'control'};
  const auth={source:'native' as const,databaseId:randomUUID(),platform:'ios' as const,token:'synthetic',csrfHash:'synthetic',
    account:{id:'owner',name:'Synthetic',permission:'member' as const}};
  const endpoint={id:randomUUID(),protocolVersion:2,capabilities:[...SYNC_CAPABILITIES],cliProtocolVersion:1,cliChatProtocolVersion:1};
  const mode={epoch:randomUUID(),expiresAt:new Date(Date.now()+60000).toISOString(),allowBrowser:true};
  const devices={findOwned:jest.fn().mockResolvedValue(host),findGrant:jest.fn().mockResolvedValue(grant),audit:jest.fn()};
  const proofs={verify:jest.fn().mockResolvedValue(controller)};
  const modes={require:jest.fn().mockResolvedValue(mode),verifyPin:jest.fn()};
  const sessions={create:jest.fn(async(input)=>({...input,id:randomUUID(),controllerId:input.controllerDeviceId,
    expiresAt:input.expiresAt.toISOString()})),endIfActive:jest.fn()};
  const tickets={activeEndpoint:jest.fn().mockResolvedValue(endpoint),issue:jest.fn().mockResolvedValue('ticket')};
  const service=new DeviceService(devices as never,proofs as never,modes as never,sessions as never,tickets as never,
    {forAccount:()=>[]} as never,{} as never,{} as never,new SyncConfigService(testConfig()));
  const input:ConnectDeviceDto={scope:'control',purpose:'access-code',protocolVersion:2,capabilities:[...SYNC_CAPABILITIES],
    controllerDeviceId:controller.id,challengeId:'x'.repeat(32),signature:'YQ=='};
  return {service,host,controller,grant,auth,endpoint,mode,devices,proofs,modes,sessions,tickets,input};
}

describe('access-code admission and compatibility',()=>{
  it('publishes capability without extra version negotiation or feature flag',async()=>{
    const config=new HealthController(new SyncConfigService(testConfig()),{} as never,{} as never)
      .publicConfig({headers:{'x-sync-extensions':'access-code'}});
    expect(config.capabilities).toContain('access-code');
    expect(config.capabilities).toHaveLength(8);
    expect(config.features).not.toHaveProperty('accessCode');
    expect(validateWire('WirePublicConfig',config)).toBe(true);
    expect(await validate(plainToInstance(ConnectDeviceDto,fixture().input),{whitelist:true,forbidNonWhitelisted:true})).toEqual([]);
  });
  it.each(['macos','windows'])('admits %s data-only native control, stripping CLI/chat and media capabilities',async(platform)=>{
    const f=fixture();f.host.platform=platform;
    const result=await f.service.connect(f.auth,f.host.id,{...f.input,cliProtocolVersion:1,cliChatProtocolVersion:1},'127.0.0.1');
    expect(result.session).toMatchObject({purpose:'access-code',scope:'control',capabilities:['bounded-lifetime','access-code']});
    expect(result.session).not.toHaveProperty('cliProtocolVersion');
    expect(result.session).not.toHaveProperty('cliChatProtocolVersion');
    expect(f.sessions.create).toHaveBeenCalledWith(expect.objectContaining({authorizationGrantId:f.grant.id,hostEndpointId:f.endpoint.id}),expect.any(Function));
    expect(f.proofs.verify).toHaveBeenCalledTimes(1);
    expect(f.modes.verifyPin).not.toHaveBeenCalled();
  });
  it.each(['browser','pin','view','view-grant','no-grant','no-proof','self','ios-host','android-host','no-host','bad-proof','allowBrowser'] as const)
  ('rejects %s with zero reservations or PIN fallback',async(kind)=>{
    const f=fixture();
    if(kind==='browser') Object.assign(f.auth,{source:'web',platform:'web'});
    if(kind==='pin') f.input.code='123456';
    if(kind==='view') f.input.scope='view';
    if(kind==='view-grant') f.grant.scope='view';
    if(kind==='no-grant') f.devices.findGrant.mockResolvedValue(undefined);
    if(kind==='no-proof') delete f.input.signature;
    if(kind==='self') f.input.controllerDeviceId=f.host.id;
    if(kind==='ios-host') f.host.platform='ios';
    if(kind==='android-host') f.host.platform='android';
    if(kind==='no-host') f.devices.findOwned.mockResolvedValue(undefined);
    if(kind==='bad-proof') f.proofs.verify.mockRejectedValue(new Error('proof invalid'));
    if(kind==='allowBrowser') f.mode.allowBrowser=false;
    await expect(f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1')).rejects.toThrow();
    expect(f.sessions.create).not.toHaveBeenCalled();expect(f.tickets.issue).not.toHaveBeenCalled();
    expect(f.modes.verifyPin).not.toHaveBeenCalled();
  });
  it.each(['host-capability','controller-capability','host-base','controller-base'] as const)('returns426 without fallback for %s',async(kind)=>{
    const f=fixture();
    if(kind==='host-capability') f.endpoint.capabilities=f.endpoint.capabilities.filter(c=>c!=='access-code');
    if(kind==='controller-capability') f.input.capabilities=[];
    if(kind==='host-base') f.endpoint.protocolVersion=1;
    if(kind==='controller-base') f.input.protocolVersion=1;
    await expect(f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1')).rejects.toMatchObject({status:426,response:{error:'access-code-update-required'}});
    expect(f.sessions.create).not.toHaveBeenCalled();
  });
  it.each(['epoch','endpoint','capability','allowBrowser'] as const)('cleans its own reservation on post-INSERT %s change',async(kind)=>{
    const f=fixture();
    if(kind==='epoch') f.modes.require.mockResolvedValueOnce(f.mode).mockResolvedValueOnce({...f.mode,epoch:randomUUID()});
    if(kind==='allowBrowser') f.modes.require.mockResolvedValueOnce(f.mode).mockResolvedValueOnce({...f.mode,allowBrowser:false});
    if(kind==='endpoint') f.tickets.activeEndpoint.mockResolvedValueOnce(f.endpoint).mockResolvedValueOnce({...f.endpoint,id:randomUUID()});
    if(kind==='capability') f.tickets.activeEndpoint.mockResolvedValueOnce(f.endpoint).mockResolvedValueOnce({...f.endpoint,capabilities:[]});
    await expect(f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1')).rejects.toMatchObject({status:403});
    expect(f.sessions.endIfActive).toHaveBeenCalledWith('owner',expect.any(String),'connect_failed');
    expect(f.tickets.issue).not.toHaveBeenCalled();
  });
  it.each(['screen','cli'] as const)('does not add code authority to ordinary %s snapshots',async(purpose)=>{
    const f=fixture();
    const result=await f.service.connect(f.auth,f.host.id,{...f.input,purpose,cliProtocolVersion:1},'127.0.0.1');
    expect(result.session.capabilities).not.toContain('access-code');
    expect(result.session.cliProtocolVersion).toBe(1);
  });
  it('keeps a browser screen code-ineligible even when the caller declares every capability',async()=>{
    const f=fixture();Object.assign(f.auth,{source:'web',platform:'web'});
    f.modes.verifyPin.mockResolvedValue(f.mode);
    const input={...f.input,purpose:'screen' as const,code:'123456'};
    delete input.controllerDeviceId;delete input.challengeId;delete input.signature;
    const result=await f.service.connect(f.auth,f.host.id,input,'127.0.0.1');
    expect(result.session.capabilities).not.toContain('access-code');
    expect(result.session.purpose).toBe('screen');
    expect(result.session).not.toHaveProperty('cliProtocolVersion');
  });
});

type Connection={id:string;ticket:TicketPayload;socket:WebSocket & {send:jest.Mock;close:jest.Mock};lastPongAt:number;lastPingAt:number};
function connection(ticket:TicketPayload):Connection {
  return {id:randomUUID(),ticket,socket:{readyState:WebSocket.OPEN,send:jest.fn(),close:jest.fn()} as unknown as Connection['socket'],
    lastPongAt:Date.now(),lastPingAt:0};
}
function signalingFixture() {
  const f=fixture();
  const host=connection({role:'device',ownerAccountId:'owner',deviceId:f.host.id,platform:'windows',authSessionId:'host-auth',
    protocolVersion:2,capabilities:['access-code','bounded-lifetime']});
  const remote:RemoteSession={id:randomUUID(),ownerAccountId:'owner',hostId:f.host.id,controllerDeviceId:f.controller.id,controllerId:f.controller.id,
    controllerKind:'native',scope:'control',purpose:'access-code',epoch:f.mode.epoch,authSessionId:f.auth.databaseId,
    authorizationGrantId:f.grant.id,createdAt:new Date().toISOString(),expiresAt:f.mode.expiresAt,endedAt:null,endReason:null,
    runtimeNamespace:'test',signalingInstanceId:randomUUID(),protocolVersion:2,capabilities:['access-code','bounded-lifetime'],
    hostEndpointId:host.id,lastActivityAt:null,idleDeadline:null};
  const sessions={findActive:jest.fn().mockResolvedValue(remote),findActiveForHost:jest.fn().mockResolvedValue([remote]),
    installController:jest.fn(async(snapshot:RemoteSession,install:(s:RemoteSession)=>boolean)=>{
      if(!install(snapshot)) throw new Error('install denied');return snapshot;
    }),bindHostEndpoint:jest.fn(),endIfActive:jest.fn(),endForDevice:jest.fn(),endForInstance:jest.fn().mockResolvedValue([])};
  const bus=new RevocationBusService();
  const modes={get:jest.fn().mockResolvedValue(f.mode)};
  const service=new SignalingService({} as never,{} as never,{findOwned:async()=>f.host,touch:async()=>{}} as never,
    sessions as never,modes as never,{forAccount:()=>[]} as never,
    {key:(...p:string[])=>p.join(':'),client:{set:async()=>{},eval:async()=>1}} as never,
    {revalidateById:async()=>{}} as never,{} as never,bus,new SyncConfigService(testConfig()));
  const controller=connection({role:'controller',ownerAccountId:'owner',sessionId:remote.id,browser:false,authSessionId:remote.authSessionId});
  const internal=service as unknown as {devices:Map<string,Connection>;controllers:Map<string,Connection>;
    registerDevice(c:Connection):Promise<void>;registerController(c:Connection):Promise<void>;
    message(c:Connection,data:Buffer,binary:boolean):Promise<void>};
  internal.devices.set(remote.hostId,host);internal.controllers.set(remote.id,controller);
  const send=(from:Connection,message:object)=>internal.message(from,Buffer.from(JSON.stringify(message)),false);
  return {service,remote,sessions,host,controller,internal,modes,bus,send};
}

describe('access-code signaling isolation and race fencing',()=>{
  it('publishes the same code-only ready/session-start snapshot on Windows',async()=>{
    const f=signalingFixture();
    try {
      await f.internal.registerController(f.controller);
      const ready=JSON.parse(f.controller.socket.send.mock.calls[0][0]);
      const start=JSON.parse(f.host.socket.send.mock.calls[0][0]);
      expect(ready.session).toEqual(start.session);expect(start.session.purpose).toBe('access-code');
    } finally { await f.service.onModuleDestroy(); }
  });
  it.each(['replacement','mobile','missing-cap','browser-ticket','wrong-owner','view','cli-metadata'] as const)
  ('rejects %s before controller installation',async(kind)=>{
    const f=signalingFixture();
    if(kind==='replacement') f.internal.devices.set(f.remote.hostId,connection(f.host.ticket));
    if(kind==='mobile') Object.assign(f.host.ticket,{platform:'android'});
    if(kind==='missing-cap') Object.assign(f.host.ticket,{capabilities:[]});
    if(kind==='browser-ticket') Object.assign(f.controller.ticket,{browser:true});
    if(kind==='wrong-owner') f.host.ticket.ownerAccountId='other';
    if(kind==='view') f.remote.scope='view';
    if(kind==='cli-metadata') f.remote.cliProtocolVersion=1;
    try {
      await expect(f.internal.registerController(f.controller)).rejects.toThrow();
      expect(f.sessions.installController).not.toHaveBeenCalled();expect(f.host.socket.send).not.toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it.each(['before-install','after-install'] as const)('rechecks allowBrowser %s even without an epoch change',async(phase)=>{
    const f=signalingFixture();
    if(phase==='before-install') f.modes.get.mockResolvedValue({...await f.modes.get(),allowBrowser:false});
    else f.sessions.installController.mockImplementation(async(snapshot,install)=>{
      expect(install(snapshot)).toBe(true);f.modes.get.mockResolvedValue({epoch:snapshot.epoch,allowBrowser:false});return snapshot;
    });
    try {
      await expect(f.internal.registerController(f.controller)).rejects.toThrow();
      expect(f.host.socket.send).not.toHaveBeenCalled();expect(f.controller.socket.send).not.toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it('ends code authority instead of rebinding to a replacement endpoint',async()=>{
    const f=signalingFixture();
    try {
      await f.internal.registerDevice(connection(f.host.ticket));
      expect(f.sessions.endIfActive).toHaveBeenCalledWith('owner',f.remote.id,'host_protocol_changed');
      expect(f.sessions.bindHostEndpoint).not.toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it.each(['get-displays','select-display','access-code','cli','cli-chat','pointer','text'] as const)
  ('never relays %s payloads over signaling',async(type)=>{
    const f=signalingFixture();
    try {
      await f.send(f.controller,{type,sessionId:f.remote.id});
      expect(f.host.socket.send).not.toHaveBeenCalled();expect(f.controller.socket.close).toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it.each(['audio','video'])('rejects %s SDP but permits application-only offer/answer and ICE',async(media)=>{
    const f=signalingFixture();
    try {
      await f.send(f.controller,{type:'offer',sessionId:f.remote.id,sdp:`v=0\r\nm=${media} 9 UDP/TLS/RTP/SAVPF 96\r\n`});
      expect(f.host.socket.send).not.toHaveBeenCalled();
      const offer={type:'offer',sessionId:f.remote.id,sdp:'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'};
      await f.send(f.controller,offer);expect(f.host.socket.send).toHaveBeenCalledWith(JSON.stringify(offer));
    } finally { await f.service.onModuleDestroy(); }
  });
  it.each(['revoked','host-replaced','socket-closed'] as const)('fences %s during DB installation',async(kind)=>{
    const f=signalingFixture();f.internal.controllers.delete(f.remote.id);
    f.sessions.installController.mockImplementation(async(snapshot,install)=>{
      if(kind==='revoked') f.bus.emit({kind:'session',id:snapshot.id,reason:'revoked'});
      if(kind==='host-replaced') f.internal.devices.set(snapshot.hostId,connection(f.host.ticket));
      if(kind==='socket-closed') Object.assign(f.controller.socket,{readyState:WebSocket.CLOSED});
      if(!install(snapshot)) throw new Error('install denied');return snapshot;
    });
    try {
      await expect(f.internal.registerController(f.controller)).rejects.toThrow('install denied');
      expect(f.host.socket.send).not.toHaveBeenCalled();expect(f.internal.controllers.has(f.remote.id)).toBe(false);
    } finally { await f.service.onModuleDestroy(); }
  });
});
