import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { RevocationBusService } from '../src/common/revocation-bus.service';
import { RemoteSession } from '../src/sessions/remote-session.repository';
import { SignalingService } from '../src/signaling/signaling.service';
import { TicketPayload } from '../src/signaling/ticket.service';
import { SyncConfigService } from '../src/config/config.service';
import { testConfig } from './helpers';

function fixture(requireBoundedHosts=false) {
  const bus=new RevocationBusService();
  const remote:RemoteSession={id:randomUUID(),ownerAccountId:'owner',hostId:randomUUID(),controllerDeviceId:randomUUID(),
    controllerId:randomUUID(),controllerKind:'native',scope:'view',epoch:randomUUID(),authSessionId:randomUUID(),
    createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),endedAt:null,endReason:null,
    runtimeNamespace:'test',signalingInstanceId:randomUUID(),protocolVersion:2,capabilities:['host-displays','viewer-displays'],
    hostEndpointId:null,lastActivityAt:null,idleDeadline:null};
  const sessions={findActive:jest.fn().mockImplementation(async(id:string)=>id===remote.id?remote:undefined),
    findActiveForHost:jest.fn().mockResolvedValue([remote]),endForInstance:jest.fn().mockResolvedValue([]),
    installController:jest.fn(async(snapshot:RemoteSession,install:(session:RemoteSession)=>boolean)=>{
      if(!install(snapshot)) throw new Error('controller installation denied');
      return snapshot;
    }),
    bindHostEndpoint:jest.fn(async(snapshot:RemoteSession,endpointId:string,isCurrent:()=>boolean)=>
      isCurrent()?{...snapshot,hostEndpointId:endpointId}:undefined),
    endIfActive:jest.fn().mockResolvedValue(undefined),endForHostEndpoint:jest.fn().mockResolvedValue([]),endForDevice:jest.fn().mockResolvedValue([])};
  const redis={key:(...parts:string[])=>parts.join(':'),client:{set:jest.fn().mockResolvedValue('OK'),eval:jest.fn().mockResolvedValue(1)}};
  const service=new SignalingService({} as never,{} as never,
    {findOwned:jest.fn().mockResolvedValue({id:remote.hostId}),touch:jest.fn()} as never,
    sessions as never,{get:jest.fn().mockResolvedValue({epoch:remote.epoch})} as never,{forAccount:()=>[]} as never,
    redis as never,{revalidateById:jest.fn()} as never,{namespace:'test',instanceId:randomUUID()} as never,bus,
    new SyncConfigService(testConfig({requireBoundedHosts})));
  const internal=service as unknown as {
    devices:Map<string,Connection>;controllers:Map<string,Connection>;sessionHosts:Map<string,string>;
    message(connection:Connection,data:Buffer,isBinary:boolean):Promise<void>;
    closed(connection:Connection):Promise<void>;registerDevice(connection:Connection):Promise<void>;registerController(connection:Connection):Promise<void>;
  };
  const host=connection({role:'device',ownerAccountId:'owner',deviceId:remote.hostId,platform:'windows',authSessionId:'host-auth',
    protocolVersion:2,capabilities:['host-displays',...(requireBoundedHosts?['bounded-lifetime']:[])]});
  const controller=connection({role:'controller',ownerAccountId:'owner',sessionId:remote.id,browser:false,authSessionId:remote.authSessionId});
  internal.devices.set(remote.hostId,host);internal.controllers.set(remote.id,controller);
  const send=(from:Connection,payload:object)=>internal.message(from,Buffer.from(JSON.stringify(payload)),false);
  return {service,internal,remote,sessions,host,controller,send,bus,redis};
}

type Connection={id:string;ticket:TicketPayload;socket:WebSocket & {send:jest.Mock;close:jest.Mock};lastPongAt:number;lastPingAt:number};
function connection(ticket:TicketPayload):Connection {
  return {id:randomUUID(),ticket,socket:{readyState:WebSocket.OPEN,send:jest.fn(),close:jest.fn()} as unknown as Connection['socket'],lastPongAt:Date.now(),lastPingAt:0};
}

