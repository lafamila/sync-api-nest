import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { endpointFeatures, negotiate, requireBoundedHost, requireWebProtocol, supportsSession } from '../src/common/protocol';
import { CapabilityUpdateDto, ConnectDeviceDto, DeviceTicketDto, RegisterDeviceDto } from '../src/devices/device.dto';
import { canonicalDisplaySignal } from '../src/signaling/display-signal';
import { TicketController } from '../src/signaling/ticket.controller';
import { HealthController } from '../src/health.controller';
import { SyncConfigService } from '../src/config/config.service';
import { testConfig } from './helpers';
import { SYNC_CAPABILITIES, validateWire } from '../src/generated/sync-wire';

describe('endpoint protocol negotiation',()=>{
  it('requires the active host lifetime declaration independently of negotiated media/controller features',()=>{
    const host={protocolVersion:2,capabilities:['bounded-lifetime']};
    const legacy=endpointFeatures({});
    expect(()=>requireBoundedHost(legacy,true)).toThrow('Update the host app');
    expect(()=>requireBoundedHost(host,true)).not.toThrow();
    expect(()=>requireBoundedHost(legacy,false)).not.toThrow();
    const media=negotiate(host,legacy);
    expect(media).toEqual({protocolVersion:1,capabilities:[]});
    expect(supportsSession(host,media,true)).toBe(true);
    expect(supportsSession(legacy,media,true)).toBe(false);
    expect(supportsSession(legacy,media,false)).toBe(true);
  });
  it.each([true,false])('publishes requireBoundedHosts=%s without raising the native minimum protocol',(requireBoundedHosts)=>{
    const controller=new HealthController(new SyncConfigService(testConfig({requireBoundedHosts})),{} as never,{} as never);
    const config=controller.publicConfig();
    expect(config).toMatchObject({requireBoundedHosts,minimumProtocolVersion:1,minimumWebProtocolVersion:2});
    expect(config.capabilities).toContain('bounded-lifetime');
    expect(validateWire('WirePublicConfig',config)).toBe(true);
  });
  it('uses active declaration defaults rather than persisted metadata',()=>{
    expect(endpointFeatures({})).toEqual({protocolVersion:1,capabilities:[]});
    expect(negotiate(endpointFeatures({}),endpointFeatures({protocolVersion:2,capabilities:['viewer-displays']})))
      .toEqual({protocolVersion:1,capabilities:[]});
  });
  it('requires the host and viewer display roles and never upgrades a snapshot',()=>{
    const host={protocolVersion:2,capabilities:['host-displays']};
    expect(negotiate(host,{protocolVersion:2,capabilities:[]})).toEqual({protocolVersion:2,capabilities:[]});
    const effective=negotiate(host,{protocolVersion:2,capabilities:['viewer-displays']});
    expect(effective.capabilities).toEqual(['host-displays','viewer-displays']);
    expect(supportsSession({protocolVersion:1,capabilities:[]},effective)).toBe(false);
    expect(supportsSession({protocolVersion:2,capabilities:[]},effective)).toBe(false);
    expect(supportsSession(host,effective)).toBe(true);
  });
  it('gates the browser declaration, not the effective media version',()=>{
    expect(()=>requireWebProtocol()).toThrow('Reload Sync');
    expect(()=>requireWebProtocol(1)).toThrow();
    expect(()=>requireWebProtocol(2)).not.toThrow();
    expect(negotiate({protocolVersion:1,capabilities:[]},{protocolVersion:2,capabilities:[]})).toEqual({protocolVersion:1,capabilities:[]});
  });
  it('issues default1/empty tickets even for an upgraded stored device',async()=>{
    const tickets={issue:jest.fn().mockResolvedValue('ticket')};
    const proofs={verify:jest.fn().mockResolvedValue({id:'device',platform:'windows',protocolVersion:2,capabilities:['host-displays']})};
    const security={assertMutation:jest.fn(),assertNativeSession:jest.fn()};
    const controller=new TicketController(tickets as never,proofs as never,security as never);
    await controller.create({syncSession:{account:{id:'owner'},databaseId:'auth'}} as never,
      {deviceId:randomUUID(),challengeId:'x'.repeat(32),signature:'YQ=='});
    expect(tickets.issue).toHaveBeenLastCalledWith(expect.objectContaining({protocolVersion:1,capabilities:[]}));
  });
  it('publishes configured bounds and preserves the existing 12-hour default',()=>{
    const controller=new HealthController(new SyncConfigService(testConfig()),{} as never,{} as never);
    expect(controller.publicConfig()).toMatchObject({protocolVersion:2,minimumProtocolVersion:1,minimumWebProtocolVersion:2,
      webIdleTimeoutSeconds:900,modeDuration:{minimumSeconds:300,defaultSeconds:43200,maximumSeconds:86400}});
  });
});

