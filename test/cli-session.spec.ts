import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CapabilityUpdateDto, ConnectDeviceDto, DeviceTicketDto, RegisterDeviceDto, BrowserRecoveryDto } from '../src/devices/device.dto';
import { endpointFeatures, negotiate, supportsSession } from '../src/common/protocol';
import { DeviceService, presentSession } from '../src/devices/device.service';
import { TicketService } from '../src/signaling/ticket.service';
import { HealthController } from '../src/health.controller';
import { SyncConfigService } from '../src/config/config.service';
import { testConfig } from './helpers';
import { validateWire } from '../src/generated/sync-wire';

function fixture() {
  const host={id:randomUUID(),platform:'macos'};
  const controller={id:randomUUID(),platform:'ios'};
  const grant={id:randomUUID(),scope:'control'};
  const auth={source:'native' as const,databaseId:randomUUID(),platform:'ios' as const,token:'opaque',csrfHash:'hash',
    account:{id:'owner',name:'Owner',permission:'member' as const}};
  const endpoint={id:randomUUID(),protocolVersion:2,capabilities:['bounded-lifetime'],cliProtocolVersion:1};
  const mode={epoch:randomUUID(),expiresAt:new Date(Date.now()+60000).toISOString(),allowBrowser:true};
  const devices={findOwned:jest.fn().mockResolvedValue(host),findGrant:jest.fn().mockResolvedValue(grant),audit:jest.fn()};
  const proofs={verify:jest.fn().mockResolvedValue(controller)};
  const modes={require:jest.fn().mockResolvedValue(mode),verifyPin:jest.fn().mockResolvedValue(mode)};
  const sessions={create:jest.fn(async(input)=>({...input,id:randomUUID(),controllerId:input.controllerDeviceId ?? 'browser',expiresAt:input.expiresAt.toISOString()})),
    endIfActive:jest.fn()};
  const tickets={activeEndpoint:jest.fn().mockResolvedValue(endpoint),issue:jest.fn().mockResolvedValue('ticket')};
  const service=new DeviceService(devices as never,proofs as never,modes as never,sessions as never,tickets as never,
    {forAccount:()=>[]} as never,{} as never,{} as never,new SyncConfigService(testConfig()));
  const input:ConnectDeviceDto={scope:'control',purpose:'cli',cliProtocolVersion:1,protocolVersion:2,
    controllerDeviceId:controller.id,challengeId:'x'.repeat(32),signature:'YQ=='};
  return {service,host,controller,grant,auth,endpoint,mode,devices,proofs,modes,sessions,tickets,input};
}

describe('CLI request validation and endpoint snapshots',()=>{
  const proof={deviceId:randomUUID(),challengeId:'x'.repeat(32),signature:'YQ=='};
  it.each([null,'1',0,2,1.5,true])('rejects CLI version %p rather than treating it as optional/default1',async(cliProtocolVersion)=>{
    for(const dto of [plainToInstance(DeviceTicketDto,{...proof,cliProtocolVersion}),
      plainToInstance(ConnectDeviceDto,{scope:'control',cliProtocolVersion})]) {
      expect(await validate(dto,{whitelist:true,forbidNonWhitelisted:true})).not.toEqual([]);
    }
  });
  it.each([null,'shell',1])('rejects purpose %p',async(purpose)=>{
    expect(await validate(plainToInstance(ConnectDeviceDto,{scope:'control',purpose}))).not.toEqual([]);
  });
  it('allows legacy and supported declarations only on ticket/connect',async()=>{
    for(const data of [proof,{...proof,protocolVersion:2,cliProtocolVersion:1}]) {
      expect(await validate(plainToInstance(DeviceTicketDto,data),{whitelist:true,forbidNonWhitelisted:true})).toEqual([]);
    }
    expect(await validate(plainToInstance(ConnectDeviceDto,{scope:'view',code:'123456'}))).toEqual([]);
    for(const type of [RegisterDeviceDto,CapabilityUpdateDto,BrowserRecoveryDto] as Array<new()=>object>) {
      const errors=await validate(plainToInstance(type,{cliProtocolVersion:1}),{whitelist:true,forbidNonWhitelisted:true});
      expect(errors.some(error=>error.property==='cliProtocolVersion' && error.constraints?.whitelistValidation)).toBe(true);
    }
    expect(await validate(plainToInstance(ConnectDeviceDto,{scope:'control',platform:'macos'}),
      {whitelist:true,forbidNonWhitelisted:true})).not.toEqual([]);
  });
  it('requires both live declarations/base2 and never upgrades old snapshots',()=>{
    const cli=endpointFeatures({protocolVersion:2,cliProtocolVersion:1});
    expect(endpointFeatures({cliProtocolVersion:1})).not.toHaveProperty('cliProtocolVersion');
    expect(endpointFeatures({protocolVersion:2,cliProtocolVersion:2})).not.toHaveProperty('cliProtocolVersion');
    expect(negotiate(cli,cli).cliProtocolVersion).toBe(1);
    expect(negotiate(cli,endpointFeatures({protocolVersion:2}))).not.toHaveProperty('cliProtocolVersion');
    expect(supportsSession(endpointFeatures({protocolVersion:2}),cli)).toBe(false);
    const old={protocolVersion:2,capabilities:[]};
    expect(supportsSession(cli,old)).toBe(true);
    expect(old).not.toHaveProperty('cliProtocolVersion');
  });
  it('normalizes live presence and leaves legacy presence unsupported',async()=>{
    const redis={key:(...parts:string[])=>parts.join(':'),client:{get:jest.fn()}};
    const tickets=new TicketService({} as never,redis as never);
    redis.client.get.mockResolvedValueOnce(JSON.stringify({id:'new',protocolVersion:2,capabilities:[],cliProtocolVersion:1}));
    expect(await tickets.activeEndpoint('host')).toMatchObject({id:'new',cliProtocolVersion:1});
    redis.client.get.mockResolvedValueOnce(JSON.stringify({id:'invalid',protocolVersion:2,capabilities:[],cliProtocolVersion:'1'}));
    expect(await tickets.activeEndpoint('host')).not.toHaveProperty('cliProtocolVersion');
    redis.client.get.mockResolvedValueOnce('old-socket');
    expect(await tickets.activeEndpoint('host')).toEqual({id:'old-socket',protocolVersion:1,capabilities:[]});
  });
  it('publishes the generated config feature and defaults session purpose without inventing CLI support',()=>{
    const config=new HealthController(new SyncConfigService(testConfig()),{} as never,{} as never).publicConfig();
    expect(config.features.cliSessions).toBe(true);
    expect(validateWire('WirePublicConfig',config)).toBe(true);
    const presented=presentSession({} as never);
    expect(presented.purpose).toBe('screen');
    expect(presented).not.toHaveProperty('cliProtocolVersion');
  });
});

