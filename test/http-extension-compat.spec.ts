import 'reflect-metadata';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import express, { Request, Response } from 'express';
import { AuthenticatedRequest, AuthSessionContext } from '../src/common/request';
import { supportsAccessCodeProjection } from '../src/common/http-extensions';
import { RequestSecurityService } from '../src/common/request-security.service';
import { sha256 } from '../src/common/crypto';
import { HealthController } from '../src/health.controller';
import { DeviceController } from '../src/devices/device.controller';
import { DeviceService } from '../src/devices/device.service';
import { RemoteSessionController } from '../src/sessions/remote-session.controller';
import { RemoteSession } from '../src/sessions/remote-session.repository';
import { SyncConfigService } from '../src/config/config.service';
import { SYNC_CAPABILITIES, validateWire } from '../src/generated/sync-wire';
import { testConfig } from './helpers';

const legacy:{$defs:{Capability:{enum:string[]};Capabilities:{maxItems:number};SessionPurpose:{enum:string[]}}}=
  require('./fixtures/legacy-catalog7.json');

function response():Response {
  // Exercise Express vary/setHeader with a real HTTP response without opening a socket.
  return Object.setPrototypeOf(new ServerResponse(new IncomingMessage(new Socket())),express.response) as Response;
}
function oldCapabilities(value:readonly string[]):boolean {
  return value.length<=legacy.$defs.Capabilities.maxItems && new Set(value).size===value.length &&
    value.every(capability=>legacy.$defs.Capability.enum.includes(capability));
}
function fixture() {
  const config=new SyncConfigService(testConfig());
  const auth:AuthSessionContext={source:'native',databaseId:randomUUID(),platform:'android',token:'synthetic',csrfHash:'synthetic',
    account:{id:'synthetic-owner',name:'Synthetic',permission:'member'}};
  const host={id:randomUUID(),name:'Synthetic desktop',platform:'windows',protocolVersion:2,capabilities:[...SYNC_CAPABILITIES]};
  const epoch=randomUUID(),endpoint={id:randomUUID(),protocolVersion:2,capabilities:[...SYNC_CAPABILITIES]};
  const mode={epoch,allowBrowser:true,expiresAt:new Date(Date.now()+60000).toISOString()};
  const ordinary:RemoteSession={id:randomUUID(),ownerAccountId:auth.account.id,hostId:host.id,controllerDeviceId:randomUUID(),
    controllerId:'native',controllerKind:'native',scope:'control',purpose:'screen',epoch,authSessionId:auth.databaseId,
    createdAt:new Date().toISOString(),expiresAt:mode.expiresAt,endedAt:null,endReason:null,runtimeNamespace:'synthetic',
    signalingInstanceId:randomUUID(),protocolVersion:2,capabilities:['bounded-lifetime'],hostEndpointId:endpoint.id,
    lastActivityAt:null,idleDeadline:null};
  const cli={...ordinary,id:randomUUID(),purpose:'cli' as const,capabilities:[],cliProtocolVersion:1};
  const code={...ordinary,id:randomUUID(),purpose:'access-code' as const,capabilities:['access-code','bounded-lifetime']};
  const remotes=[ordinary,cli,code];
  const devices={listOwned:jest.fn().mockResolvedValue([host]),findOwned:jest.fn()};
  const sessions={listOwned:jest.fn().mockResolvedValue(remotes),create:jest.fn()};
  const proofs={verify:jest.fn()},security=new RequestSecurityService(config);
  const service=new DeviceService(devices as never,proofs as never,{get:async()=>mode} as never,sessions as never,
    {activeEndpoint:async()=>endpoint} as never,{} as never,{} as never,{} as never,config);
  const health=new HealthController(config,{} as never,{} as never);
  const deviceController=new DeviceController(service,proofs as never,security);
  const sessionController=new RemoteSessionController(sessions as never,proofs as never,security,service);
  const request=(extension?:string):AuthenticatedRequest=>({syncSession:auth,headers:extension===undefined?{}:{'x-sync-extensions':extension}} as AuthenticatedRequest);
  return {health,deviceController,sessionController,service,auth,host,remotes,devices,sessions,proofs,config,request};
}

