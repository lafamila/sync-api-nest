import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConnectDeviceDto, DeviceTicketDto, RegisterDeviceDto, CapabilityUpdateDto, SetModeDto, ApproveGrantDto } from '../src/devices/device.dto';
import { DeviceService, presentDevice } from '../src/devices/device.service';
import { ModeService } from '../src/devices/mode.service';
import { SyncConfigService } from '../src/config/config.service';
import { TicketController } from '../src/signaling/ticket.controller';
import { endpointFeatures, negotiate, supportsSession } from '../src/common/protocol';
import { HealthController } from '../src/health.controller';
import { testConfig } from './helpers';
import { SYNC_CAPABILITIES, decodeWire, WireFeatureFlags, WireMode } from '../src/generated/sync-wire';
import { WebSocket } from 'ws';
import { RemoteSession } from '../src/sessions/remote-session.repository';
import { TicketPayload } from '../src/signaling/ticket.service';
import { SignalingService } from '../src/signaling/signaling.service';
import { RevocationBusService } from '../src/common/revocation-bus.service';

function fixture() {
  const host={id:randomUUID(),platform:'android'};
  const controller={id:randomUUID(),platform:'ios'};
  const grant={id:randomUUID(),scope:'control'};
  const auth={source:'native' as const,databaseId:randomUUID(),platform:'ios' as const,token:'synthetic',csrfHash:'synthetic',
    account:{id:'owner',name:'Synthetic',permission:'member' as const}};
  const endpoint={id:randomUUID(),protocolVersion:2,capabilities:['screen-host','input-host','bounded-lifetime'],androidControlProtocolVersion:1};
  const mode={epoch:randomUUID(),expiresAt:new Date(Date.now()+60000).toISOString(),allowBrowser:false,allowControl:true};
  const devices={findOwned:jest.fn().mockResolvedValue(host),findGrant:jest.fn().mockResolvedValue(grant),audit:jest.fn(),
    rememberGrant:jest.fn(async(_owner,_host,id,scope)=>({...grant,controllerDeviceId:id,scope,endedSessionIds:['ended']})),
    listGrants:jest.fn().mockResolvedValue([grant])};
  const proofs={verify:jest.fn().mockResolvedValue(controller)};
  const modes={require:jest.fn().mockResolvedValue(mode),verifyPin:jest.fn()};
  const sessions={create:jest.fn(async(input,validateAuthority?:()=>Promise<boolean>)=>{
    if(validateAuthority && !await validateAuthority()) throw new Error('authority revoked');
    return {...input,id:randomUUID(),controllerId:input.controllerDeviceId,expiresAt:input.expiresAt.toISOString()};
  }),endIfActive:jest.fn()};
  const tickets={activeEndpoint:jest.fn().mockResolvedValue(endpoint),issue:jest.fn().mockResolvedValue('ticket')};
  const bus={emit:jest.fn()};
  const service=new DeviceService(devices as never,proofs as never,modes as never,sessions as never,tickets as never,
    {forAccount:()=>[]} as never,{} as never,bus as never,new SyncConfigService(testConfig()));
  const input:ConnectDeviceDto={scope:'control',protocolVersion:2,capabilities:['bounded-lifetime'],androidControlProtocolVersion:1,
    controllerDeviceId:controller.id,challengeId:'x'.repeat(32),signature:'YQ=='};
  return {service,host,controller,grant,auth,endpoint,mode,devices,proofs,modes,sessions,tickets,bus,input};
}