describe('CLI connect authorization',()=>{
  it('snapshots eligible screen/control and cli-only sessions without adding display capabilities to cli-only',async()=>{
    for(const purpose of ['screen','cli'] as const) {
      const f=fixture();
      f.endpoint.capabilities.push('host-displays');
      const result=await f.service.connect(f.auth,f.host.id,{...f.input,purpose,capabilities:['viewer-displays']},'127.0.0.1');
      expect(result.session).toMatchObject({purpose,cliProtocolVersion:1,scope:'control'});
      expect(f.sessions.create).toHaveBeenCalledWith(expect.objectContaining({authorizationGrantId:f.grant.id,hostEndpointId:f.endpoint.id}));
      if(purpose==='cli') expect(result.session.capabilities).toEqual([]);
      expect(f.modes.verifyPin).not.toHaveBeenCalled();
    }
  });
  it.each(['browser','view','untrusted','view-grant','windows-host','missing-proof'] as const)('rejects explicit CLI with %s even with a valid PIN',async(kind)=>{
    const f=fixture();
    if(kind==='browser') Object.assign(f.auth,{source:'web',platform:'web'});
    if(kind==='view') f.input.scope='view';
    if(kind==='untrusted') f.devices.findGrant.mockResolvedValue(undefined);
    if(kind==='view-grant') f.grant.scope='view';
    if(kind==='windows-host') f.host.platform='windows';
    if(kind==='missing-proof') delete f.input.signature;
    await expect(f.service.connect(f.auth,f.host.id,{...f.input,code:'123456'},'127.0.0.1')).rejects.toMatchObject({status:403});
    expect(f.sessions.create).not.toHaveBeenCalled();
    expect(f.modes.verifyPin).not.toHaveBeenCalled();
  });
  it.each(['host-version','controller-version','host-base','controller-base'] as const)('returns the locked 426 shape for unsupported %s',async(kind)=>{
    const f=fixture();
    if(kind==='host-version') delete (f.endpoint as {cliProtocolVersion?:number}).cliProtocolVersion;
    if(kind==='controller-version') delete f.input.cliProtocolVersion;
    if(kind==='host-base') f.endpoint.protocolVersion=1;
    if(kind==='controller-base') f.input.protocolVersion=1;
    await expect(f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1')).rejects.toMatchObject({status:426,
      response:{statusCode:426,error:'cli-update-required',message:'Update both apps to support CLI sessions'}});
    expect(f.sessions.create).not.toHaveBeenCalled();
  });
  it.each(['browser','pin','view','windows'] as const)('preserves ordinary screen %s without granting CLI from a declaration',async(kind)=>{
    const f=fixture();
    f.input.purpose='screen';
    if(kind==='browser') { Object.assign(f.auth,{source:'web',platform:'web'}); delete f.input.controllerDeviceId;delete f.input.challengeId;delete f.input.signature; }
    if(kind==='pin') f.devices.findGrant.mockResolvedValue(undefined);
    if(kind==='view') f.input.scope='view';
    if(kind==='windows') f.host.platform='windows';
    const result=await f.service.connect(f.auth,f.host.id,{...f.input,code:'123456'},'127.0.0.1');
    expect(result.session.purpose).toBe('screen');
    expect(result.session).not.toHaveProperty('cliProtocolVersion');
  });
  it.each(['mode','endpoint'] as const)('cleans the new reservation when %s changes after INSERT',async(kind)=>{
    const f=fixture();
    if(kind==='mode') f.modes.require.mockResolvedValueOnce(f.mode).mockResolvedValueOnce({...f.mode,epoch:randomUUID()});
    else f.tickets.activeEndpoint.mockResolvedValueOnce(f.endpoint).mockResolvedValueOnce({...f.endpoint,id:randomUUID()});
    await expect(f.service.connect(f.auth,f.host.id,f.input,'127.0.0.1')).rejects.toThrow('changed');
    expect(f.sessions.endIfActive).toHaveBeenCalledWith('owner',expect.any(String),'connect_failed');
    expect(f.tickets.issue).not.toHaveBeenCalled();
  });
});