describe('bounded access-code HTTP compatibility projection',()=>{
  it.each([undefined,'','ACCESS-CODE','access-code ',' access-code','access-code, access-code','access-code,other',
    'other', 'x'.repeat(129), ['access-code'],['access-code','access-code']])('does not opt in for %p',value=>{
    expect(supportsAccessCodeProjection({headers:{'x-sync-extensions':value}} as Pick<Request,'headers'>)).toBe(false);
  });
  it('recognizes only the exact header value, independent of caller platform or identity',()=>{
    expect(supportsAccessCodeProjection()).toBe(false);
    expect(supportsAccessCodeProjection({headers:{'x-sync-extensions':'access-code'}})).toBe(true);
  });
  it('defaults direct controller/service calls to the frozen legacy7 catalog and purpose2 projection',async()=>{
    const f=fixture();
    const config=f.health.publicConfig();
    expect(validateWire('WirePublicConfig',config)).toBe(true);
    expect(config.capabilities).toEqual(legacy.$defs.Capability.enum);
    expect(oldCapabilities(config.capabilities)).toBe(true);
    expect(config.protocolVersion).toBe(2);
    for(const listed of [await f.service.list(f.auth),await f.deviceController.list(f.request())]) {
      expect(listed.devices).toHaveLength(1);
      for(const device of listed.devices) {
        expect(validateWire('WireDevice',device)).toBe(true);
        expect(oldCapabilities(device.capabilities)).toBe(true);
        expect(device.capabilities).toHaveLength(7);
      }
    }
    const listed=await f.sessionController.list(f.request());
    expect(listed.sessions.map(session=>session.purpose)).toEqual(['screen','cli']);
    for(const session of listed.sessions) {
      expect(validateWire('WireRemoteSession',session)).toBe(true);
      expect(legacy.$defs.SessionPurpose.enum.includes(session.purpose)).toBe(true);
      expect(oldCapabilities(session.capabilities)).toBe(true);
    }
    // Projection must not mutate stored/live snapshots or erase authority for opted-in callers.
    expect(f.host.capabilities).toHaveLength(8);expect(f.remotes).toHaveLength(3);
  });
  it('opts all three GET projections into8 capabilities/code rows without changing base protocol or flags',async()=>{
    const f=fixture(),request=f.request('access-code');
    const config=f.health.publicConfig(request),legacyConfig=f.health.publicConfig();
    expect(config.capabilities).toEqual([...SYNC_CAPABILITIES]);expect(oldCapabilities(config.capabilities)).toBe(false);
    expect(config.features).toEqual(legacyConfig.features);expect(config.protocolVersion).toBe(2);
    const devices=await f.deviceController.list(request);
    expect(devices.devices[0]!.capabilities).toEqual([...SYNC_CAPABILITIES]);
    expect(oldCapabilities(devices.devices[0]!.capabilities)).toBe(false);
    const sessions=await f.sessionController.list(request);
    expect(sessions.sessions.map(session=>session.purpose)).toEqual(['screen','cli','access-code']);
    expect(legacy.$defs.SessionPurpose.enum.includes(sessions.sessions[2]!.purpose)).toBe(false);
    expect(f.sessions.listOwned).toHaveBeenCalledWith(f.auth.account.id);
    expect(f.devices.listOwned).toHaveBeenCalledWith(f.auth.account.id);
  });
  it.each(['config','devices','sessions'] as const)('marks both legacy and opted %s responses no-store and varies without erasing Origin',async(route)=>{
    const f=fixture();
    for(const extension of [undefined,'access-code']) {
      const res=response();res.setHeader('Vary','Origin');const req=f.request(extension);
      if(route==='config') f.health.publicConfig(req,res);
      if(route==='devices') await f.deviceController.list(req,res);
      if(route==='sessions') await f.sessionController.list(req,res);
      expect(res.getHeader('Cache-Control')).toBe('no-store');
      expect(String(res.getHeader('Vary')).split(',').map(value=>value.trim().toLowerCase()).sort())
        .toEqual(['origin','x-sync-extensions']);
    }
  });
  it('does not grant code authority to a forged opted-in browser with valid origin and CSRF',async()=>{
    const f=fixture(),token='synthetic-csrf-token',req=f.request('access-code');
    req.syncSession={...f.auth,source:'web',platform:'web',csrfHash:sha256(token)};
    Object.assign(req.headers,{origin:'http://localhost:3053','x-csrf-token':token,cookie:`${f.config.config.csrfCookieName}=${token}`});
    expect(supportsAccessCodeProjection(req)).toBe(true);
    await expect(f.deviceController.connect(req,f.host.id,{purpose:'access-code',scope:'control',protocolVersion:2,capabilities:['access-code']}))
      .rejects.toMatchObject({status:403,response:{message:'Access code lookup requires trusted native control without PIN access'}});
    expect(f.proofs.verify).not.toHaveBeenCalled();expect(f.sessions.create).not.toHaveBeenCalled();
    expect(f.devices.findOwned).not.toHaveBeenCalled();
  });
});
