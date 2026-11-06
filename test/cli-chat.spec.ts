import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BrowserRecoveryDto, CapabilityUpdateDto, ConnectDeviceDto, DeviceTicketDto, RegisterDeviceDto } from '../src/devices/device.dto';
import { endpointFeatures, negotiate, supportsSession } from '../src/common/protocol';
import { DeviceService, presentDevice, presentSession } from '../src/devices/device.service';
import { TicketService } from '../src/signaling/ticket.service';
import { SyncConfigService } from '../src/config/config.service';
import { HealthController } from '../src/health.controller';
import { RemoteSession, RemoteSessionRepository } from '../src/sessions/remote-session.repository';
import { SYNC_CAPABILITIES, SYNC_LIMITS, validateWire } from '../src/generated/sync-wire';
import { testConfig } from './helpers';

function fixture() {
  const host={id:randomUUID(),platform:'macos'};
  const controller={id:randomUUID(),platform:'ios'};
  const grant={id:randomUUID(),scope:'control'};
  const auth={source:'native' as const,databaseId:randomUUID(),platform:'ios' as const,token:'opaque',csrfHash:'hash',
    account:{id:'owner',name:'Owner',permission:'member' as const}};
  const endpoint={id:randomUUID(),protocolVersion:2,capabilities:['bounded-lifetime'],cliProtocolVersion:1,cliChatProtocolVersion:1};
  const mode={epoch:randomUUID(),expiresAt:new Date(Date.now()+60000).toISOString(),allowBrowser:true};
  const devices={findOwned:jest.fn().mockResolvedValue(host),findGrant:jest.fn().mockResolvedValue(grant),audit:jest.fn()};
  const proofs={verify:jest.fn().mockResolvedValue(controller)};
  const modes={require:jest.fn().mockResolvedValue(mode),verifyPin:jest.fn()};
  const sessions={create:jest.fn(async(input)=>({...input,id:randomUUID(),controllerId:input.controllerDeviceId,
    expiresAt:input.expiresAt.toISOString()})),endIfActive:jest.fn()};
  const tickets={activeEndpoint:jest.fn().mockResolvedValue(endpoint),issue:jest.fn().mockResolvedValue('ticket')};
  const service=new DeviceService(devices as never,proofs as never,modes as never,sessions as never,tickets as never,
    {forAccount:()=>[]} as never,{} as never,{} as never,new SyncConfigService(testConfig()));
  const input:ConnectDeviceDto={scope:'control',purpose:'cli',cliProtocolVersion:1,cliChatProtocolVersion:1,protocolVersion:2,
    controllerDeviceId:controller.id,challengeId:'x'.repeat(32),signature:'YQ=='};
  return {service,host,controller,grant,auth,endpoint,mode,devices,proofs,modes,sessions,tickets,input};
}