describe('v2 signaling isolation',()=>{
  function cliFixture() {
    const f=fixture();
    Object.assign(f.remote,{scope:'control',purpose:'cli',cliProtocolVersion:1,hostEndpointId:f.host.id,authorizationGrantId:randomUUID()});
    Object.assign(f.host.ticket,{platform:'macos',cliProtocolVersion:1});
    return f;
  }
  it('publishes identical CLI session snapshots in controller ready and host session-start',async()=>{
    const f=cliFixture();
    try {
      await f.internal.registerController(f.controller);
      const ready=JSON.parse(f.controller.socket.send.mock.calls[0][0]);
      const start=JSON.parse(f.host.socket.send.mock.calls[0][0]);
      expect(ready.session).toEqual(start.session);
      expect(start.session).toMatchObject({purpose:'cli',cliProtocolVersion:1,scope:'control'});
    } finally { await f.service.onModuleDestroy(); }
  });
  it('stores only the current device ticket CLI declaration in presence',async()=>{
    const f=cliFixture();
    try {
      f.sessions.findActiveForHost.mockResolvedValue([]);
      await f.internal.registerDevice(f.host);
      const first=JSON.parse(f.redis.client.set.mock.calls[0]![1]);
      expect(first).toMatchObject({id:f.host.id,cliProtocolVersion:1});
      const replacement=connection({...f.host.ticket,cliProtocolVersion:undefined} as TicketPayload);
      await f.internal.registerDevice(replacement);
      const last=JSON.parse(f.redis.client.set.mock.calls.at(-1)![1]);
      expect(last.id).toBe(replacement.id);
      expect(last).not.toHaveProperty('cliProtocolVersion');
    } finally { await f.service.onModuleDestroy(); }
  });
  it('ends CLI authority rather than rebinding it even when the replacement declares the same support',async()=>{
    const f=cliFixture();
    try {
      const replacement=connection(f.host.ticket);
      await f.internal.registerDevice(replacement);
      expect(f.sessions.endIfActive).toHaveBeenCalledWith('owner',f.remote.id,'host_protocol_changed');
      expect(f.sessions.bindHostEndpoint).not.toHaveBeenCalled();
      expect(replacement.socket.send.mock.calls.map(([json])=>JSON.parse(json).type)).toEqual(['ready']);
    } finally { await f.service.onModuleDestroy(); }
  });
  it('rejects an old controller ticket against a compatible but different host generation',async()=>{
    const f=cliFixture();
    try {
      f.internal.devices.set(f.remote.hostId,connection(f.host.ticket));
      await expect(f.internal.registerController(f.controller)).rejects.toThrow('host endpoint incompatible');
      expect(f.sessions.installController).not.toHaveBeenCalled();
      expect(f.host.socket.send).not.toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it('checks mode again after controller installation commits',async()=>{
    const f=cliFixture();
    try {
      f.sessions.installController.mockImplementation(async(snapshot,install)=>{
        expect(install(snapshot)).toBe(true);
        f.remote.epoch=randomUUID();
        return snapshot;
      });
      await expect(f.internal.registerController(f.controller)).rejects.toThrow('closed during registration');
      expect(f.host.socket.send).not.toHaveBeenCalled();
      expect(f.controller.socket.send).not.toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it('re-reads the current host after awaiting the final mode check',async()=>{
    const f=cliFixture();
    const internal=f.service as unknown as {modeMatches(session:RemoteSession):Promise<boolean>};
    const mode=jest.spyOn(internal,'modeMatches').mockResolvedValueOnce(true).mockImplementationOnce(async()=>{
      f.internal.devices.set(f.remote.hostId,connection(f.host.ticket));
      return true;
    });
    try {
      await expect(f.internal.registerController(f.controller)).rejects.toThrow('closed during registration');
      expect(f.host.socket.send).not.toHaveBeenCalled();
      expect(f.controller.socket.send).not.toHaveBeenCalled();
    } finally { mode.mockRestore();await f.service.onModuleDestroy(); }
  });
  it('does not publish CLI session-start if absolute expiry elapses during the final mode lookup',async()=>{
    const f=cliFixture();
    const internal=f.service as unknown as {modeMatches(session:RemoteSession):Promise<boolean>};
    const mode=jest.spyOn(internal,'modeMatches').mockResolvedValueOnce(true).mockImplementationOnce(async()=>{
      f.remote.expiresAt=new Date(Date.now()-1).toISOString();
      return true;
    });
    try {
      await expect(f.internal.registerController(f.controller)).rejects.toThrow('closed during registration');
      expect(f.host.socket.send).not.toHaveBeenCalled();
      expect(f.controller.socket.send).not.toHaveBeenCalled();
    } finally { mode.mockRestore();await f.service.onModuleDestroy(); }
  });
  it('rejects displays on CLI-only sessions and never relays CLI bodies through signaling',async()=>{
    const f=cliFixture();
    try {
      await f.send(f.controller,{type:'get-displays',sessionId:f.remote.id});
      await f.send(f.controller,{type:'cli',sessionId:f.remote.id,text:'must-not-relay'});
      expect(f.host.socket.send).not.toHaveBeenCalled();
      expect(f.controller.socket.close).toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it('permits a media-v1 controller on an updated host when bounded hosts are required',async()=>{
    const f=fixture(true);
    try {
      f.remote.protocolVersion=1;f.remote.capabilities=[];
      f.internal.controllers.delete(f.remote.id);
      const candidate=connection(f.controller.ticket);
      await f.internal.registerController(candidate);
      expect(f.internal.controllers.get(f.remote.id)).toBe(candidate);
      expect(JSON.parse(candidate.socket.send.mock.calls[0][0])).toMatchObject({type:'ready',session:{protocolVersion:1,capabilities:[]}});
    } finally { await f.service.onModuleDestroy(); }
  });
  it('ends even media-v1 sessions before replacing a bounded host with legacy software under the policy',async()=>{
    const f=fixture(true);
    try {
      f.remote.protocolVersion=1;f.remote.capabilities=[];
      const replacement=connection({...f.host.ticket,protocolVersion:1,capabilities:[]} as TicketPayload);
      f.sessions.endIfActive.mockImplementation(async()=>{
        expect(f.internal.devices.get(f.remote.hostId)).toBe(f.host);
        return undefined;
      });
      f.sessions.findActiveForHost.mockResolvedValueOnce([f.remote]).mockResolvedValueOnce([]);
      await f.internal.registerDevice(replacement);
      expect(f.sessions.endIfActive).toHaveBeenCalledWith('owner',f.remote.id,'host_protocol_changed');
      expect(replacement.socket.send.mock.calls.map(([json])=>JSON.parse(json).type)).toEqual(['ready']);
    } finally { await f.service.onModuleDestroy(); }
  });
  it('will not attach an already-issued media-v1 session to an unbounded replacement host',async()=>{
    const f=fixture(true);
    try {
      f.remote.protocolVersion=1;f.remote.capabilities=[];
      if(f.host.ticket.role==='device') f.host.ticket.capabilities=[];
      f.internal.controllers.delete(f.remote.id);
      const candidate=connection(f.controller.ticket);
      await expect(f.internal.registerController(candidate)).rejects.toThrow('host endpoint incompatible');
      expect(f.sessions.installController).not.toHaveBeenCalled();
      expect(f.host.socket.send).not.toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it('claims the reservation during verified install before publishing ready or session-start',async()=>{
    const f=fixture();
    try {
      f.internal.controllers.delete(f.remote.id);
      const candidate=connection(f.controller.ticket);
      f.sessions.installController.mockImplementation(async(snapshot,install)=>{
        expect(candidate.socket.send).not.toHaveBeenCalled();
        expect(f.host.socket.send).not.toHaveBeenCalled();
        expect(f.internal.controllers.has(snapshot.id)).toBe(false);
        expect(install(snapshot)).toBe(true);
        expect(f.internal.controllers.get(snapshot.id)).toBe(candidate);
        return snapshot;
      });
      await f.internal.registerController(candidate);
      expect(candidate.socket.send).toHaveBeenCalledWith(expect.stringContaining('ready'));
      expect(f.host.socket.send).toHaveBeenCalledWith(expect.stringContaining('session-start'));
    } finally { await f.service.onModuleDestroy(); }
  });
  it('does not install a reservation rejected by the current database deadline despite a live discovery snapshot',async()=>{
    const f=fixture();
    try {
      f.internal.controllers.delete(f.remote.id);
      const candidate=connection(f.controller.ticket);
      f.sessions.installController.mockRejectedValue(new Error('connection deadline expired'));
      await expect(f.internal.registerController(candidate)).rejects.toThrow('deadline expired');
      expect(f.internal.controllers.has(f.remote.id)).toBe(false);
      expect(candidate.socket.send).not.toHaveBeenCalled();
      expect(f.host.socket.send).not.toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it.each(['closed','revoked','host-replaced'] as const)('rejects %s while the database claim is in flight',async(kind)=>{
    const f=fixture();
    try {
      f.internal.controllers.delete(f.remote.id);
      const candidate=connection(f.controller.ticket);
      f.sessions.installController.mockImplementation(async(snapshot,install)=>{
        if(kind==='closed') Object.assign(candidate.socket,{readyState:WebSocket.CLOSED});
        if(kind==='revoked') f.bus.emit({kind:'device',id:snapshot.controllerDeviceId!,reason:'device_revoked'});
        if(kind==='host-replaced') f.internal.devices.set(snapshot.hostId,connection(f.host.ticket));
        if(!install(snapshot)) throw new Error('installation denied');
        return snapshot;
      });
      await expect(f.internal.registerController(candidate)).rejects.toThrow('installation denied');
      expect(f.internal.controllers.has(f.remote.id)).toBe(false);
      expect(candidate.socket.send).not.toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it('never sends session-start to a downgraded host that replaced the endpoint during claim commit',async()=>{
    const f=fixture();
    try {
      f.internal.controllers.delete(f.remote.id);
      const candidate=connection(f.controller.ticket);
      const replacement=connection({...f.host.ticket,protocolVersion:1,capabilities:[]} as TicketPayload);
      f.sessions.installController.mockImplementation(async(snapshot,install)=>{
        expect(install(snapshot)).toBe(true);
        f.internal.devices.set(snapshot.hostId,replacement);
        return snapshot;
      });
      await expect(f.internal.registerController(candidate)).rejects.toThrow('closed during registration');
      expect(candidate.socket.send).not.toHaveBeenCalled();
      expect(replacement.socket.send).not.toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it('routes display selection in view scope without granting input',async()=>{
    const f=fixture();
    try {
      const payload={type:'select-display',sessionId:f.remote.id,displayId:'monitor-1',inputEpoch:f.remote.epoch,requestId:randomUUID()};
      await f.send(f.controller,payload);
      expect(f.host.socket.send).toHaveBeenCalledWith(JSON.stringify(payload));
      expect(f.remote.scope).toBe('view');
      await f.send(f.host,{type:'displays',sessionId:f.remote.id,displays:[{id:'monitor-1',name:'Main',width:1920,height:1080,isPrimary:true}],selectedDisplayId:'monitor-1',inputEpoch:randomUUID(),requestId:payload.requestId});
      expect(f.controller.socket.send).toHaveBeenCalledTimes(1);
    } finally { await f.service.onModuleDestroy(); }
  });
  it.each(['v1-session','missing-viewer','v1-recipient','missing-host'] as const)('never sends new signals with %s',async(kind)=>{
    const f=fixture();
    try {
      if(kind==='v1-session') f.remote.protocolVersion=1;
      if(kind==='missing-viewer') f.remote.capabilities=['host-displays'];
      if(f.host.ticket.role==='device' && kind==='v1-recipient') f.host.ticket.protocolVersion=1;
      if(f.host.ticket.role==='device' && kind==='missing-host') f.host.ticket.capabilities=[];
      await f.send(f.controller,{type:'get-displays',sessionId:f.remote.id});
      expect(f.host.socket.send).not.toHaveBeenCalled();
      expect(f.controller.socket.close).toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it('rejects wrong direction, cross-session and stale replaced sockets',async()=>{
    const f=fixture();
    try {
      await f.send(f.host,{type:'get-displays',sessionId:f.remote.id});
      expect(f.controller.socket.send).not.toHaveBeenCalled();
      await f.send(f.controller,{type:'get-displays',sessionId:randomUUID()});
      f.internal.controllers.set(f.remote.id,connection(f.controller.ticket));
      await f.send(f.controller,{type:'get-displays',sessionId:f.remote.id});
      expect(f.host.socket.send).not.toHaveBeenCalled();
      await f.internal.closed(f.controller);
      expect(f.sessions.endIfActive).not.toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it('ends incompatible sessions before installing a downgraded host socket',async()=>{
    const f=fixture();
    try {
      const replacement=connection({...f.host.ticket,protocolVersion:1,capabilities:[]} as TicketPayload);
      f.sessions.endIfActive.mockImplementation(async()=>{
        expect(f.internal.devices.get(f.remote.hostId)).toBe(f.host);
        return undefined;
      });
      f.sessions.findActiveForHost.mockResolvedValueOnce([f.remote]).mockResolvedValueOnce([]);
      await f.internal.registerDevice(replacement);
      expect(f.sessions.endIfActive).toHaveBeenCalledWith('owner',f.remote.id,'host_protocol_changed');
      expect(f.internal.devices.get(f.remote.hostId)).toBe(replacement);
      await f.internal.closed(f.host);
      expect(f.sessions.endForHostEndpoint).not.toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it('ordinary host loss leaves three outgoing controller sockets alone; revocation stays participant-wide',async()=>{
    const f=fixture();
    try {
      const outgoing=Array.from({length:3},()=>connection({...f.controller.ticket,sessionId:randomUUID()} as TicketPayload));
      for(const peer of outgoing) if(peer.ticket.role==='controller') f.internal.controllers.set(peer.ticket.sessionId,peer);
      await f.internal.closed(f.host);
      expect(f.sessions.endForHostEndpoint).toHaveBeenCalledWith(f.remote.hostId,f.host.id,'device_disconnected');
      expect(f.sessions.endForDevice).not.toHaveBeenCalled();
      for(const peer of outgoing) expect(peer.socket.close).not.toHaveBeenCalled();
      f.bus.emit({kind:'device',id:f.remote.hostId,reason:'device_revoked'});
      expect(f.sessions.endForDevice).toHaveBeenCalledWith(f.remote.hostId,'device_revoked');
    } finally { await f.service.onModuleDestroy(); }
  });
  it('does not install a controller from a stale DB snapshot after session revocation',async()=>{
    const f=fixture();
    try {
      f.internal.controllers.delete(f.remote.id);
      f.sessions.findActive.mockImplementation(async()=>{
        f.bus.emit({kind:'session',id:f.remote.id,reason:'revoked'});
        return f.remote;
      });
      const candidate=connection(f.controller.ticket);
      await expect(f.internal.registerController(candidate)).rejects.toThrow('closed during registration');
      expect(f.internal.controllers.has(f.remote.id)).toBe(false);
      expect(candidate.socket.send).not.toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
  it('never sends session-start from a stale host discovery snapshot after revocation',async()=>{
    const f=fixture();
    try {
      const candidate=connection(f.host.ticket);
      f.sessions.findActiveForHost.mockResolvedValueOnce([]).mockImplementationOnce(async()=>{
        f.bus.emit({kind:'session',id:f.remote.id,reason:'revoked'});
        return [f.remote];
      });
      await f.internal.registerDevice(candidate);
      expect(candidate.socket.send.mock.calls.map(([json])=>JSON.parse(json).type)).toEqual(['ready']);
    } finally { await f.service.onModuleDestroy(); }
  });
  it('rejects a host ticket whose device was revoked during the authorization snapshot',async()=>{
    const f=fixture();
    try {
      f.sessions.findActiveForHost.mockImplementation(async()=>{
        f.bus.emit({kind:'device',id:f.remote.hostId,reason:'device_revoked'});
        return [];
      });
      const candidate=connection(f.host.ticket);
      await expect(f.internal.registerDevice(candidate)).rejects.toThrow('superseded');
      expect(f.internal.devices.get(f.remote.hostId)).toBe(f.host);
      expect(candidate.socket.send).not.toHaveBeenCalled();
    } finally { await f.service.onModuleDestroy(); }
  });
});