describe('Android control admission',()=>{
  it('uses host-role input-host, immutable version1, no controller input-host requirement and strips CLI/chat',async()=>{
    const f=fixture();
    const result=await f.service.connect(f.auth,f.host.id,{...f.input,cliProtocolVersion:1,cliChatProtocolVersion:1},'127.0.0.1');
    expect(result.session).toMatchObject({purpose:'screen',scope:'control',androidControlProtocolVersion:1,capabilities:['bounded-lifetime','input-host']});
    expect(result.session).not.toHaveProperty('cliProtocolVersion');expect(result.session).not.toHaveProperty('cliChatProtocolVersion');
    expect(f.sessions.create).toHaveBeenCalledWith(expect.objectContaining({authorizationGrantId:f.grant.id,hostEndpointId:f.endpoint.id}),expect.any(Function));
    expect(f.modes.verifyPin).not.toHaveBeenCalled();
  });
  it.each(['web','pin','empty-pin','no-grant','view-grant','no-proof','self','ios','mode-off','legacy-mode','offline'] as const)
  ('rejects %s without PIN fallback or reservations',async(kind)=>{
    const f=fixture();
    if(kind==='web') Object.assign(f.auth,{source:'web',platform:'web'});
    if(kind==='pin') f.input.code='123456';
    if(kind==='empty-pin') f.input.code='';
    if(kind==='no-grant') f.devices.findGrant.mockResolvedValue(undefined);
    if(kind==='view-grant') f.grant.scope='view';
    if(kind==='no-proof') delete f.input.signature;
    if(kind==='self') f.input.controllerDeviceId=f.host.id;
    if(kind==='ios') f.host.platform='ios';
    if(kind==='mode-off') f.mode.allowControl=false;
    if(kind==='legacy-mode') delete (f.mode as {allowControl?:boolean}).allowControl;
    if(kind==='offline') f.tickets.activeEndpoint.mockResolvedValue(undefined);
    await expect(f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1')).rejects.toThrow();
    expect(f.sessions.create).not.toHaveBeenCalled();expect(f.tickets.issue).not.toHaveBeenCalled();expect(f.modes.verifyPin).not.toHaveBeenCalled();
  });
  it.each(['host-version','controller-version','host-base','controller-base','host-capability'] as const)
  ('fails426 for %s',async(kind)=>{
    const f=fixture();
    if(kind==='host-version') delete (f.endpoint as {androidControlProtocolVersion?:number}).androidControlProtocolVersion;
    if(kind==='controller-version') delete f.input.androidControlProtocolVersion;
    if(kind==='host-base') f.endpoint.protocolVersion=1;
    if(kind==='controller-base') f.input.protocolVersion=1;
    if(kind==='host-capability') f.endpoint.capabilities=[];
    await expect(f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1')).rejects.toMatchObject({status:426,response:{error:'android-control-update-required'}});
    expect(f.sessions.create).not.toHaveBeenCalled();
  });
  it.each(['epoch','endpoint','version','input-host','allowControl'] as const)('rechecks %s under creation authority callback',async(kind)=>{
    const f=fixture();
    if(kind==='epoch') f.modes.require.mockResolvedValueOnce(f.mode).mockResolvedValue({...f.mode,epoch:randomUUID()});
    if(kind==='allowControl') f.modes.require.mockResolvedValueOnce(f.mode).mockResolvedValue({...f.mode,allowControl:false});
    if(kind==='endpoint') f.tickets.activeEndpoint.mockResolvedValueOnce(f.endpoint).mockResolvedValue({...f.endpoint,id:randomUUID()});
    if(kind==='version') f.tickets.activeEndpoint.mockResolvedValueOnce(f.endpoint).mockResolvedValue({...f.endpoint,androidControlProtocolVersion:undefined});
    if(kind==='input-host') f.tickets.activeEndpoint.mockResolvedValueOnce(f.endpoint).mockResolvedValue({...f.endpoint,capabilities:[]});
    await expect(f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1')).rejects.toThrow('authority revoked');
    expect(f.tickets.issue).not.toHaveBeenCalled();
  });
  it('cleans a post-create mode downgrade before issuing the controller ticket',async()=>{
    const f=fixture();f.sessions.create.mockImplementationOnce(async(input)=>{
      f.mode.allowControl=false;
      return {...input,id:randomUUID(),controllerId:input.controllerDeviceId,expiresAt:input.expiresAt.toISOString()};
    });
    await expect(f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1')).rejects.toMatchObject({status:403});
    expect(f.sessions.endIfActive).toHaveBeenCalledWith('owner',expect.any(String),'connect_failed');expect(f.tickets.issue).not.toHaveBeenCalled();
  });
  it.each(['android','ios','macos','windows'])('does not grant Android version to %s view sessions',async(platform)=>{
    const f=fixture();f.host.platform=platform;f.input.scope='view';
    const result=await f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1');
    expect(result.session).not.toHaveProperty('androidControlProtocolVersion');
  });
  it.each(['screen','cli','access-code'] as const)('does not grant desktop %s an Android version',async(purpose)=>{
    const f=fixture();f.host.platform='macos';f.mode.allowBrowser=true;
    Object.assign(f.endpoint,{capabilities:[...SYNC_CAPABILITIES],cliProtocolVersion:1});
    const result=await f.service.connect(f.auth,f.host.id,{...f.input,purpose,capabilities:[...SYNC_CAPABILITIES],cliProtocolVersion:1},'127.0.0.1');
    expect(result.session).not.toHaveProperty('androidControlProtocolVersion');
  });
  it('presents only live Android host declarations, never persistent metadata',()=>{
    const f=fixture();const device={...f.host,capabilities:[],protocolVersion:1};
    expect(presentDevice(device as never,f.endpoint)).toMatchObject({protocolVersion:2,androidControlProtocolVersion:1,capabilities:f.endpoint.capabilities});
    expect(presentDevice(device as never)).not.toHaveProperty('androidControlProtocolVersion');
    expect(presentDevice({...device,platform:'macos'} as never,f.endpoint)).not.toHaveProperty('androidControlProtocolVersion');
    expect(negotiate(f.endpoint,endpointFeatures(f.input))).not.toHaveProperty('androidControlProtocolVersion');
    expect(supportsSession({...f.endpoint,androidControlProtocolVersion:undefined},{...f.endpoint,androidControlProtocolVersion:1})).toBe(false);
  });
});

type Connection={id:string;ticket:TicketPayload;socket:WebSocket & {send:jest.Mock;close:jest.Mock};lastPongAt:number;lastPingAt:number};
function connection(ticket:TicketPayload):Connection {
  return {id:randomUUID(),ticket,socket:{readyState:WebSocket.OPEN,send:jest.fn(),close:jest.fn()} as unknown as Connection['socket'],
    lastPongAt:Date.now(),lastPingAt:0};
}
function signalingFixture() {
  const f=fixture();
  const host=connection({role:'device',ownerAccountId:'owner',deviceId:f.host.id,platform:'android',authSessionId:'host-auth',...f.endpoint});
  const remote:RemoteSession={id:randomUUID(),ownerAccountId:'owner',hostId:f.host.id,controllerDeviceId:f.controller.id,controllerId:f.controller.id,
    controllerKind:'native',scope:'control',purpose:'screen',epoch:f.mode.epoch,authSessionId:f.auth.databaseId,
    authorizationGrantId:f.grant.id,createdAt:new Date().toISOString(),expiresAt:f.mode.expiresAt,endedAt:null,endReason:null,
    runtimeNamespace:'test',signalingInstanceId:randomUUID(),protocolVersion:2,capabilities:['input-host','bounded-lifetime'],androidControlProtocolVersion:1,
    hostEndpointId:host.id,lastActivityAt:null,idleDeadline:null};
  const sessions={findActive:jest.fn().mockResolvedValue(remote),findActiveForHost:jest.fn().mockResolvedValue([remote]),
    installController:jest.fn(async(snapshot:RemoteSession,install:(s:RemoteSession)=>boolean,validate?:()=>Promise<boolean>)=>{
      if(validate && !await validate()) throw new Error('authority revoked');
      if(!install(snapshot)) throw new Error('install denied');return snapshot;
    }),bindHostEndpoint:jest.fn(),endIfActive:jest.fn(),endForDevice:jest.fn(),endForInstance:jest.fn().mockResolvedValue([])};
  const bus=new RevocationBusService(),modes={get:jest.fn().mockResolvedValue(f.mode)};
  const service=new SignalingService({} as never,{} as never,{findOwned:async()=>f.host,touch:async()=>{}} as never,
    sessions as never,modes as never,{forAccount:()=>[]} as never,
    {key:(...p:string[])=>p.join(':'),client:{set:async()=>{},eval:async()=>1}} as never,
    {revalidateById:async()=>{}} as never,{} as never,bus,new SyncConfigService(testConfig()));
  const controller=connection({role:'controller',ownerAccountId:'owner',sessionId:remote.id,browser:false,authSessionId:remote.authSessionId});
  const internal=service as unknown as {devices:Map<string,Connection>;controllers:Map<string,Connection>;
    registerDevice(c:Connection):Promise<void>;registerController(c:Connection):Promise<void>;
    message(c:Connection,data:Buffer,binary:boolean):Promise<void>};
  internal.devices.set(remote.hostId,host);internal.controllers.set(remote.id,controller);
  return {service,remote,sessions,host,controller,internal,modes,bus};
}

describe('Android control signaling snapshot fences',()=>{
  it('publishes the same genuine control snapshot to both original peers',async()=>{
    const f=signalingFixture();
    try {
      await f.internal.registerController(f.controller);
      const ready=JSON.parse(f.controller.socket.send.mock.calls[0][0]),start=JSON.parse(f.host.socket.send.mock.calls[0][0]);
      expect(ready.session).toEqual(start.session);expect(start.session).toMatchObject({androidControlProtocolVersion:1,scope:'control'});
    } finally { await f.service.onModuleDestroy(); }
  });
  it.each(['endpoint','platform','missing-version','missing-input-host','browser','owner','view','cli','code','self','grant','mode'] as const)
  ('rejects %s before installation',async(kind)=>{
    const f=signalingFixture();
    if(kind==='endpoint') f.internal.devices.set(f.remote.hostId,connection(f.host.ticket));
    if(kind==='platform') Object.assign(f.host.ticket,{platform:'ios'});
    if(kind==='missing-version') Object.assign(f.host.ticket,{androidControlProtocolVersion:undefined});
    if(kind==='missing-input-host') Object.assign(f.host.ticket,{capabilities:['bounded-lifetime']});
    if(kind==='browser') Object.assign(f.controller.ticket,{browser:true});
    if(kind==='owner') f.host.ticket.ownerAccountId='other';
    if(kind==='view') f.remote.scope='view';
    if(kind==='cli') f.remote.cliProtocolVersion=1;
    if(kind==='code') f.remote.purpose='access-code';
    if(kind==='self') f.remote.controllerDeviceId=f.remote.hostId;
    if(kind==='grant') f.remote.authorizationGrantId=null;
    if(kind==='mode') f.modes.get.mockResolvedValue({epoch:f.remote.epoch,allowControl:false});
    try {
      await expect(f.internal.registerController(f.controller)).rejects.toThrow();
      expect(f.sessions.installController).not.toHaveBeenCalled();expect(f.host.socket.send).not.toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it('never rebinds control to a replacement host endpoint',async()=>{
    const f=signalingFixture();
    try {
      await f.internal.registerDevice(connection(f.host.ticket));
      expect(f.sessions.endIfActive).toHaveBeenCalledWith('owner',f.remote.id,'host_protocol_changed');
      expect(f.sessions.bindHostEndpoint).not.toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it('rechecks raw same-epoch allowControl downgrade after installation',async()=>{
    const f=signalingFixture();f.sessions.installController.mockImplementationOnce(async(snapshot,install)=>{
      expect(install(snapshot)).toBe(true);f.modes.get.mockResolvedValue({epoch:snapshot.epoch,allowControl:false});return snapshot;
    });
    try {
      await expect(f.internal.registerController(f.controller)).rejects.toThrow();
      expect(f.host.socket.send).not.toHaveBeenCalled();expect(f.controller.socket.send).not.toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it.each(['key','pointer','text','cli','cli-chat','access-code'])('never forwards %s input over signaling',async(type)=>{
    const f=signalingFixture();
    try {
      await f.internal.message(f.controller,Buffer.from(JSON.stringify({type,sessionId:f.remote.id,key:'AndroidHome'})),false);
      expect(f.host.socket.send).not.toHaveBeenCalled();expect(f.controller.socket.close).toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
});

describe('Android grants, modes and request compatibility',()=>{
  it.each([['android',undefined,'view'],['android','control','control'],['ios',undefined,'view'],['macos',undefined,'control'],['windows',undefined,'control']] as const)
  ('approves %s with explicit/default scope %s',async(platform,scope,expected)=>{
    const f=fixture();f.host.platform=platform;f.proofs.verify.mockResolvedValue(f.host);
    f.devices.findOwned.mockResolvedValue(f.controller);
    const result=await f.service.approveGrant(f.auth,f.host.id,{deviceId:f.host.id,challengeId:'x'.repeat(32),signature:'YQ==',controllerDeviceId:f.controller.id,scope});
    expect(result.grant.scope).toBe(expected);
    expect(f.bus.emit).toHaveBeenCalledWith({kind:'session',id:'ended',reason:'grant_scope_changed'});
  });
  it('rejects explicit iOS control approval and lists actual scope',async()=>{
    const f=fixture();f.host.platform='ios';f.proofs.verify.mockResolvedValue(f.host);
    await expect(f.service.approveGrant(f.auth,f.host.id,{deviceId:f.host.id,challengeId:'x'.repeat(32),signature:'YQ==',controllerDeviceId:f.controller.id,scope:'control'})).rejects.toMatchObject({status:403});
    expect(f.devices.rememberGrant).not.toHaveBeenCalled();
    expect((await f.service.listGrants(f.auth,f.host.id)).grants[0].scope).toBe('control');
  });
  it('enables the first Android input mode before socket/capture; legacy Redis modes default false',async()=>{
    const f=fixture();let raw:string|null=null;
    const redis={key:(...p:string[])=>p.join(':'),client:{get:async()=>raw,set:jest.fn(async(_key,value)=>{raw=value;}),del:jest.fn()}};
    const sessions={endForHost:jest.fn()};
    const modes=new ModeService(new SyncConfigService(testConfig()),redis as never,sessions as never);
    const enabled=await modes.set(f.auth.account,f.host as never,{enabled:true,allowBrowser:false,allowControl:true});
    expect(enabled.mode?.allowControl).toBe(true);expect(enabled).not.toHaveProperty('code');
    const legacy=JSON.parse(raw!);delete legacy.allowControl;raw=JSON.stringify(legacy);
    expect((await modes.require('owner',f.host.id)).allowControl).toBe(false);
    expect((await modes.get('owner',f.host.id))?.allowControl).toBe(false);
    await expect(modes.set(f.auth.account,{...f.host,platform:'ios'} as never,{enabled:true,allowBrowser:false,allowControl:true})).rejects.toThrow('Android-only');
    await modes.set(f.auth.account,f.host as never,{enabled:false,allowBrowser:false});
    expect(sessions.endForHost).toHaveBeenCalledWith(f.host.id,'mode_disabled');
  });
  it('restricts request version metadata to ticket/connect, rejects null/unsupported and leaves old DTOs valid',async()=>{
    const proof={deviceId:randomUUID(),challengeId:'x'.repeat(32),signature:'YQ=='};
    for(const Dto of [DeviceTicketDto,ConnectDeviceDto]) {
      const input=Dto===DeviceTicketDto?proof:{scope:'control'};
      for(const version of [undefined,1]) expect(await validate(plainToInstance(Dto as typeof DeviceTicketDto,{...input,androidControlProtocolVersion:version}),{whitelist:true,forbidNonWhitelisted:true})).toEqual([]);
      for(const version of [null,0,2,'1',true]) expect((await validate(plainToInstance(Dto as typeof DeviceTicketDto,{...input,androidControlProtocolVersion:version})))).not.toEqual([]);
    }
    for(const Dto of [RegisterDeviceDto,CapabilityUpdateDto]) {
      const errors=await validate(plainToInstance(Dto as typeof RegisterDeviceDto,{...proof,androidControlProtocolVersion:1}),{whitelist:true,forbidNonWhitelisted:true});
      expect(errors.some(error=>error.property==='androidControlProtocolVersion' && error.constraints?.whitelistValidation)).toBe(true);
    }
    expect(await validate(plainToInstance(SetModeDto,{...proof,enabled:true,allowBrowser:false}))).toEqual([]);
    expect(await validate(plainToInstance(ApproveGrantDto,{...proof,controllerDeviceId:randomUUID()}))).toEqual([]);
    expect(decodeWire<WireFeatureFlags>('WireFeatureFlags',{}).androidControl).toBeUndefined();
    expect(decodeWire<WireMode>('WireMode',{epoch:randomUUID(),expiresAt:new Date().toISOString(),allowBrowser:false}).allowControl).toBe(false);
    const config=new HealthController(new SyncConfigService(testConfig()),{} as never,{} as never).publicConfig();
    expect(config.features.androidControl).toBe(true);expect(config.capabilities).toHaveLength(7);
  });
  it.each(['android','ios','macos','windows'])('tickets advertise Android host input only on eligible %s',async(platform)=>{
    const f=fixture();f.host.platform=platform;
    const controller=new TicketController(f.tickets as never,{verify:async()=>f.host} as never,
      {assertMutation:()=>{},assertNativeSession:()=>{}} as never);
    await controller.create({syncSession:f.auth} as never,{deviceId:f.host.id,challengeId:'x'.repeat(32),signature:'YQ==',
      protocolVersion:2,capabilities:['input-host'],androidControlProtocolVersion:1});
    const payload=f.tickets.issue.mock.calls[0] as unknown as [Record<string,unknown>];
    expect(payload[0].androidControlProtocolVersion).toBe(platform==='android'?1:undefined);
  });
});