describe('CLI chat optional metadata compatibility',()=>{
  it.each([null,'1',0,2,true,1.5])('rejects non-v1 declaration %p',async(cliChatProtocolVersion)=>{
    for(const type of [ConnectDeviceDto,DeviceTicketDto] as Array<new()=>object>) {
      const dto=plainToInstance(type,{scope:'control',deviceId:randomUUID(),challengeId:'x'.repeat(32),signature:'YQ==',cliChatProtocolVersion});
      expect((await validate(dto)).some(error=>error.property==='cliChatProtocolVersion')).toBe(true);
    }
  });
  it('accepts omission/v1 on ticket and connect only, never registration, capabilities or browser recovery',async()=>{
    for(const version of [undefined,1]) {
      const proof={deviceId:randomUUID(),challengeId:'x'.repeat(32),signature:'YQ=='};
      const metadata=version===undefined?{}:{cliChatProtocolVersion:version,cliProtocolVersion:1,protocolVersion:2};
      expect(await validate(plainToInstance(DeviceTicketDto,{...proof,...metadata}),{whitelist:true,forbidNonWhitelisted:true})).toEqual([]);
      expect(await validate(plainToInstance(ConnectDeviceDto,{scope:'control',...metadata}),{whitelist:true,forbidNonWhitelisted:true})).toEqual([]);
    }
    for(const type of [RegisterDeviceDto,CapabilityUpdateDto,BrowserRecoveryDto] as Array<new()=>object>) {
      const errors=await validate(plainToInstance(type,{cliChatProtocolVersion:1}),{whitelist:true,forbidNonWhitelisted:true});
      expect(errors.some(error=>error.property==='cliChatProtocolVersion' && error.constraints?.whitelistValidation)).toBe(true);
    }
  });
  it('requires base2/CLI1 plus both actual endpoint chat declarations',()=>{
    const chat=endpointFeatures({protocolVersion:2,cliProtocolVersion:1,cliChatProtocolVersion:1});
    expect(negotiate(chat,chat)).toMatchObject({cliProtocolVersion:1,cliChatProtocolVersion:1});
    for(const declaration of [{cliChatProtocolVersion:1},{protocolVersion:2,cliChatProtocolVersion:1},
      {protocolVersion:1,cliProtocolVersion:1,cliChatProtocolVersion:1},
      {protocolVersion:2,cliProtocolVersion:1,cliChatProtocolVersion:2},
      {protocolVersion:2,cliProtocolVersion:1}]) {
      const legacy=endpointFeatures(declaration);
      expect(legacy).not.toHaveProperty('cliChatProtocolVersion');
      expect(negotiate(chat,legacy)).not.toHaveProperty('cliChatProtocolVersion');
      expect(negotiate(legacy,chat)).not.toHaveProperty('cliChatProtocolVersion');
      expect(supportsSession(legacy,chat)).toBe(false);
    }
    const cli=endpointFeatures({protocolVersion:2,cliProtocolVersion:1});
    expect(supportsSession(chat,cli)).toBe(true);
    expect(cli).not.toHaveProperty('cliChatProtocolVersion');
    expect(supportsSession(chat,{protocolVersion:2,capabilities:[],cliChatProtocolVersion:1})).toBe(false);
  });
  it('publishes optional config and only current presence support, not persisted metadata',async()=>{
    const f=fixture();
    const redis={key:(...parts:string[])=>parts.join(':'),client:{get:jest.fn().mockResolvedValue(JSON.stringify(f.endpoint))}};
    const tickets=new TicketService({} as never,redis as never);
    const active=await tickets.activeEndpoint(f.host.id);
    expect(active).toMatchObject({cliChatProtocolVersion:1});
    const persisted={...f.host,protocolVersion:2,capabilities:[],cliChatProtocolVersion:1};
    expect(presentDevice(persisted as never,active)).toHaveProperty('cliChatProtocolVersion',1);
    expect(presentDevice(persisted as never)).not.toHaveProperty('cliChatProtocolVersion');
    redis.client.get.mockResolvedValue(JSON.stringify({...f.endpoint,cliChatProtocolVersion:'1'}));
    expect(await tickets.activeEndpoint(f.host.id)).not.toHaveProperty('cliChatProtocolVersion');
    expect(presentSession({} as never)).not.toHaveProperty('cliChatProtocolVersion');
    const config=new HealthController(new SyncConfigService(testConfig()),{} as never,{} as never).publicConfig();
    expect(config.features.cliChat).toBe(true);
    expect(validateWire('WirePublicConfig',config)).toBe(true);
    expect(SYNC_CAPABILITIES).toHaveLength(8);
    expect(SYNC_LIMITS.cliProtocolVersion).toBe(1);
  });
});