describe('additive request validation',()=>{
  it('accepts all eight declared capabilities without allowing a ninth entry',async()=>{
    const proof={deviceId:randomUUID(),challengeId:'x'.repeat(32),signature:'YQ==',protocolVersion:2};
    expect(SYNC_CAPABILITIES).toHaveLength(8);
    expect(await validate(plainToInstance(DeviceTicketDto,{...proof,capabilities:[...SYNC_CAPABILITIES]}))).toEqual([]);
    expect(await validate(plainToInstance(DeviceTicketDto,{...proof,capabilities:[...SYNC_CAPABILITIES,'bounded-lifetime']}))).not.toEqual([]);
  });
  it('continues accepting exact legacy request fields and rejects unknown fields',async()=>{
    const input={scope:'view',code:'123456'};
    expect(await validate(plainToInstance(ConnectDeviceDto,input),{whitelist:true,forbidNonWhitelisted:true})).toEqual([]);
    expect(await validate(plainToInstance(ConnectDeviceDto,{...input,legacyBypass:true}),{whitelist:true,forbidNonWhitelisted:true})).not.toEqual([]);
    expect(await validate(plainToInstance(ConnectDeviceDto,{...input,protocolVersion:2,capabilities:['not-a-capability']}))).not.toEqual([]);
  });
  it('rejects duplicate/oversized metadata without changing legacy proof shape',async()=>{
    const proof={deviceId:randomUUID(),challengeId:'x'.repeat(32),signature:'YQ=='};
    expect(await validate(plainToInstance(DeviceTicketDto,proof))).toEqual([]);
    expect(await validate(plainToInstance(CapabilityUpdateDto,{...proof,capabilities:['host-displays','host-displays']}))).not.toEqual([]);
    expect(await validate(plainToInstance(RegisterDeviceDto,{name:'native',platform:'android',publicKey:'YQ==',...proof,clientVersion:'a'.repeat(65)}))).not.toEqual([]);
  });
});

describe('strict display wire payloads',()=>{
  const sessionId=randomUUID();
  const inputEpoch=randomUUID();
  const requestId=randomUUID();
  const display={id:'monitor-1',name:'Main',width:1920,height:1080,isPrimary:true};
  const metadata={type:'displays',sessionId,displays:[display],selectedDisplayId:display.id,inputEpoch};
  it('accepts bounded metadata, opaque IDs and correlated selections',()=>{
    expect(canonicalDisplaySignal(metadata)).toEqual(metadata);
    const select={type:'select-display',sessionId,displayId:display.id,inputEpoch,requestId};
    expect(canonicalDisplaySignal(select)).toEqual(select);
    expect(canonicalDisplaySignal({type:'get-displays',sessionId})).toEqual({type:'get-displays',sessionId});
  });
  it.each([0,-1,NaN,Infinity,0.5,32769])('rejects invalid dimension %s',(width)=>{
    expect(canonicalDisplaySignal({...metadata,displays:[{...display,width}]})).toBeUndefined();
  });
  it('rejects hidden SDP, malformed UUIDs, duplicate IDs, unknown selection, oversized arrays and strings',()=>{
    for(const value of [
      {...metadata,sdp:'v=0'}, {...metadata,inputEpoch:'bad'}, {...metadata,requestId:'bad'},
      {...metadata,displays:[display,display]}, {...metadata,selectedDisplayId:'missing'},
      {...metadata,displays:Array.from({length:33},(_,i)=>({...display,id:String(i)}))},
      {...metadata,displays:[{...display,name:'x'.repeat(257)}]},
      {type:'select-display',sessionId,displayId:'monitor',inputEpoch},
      {type:'display-error',sessionId,reason:'unknown'},
    ]) expect(canonicalDisplaySignal(value)).toBeUndefined();
  });
});