describe('CLI chat native/control admission',()=>{
  it.each(['screen','cli'] as const)('snapshots %s chat only after native proof/control grant',async(purpose)=>{
    const f=fixture();
    const result=await f.service.connect(f.auth,f.host.id,{...f.input,purpose},'127.0.0.1');
    expect(result.session).toMatchObject({purpose,cliProtocolVersion:1,cliChatProtocolVersion:1});
    expect(f.sessions.create).toHaveBeenCalledWith(expect.objectContaining({hostEndpointId:f.endpoint.id,epoch:f.mode.epoch,
      authorizationGrantId:f.grant.id,controllerDeviceId:f.controller.id}));
    expect(f.proofs.verify).toHaveBeenCalledTimes(1);
    expect(f.modes.verifyPin).not.toHaveBeenCalled();
  });
  it.each(['browser','view','pin','missing-grant','view-grant','missing-proof','self-controller','windows','missing-host','other-owner'] as const)
  ('rejects %s without creating a row or consuming PIN',async(kind)=>{
    const f=fixture();
    if(kind==='browser') Object.assign(f.auth,{source:'web',platform:'web'});
    if(kind==='view') f.input.scope='view';
    if(kind==='pin') f.input.code='123456';
    if(kind==='missing-grant') f.devices.findGrant.mockResolvedValue(undefined);
    if(kind==='view-grant') f.grant.scope='view';
    if(kind==='missing-proof') delete f.input.signature;
    if(kind==='self-controller') f.input.controllerDeviceId=f.host.id;
    if(kind==='windows') f.host.platform='windows';
    if(kind==='missing-host' || kind==='other-owner') f.devices.findOwned.mockResolvedValue(undefined);
    await expect(f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1')).rejects.toMatchObject({status:403});
    expect(f.sessions.create).not.toHaveBeenCalled();
    expect(f.modes.verifyPin).not.toHaveBeenCalled();
  });
  it.each(['host-chat','host-cli','host-base','controller-cli','controller-base'] as const)('returns426 for incompatible %s without fallback',async(kind)=>{
    const f=fixture();
    if(kind==='host-chat') delete (f.endpoint as {cliChatProtocolVersion?:number}).cliChatProtocolVersion;
    if(kind==='host-cli') delete (f.endpoint as {cliProtocolVersion?:number}).cliProtocolVersion;
    if(kind==='host-base') f.endpoint.protocolVersion=1;
    if(kind==='controller-cli') delete f.input.cliProtocolVersion;
    if(kind==='controller-base') f.input.protocolVersion=1;
    await expect(f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1')).rejects.toMatchObject({status:426,response:{error:'cli-chat-update-required'}});
    expect(f.sessions.create).not.toHaveBeenCalled();
  });
  it('keeps legacy CLI1 sends and screen snapshots unchanged on a new host',async()=>{
    const f=fixture();
    delete f.input.cliChatProtocolVersion;
    const result=await f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1');
    expect(result.session.cliProtocolVersion).toBe(1);
    expect(result.session).not.toHaveProperty('cliChatProtocolVersion');
  });
  it.each(['endpoint','mode','declaration'] as const)('cleans the reservation on post-INSERT %s changes',async(kind)=>{
    const f=fixture();
    if(kind==='endpoint') f.tickets.activeEndpoint.mockResolvedValueOnce(f.endpoint).mockResolvedValueOnce({...f.endpoint,id:randomUUID()});
    if(kind==='declaration') f.tickets.activeEndpoint.mockResolvedValueOnce(f.endpoint).mockResolvedValueOnce({...f.endpoint,cliChatProtocolVersion:undefined});
    if(kind==='mode') f.modes.require.mockResolvedValueOnce(f.mode).mockResolvedValueOnce({...f.mode,epoch:randomUUID()});
    await expect(f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1')).rejects.toMatchObject({status:403});
    expect(f.sessions.endIfActive).toHaveBeenCalledWith('owner',expect.any(String),'connect_failed');
    expect(f.tickets.issue).not.toHaveBeenCalled();
  });
});

describe('CLI chat repository snapshot fences without a DB',()=>{
  it.each([undefined,0,2])('rejects chat with invalid CLI prerequisite %p before querying',async(cliProtocolVersion)=>{
    const query=jest.fn();
    const repository=new RemoteSessionRepository({transaction:(work:(query:unknown)=>unknown)=>work(query)} as never);
    await expect(repository.create({cliChatProtocolVersion:1,cliProtocolVersion} as never)).rejects.toMatchObject({status:403});
    expect(query).not.toHaveBeenCalled();
  });
  it('does not silently upgrade a null snapshot while installing or binding',async()=>{
    const query=jest.fn().mockResolvedValue({rows:[{id:'found'}],rowCount:1});
    const repository=new RemoteSessionRepository({transaction:(work:(query:unknown)=>unknown)=>work(query)} as never);
    const snapshot={id:randomUUID(),epoch:randomUUID(),ownerAccountId:'owner',hostId:randomUUID(),authSessionId:randomUUID(),
      controllerKind:'native',controllerDeviceId:randomUUID(),scope:'control',protocolVersion:2,hostEndpointId:'endpoint',
      authorizationGrantId:randomUUID(),purpose:'cli',cliProtocolVersion:1,cliChatProtocolVersion:1} as RemoteSession;
    query.mockImplementation(async(sql:string)=>sql.includes('update sync_remote_sessions')?{rows:[],rowCount:0}:
      {rows:[{id:'found'}],rowCount:sql.includes('id=any')?2:1});
    await expect(repository.installController(snapshot,()=>true)).rejects.toMatchObject({status:403});
    expect(query).toHaveBeenCalledWith(expect.stringContaining('cli_chat_protocol_version is not distinct from $8::integer and mode_epoch=$9'),
      expect.arrayContaining([1,snapshot.epoch]));
    expect(await repository.bindHostEndpoint(snapshot,'endpoint',()=>true)).toBeUndefined();
    const update=query.mock.calls.filter(([sql])=>sql.includes('update sync_remote_sessions')).at(-1)!;
    expect(update[1].slice(-2)).toEqual([1,snapshot.epoch]);
  });
});
