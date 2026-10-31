import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Server as HttpServer, IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer, RawData } from 'ws';
import { RequestSecurityService } from '../common/request-security.service';
import { RevocationBusService, RevocationEvent } from '../common/revocation-bus.service';
import { DeviceRepository } from '../devices/device.repository';
import { presentSession } from '../devices/device.service';
import { ModeService } from '../devices/mode.service';
import { IceService } from '../ice/ice.service';
import { RedisService } from '../redis/redis.service';
import { RemoteSession } from '../sessions/remote-session.repository';
import { RemoteSessionService } from '../sessions/remote-session.service';
import { TicketPayload, TicketService } from './ticket.service';
import { SessionService } from '../auth/session.service';
import { RuntimeIdentityService } from '../runtime/runtime-identity.service';
import { endpointFeatures, supportsSession } from '../common/protocol';
import { canonicalDisplaySignal, isDisplaySignal } from './display-signal';
import { SyncConfigService } from '../config/config.service';

interface Connection { id:string; socket:WebSocket; ticket:TicketPayload; lastPongAt:number; lastPingAt:number }

@Injectable()
export class SignalingService implements OnModuleDestroy {
  private server?: WebSocketServer;
  private readonly devices = new Map<string,Connection>();
  private readonly controllers = new Map<string,Connection>();
  private readonly sessionHosts = new Map<string,string>();
  private readonly hostRegistrations = new Map<string,string>();
  // Terminal events invalidate in-flight reads without retaining an unbounded tombstone cache.
  private readonly pendingSnapshots = new Set<Set<string>>();
  private readonly unsubscribe: () => void;
  private readonly interval: NodeJS.Timeout;
  private maintaining=false;
  private stopping=false;

  constructor(
    private readonly tickets:TicketService,
    private readonly security:RequestSecurityService,
    private readonly deviceRepository:DeviceRepository,
    private readonly sessions:RemoteSessionService,
    private readonly modes:ModeService,
    private readonly ice:IceService,
    private readonly redis:RedisService,
    private readonly authSessions:SessionService,
    private readonly identity:RuntimeIdentityService,
    revocations:RevocationBusService,
    private readonly config:SyncConfigService,
  ) {
    this.unsubscribe=revocations.subscribe((event)=>this.handleRevocation(event));
    this.interval=setInterval(()=>void this.runMaintain(),1_000);
    this.interval.unref();
  }

  attach(server:HttpServer):void {
    if(this.server) return;
    this.server=new WebSocketServer({ server,path:'/api/signaling',maxPayload:128*1024,perMessageDeflate:false });
    this.server.on('connection',(socket,request)=>void this.accept(socket,request));
  }

  async onModuleDestroy():Promise<void> {
    this.stopping=true;
    clearInterval(this.interval);
    await this.sessions.endForInstance(this.identity.namespace,this.identity.instanceId,'server_shutdown').catch(()=>this.failClosed('server_shutdown'));
    this.unsubscribe();
    const sockets=this.server ? [...this.server.clients] : [...this.devices.values(),...this.controllers.values()].map((entry)=>entry.socket);
    for(const socket of sockets) socket.close(1012,'server shutdown');
    if(!this.server) return;
    const closed=new Promise<void>((resolve)=>this.server!.close(()=>resolve()));
    const deadline=setTimeout(()=>{
      for(const socket of this.server?.clients ?? []) if(socket.readyState!==WebSocket.CLOSED) socket.terminate();
    },2_000);
    deadline.unref();
    await closed;
    clearTimeout(deadline);
  }

  private async accept(socket:WebSocket,request:IncomingMessage):Promise<void> {
    socket.on('error',()=>undefined);
    if(this.stopping) return this.reject(socket,'server shutdown');
    let connection:Connection|undefined;
    try {
      const url=new URL(request.url ?? '', 'http://localhost');
      const token=url.searchParams.get('ticket');
      if(!token) return this.reject(socket,'ticket required');
      const preview=await this.tickets.peek(token);
      if(preview.role==='controller' && preview.browser && !this.security.isAllowedOrigin(request.headers.origin)) return this.reject(socket,'origin denied');
      const ticket=await this.tickets.consume(token);
      const now=Date.now();
      connection={ id:randomUUID(),socket,ticket,lastPongAt:now,lastPingAt:0 };
      if(ticket.role==='device') await this.registerDevice(connection);
      else await this.registerController(connection);
      if(socket.readyState!==WebSocket.OPEN) throw new Error('connection closed during registration');
      const accepted=connection;
      socket.on('message',(data,isBinary)=>void this.message(accepted,data,isBinary).catch(()=>this.reject(socket,'authorization uncertain')));
      socket.on('pong',()=>{ accepted.lastPongAt=Date.now(); });
      socket.on('close',()=>void this.closed(accepted).catch(()=>this.localDrop(accepted)));
    } catch {
      if(connection) await this.closed(connection).catch(()=>this.localDrop(connection!));
      this.reject(socket,'ticket invalid');
    }
  }

  private async registerDevice(connection:Connection):Promise<void> {
    const ticket=connection.ticket;
    if(ticket.role!=='device') return;
    const ended=new Set<string>();
    this.pendingSnapshots.add(ended);
    try {
      await this.authSessions.revalidateById(ticket.authSessionId);
      const device=await this.deviceRepository.findOwned(ticket.ownerAccountId,ticket.deviceId);
      if(!device) throw new Error('device revoked');
      if(this.stopping || connection.socket.readyState!==WebSocket.OPEN) throw new Error('server shutdown');
      this.hostRegistrations.set(device.id,connection.id);
      const active=await this.sessions.findActiveForHost(device.id);
      for(const session of active) {
        if(this.hostRegistrations.get(device.id)!==connection.id) throw new Error('host registration superseded');
        if(!this.supportsHost(connection,session)) {
          await this.sessions.endIfActive(session.ownerAccountId,session.id,'host_protocol_changed');
        }
      }
      if(this.hostRegistrations.get(device.id)!==connection.id || connection.socket.readyState!==WebSocket.OPEN ||
        ended.has(`device:${device.id}`) || ended.has(`auth-session:${ticket.authSessionId}`)) throw new Error('host registration superseded');
      const previous=this.devices.get(device.id);
      this.devices.set(device.id,connection);
      await this.redis.client.set(this.presenceKey(device.id),this.presenceValue(connection),'EX',30);
      await this.deviceRepository.touch(device.id);
      this.send(connection.socket,{type:'ready',deviceId:device.id});
      if(previous && previous.id!==connection.id) previous.socket.close(4001,'connection replaced');
      for(const session of await this.sessions.findActiveForHost(device.id)) {
        if(!this.isCurrent(connection)) return;
        if(ended.has(session.id)) continue;
        if(!this.supportsHost(connection,session)) {
          await this.sessions.endIfActive(session.ownerAccountId,session.id,'host_protocol_changed');
          continue;
        }
        const resumed=await this.sessions.bindHostEndpoint(session,connection.id,()=>
          this.isCurrent(connection) && !this.stopping && connection.socket.readyState===WebSocket.OPEN &&
          !this.snapshotRevoked(ended,connection,session));
        if(!this.isCurrent(connection)) return;
        if(!resumed || this.snapshotRevoked(ended,connection,resumed)) continue;
        this.sessionHosts.set(resumed.id,resumed.hostId);
        this.sendSessionStart(connection.socket,resumed);
      }
    } finally {
      this.pendingSnapshots.delete(ended);
      if(this.hostRegistrations.get(ticket.deviceId)===connection.id) this.hostRegistrations.delete(ticket.deviceId);
    }
  }

  private async registerController(connection:Connection):Promise<void> {
    const ticket=connection.ticket;
    if(ticket.role!=='controller') return;
    const ended=new Set<string>();
    this.pendingSnapshots.add(ended);
    try {
      await this.authSessions.revalidateById(ticket.authSessionId);
      const session=await this.sessions.findActive(ticket.sessionId);
      if(!session || session.ownerAccountId!==ticket.ownerAccountId || session.authSessionId!==ticket.authSessionId) throw new Error('session invalid');
      if(!await this.modeMatches(session)) { await this.sessions.endIfActive(session.ownerAccountId,session.id,'mode_invalid'); throw new Error('mode invalid'); }
      const activeHost=this.devices.get(session.hostId);
      if(!activeHost || !this.supportsHost(activeHost,session)) {
        await this.sessions.endIfActive(session.ownerAccountId,session.id,'host_protocol_changed');
        throw new Error('host endpoint incompatible');
      }
      if(this.stopping || connection.socket.readyState!==WebSocket.OPEN || this.snapshotRevoked(ended,connection,session)) throw new Error('session closed during registration');
      let previous:Connection|undefined;
      const installed=await this.sessions.installController(session,(current)=>{
        const host=this.devices.get(current.hostId);
        if(this.stopping || connection.socket.readyState!==WebSocket.OPEN || this.snapshotRevoked(ended,connection,current) ||
          host!==activeHost || host.socket.readyState!==WebSocket.OPEN || host.ticket.role!=='device' ||
          !this.supportsHost(host,current)) return false;
        previous=this.controllers.get(current.id);
        this.controllers.set(current.id,connection);
        this.sessionHosts.set(current.id,current.hostId);
        return true;
      });
      const modeValid=await this.modeMatches(installed);
      const host=this.devices.get(installed.hostId);
      if(!this.isCurrent(connection) || connection.socket.readyState!==WebSocket.OPEN || this.stopping ||
        !modeValid || Date.parse(installed.expiresAt)<=Date.now() ||
        this.snapshotRevoked(ended,connection,installed) || host!==activeHost || host.socket.readyState!==WebSocket.OPEN ||
        host.ticket.role!=='device' || !this.supportsHost(host,installed)) throw new Error('session closed during registration');
      this.send(connection.socket,{type:'ready',session:presentSession(installed)});
      if(previous && previous.id!==connection.id) previous.socket.close(4001,'connection replaced');
      this.sendSessionStart(host.socket,installed);
    } finally { this.pendingSnapshots.delete(ended); }
  }

  private async message(connection:Connection,data:RawData,isBinary:boolean):Promise<void> {
    if(this.stopping) return this.reject(connection.socket,'server shutdown');
    if(!this.isCurrent(connection)) return this.reject(connection.socket,'connection replaced');
    if(isBinary) return this.reject(connection.socket,'binary messages are not supported');
    let value:unknown;
    try { value=JSON.parse(data.toString()); } catch { return this.reject(connection.socket,'invalid json'); }
    if(!value || typeof value!=='object' || Array.isArray(value)) return this.reject(connection.socket,'invalid message');
    const message=value as Record<string,unknown>;
    if(message.type==='ping') { this.send(connection.socket,{type:'pong'}); return; }
    const display=isDisplaySignal(message.type);
    if((!display && !['offer','answer','ice'].includes(String(message.type))) || typeof message.sessionId!=='string') return this.reject(connection.socket,'invalid message type');
    const ended=new Set<string>();
    this.pendingSnapshots.add(ended);
    try {
      if(display) await this.authSessions.revalidateById(connection.ticket.authSessionId);
      const session=await this.sessions.findActive(message.sessionId);
      if(!session || !await this.modeMatches(session)) {
        if(session) await this.sessions.endIfActive(session.ownerAccountId,session.id,'mode_invalid');
        return this.reject(connection.socket,'session invalid');
      }
      if(!this.isCurrent(connection) || connection.socket.readyState!==WebSocket.OPEN || this.snapshotRevoked(ended,connection,session) || session.ownerAccountId!==connection.ticket.ownerAccountId) return this.reject(connection.socket,'route denied');
      if(display && session.purpose==='cli') return this.reject(connection.socket,'CLI sessions do not support displays');
      if(display && (session.protocolVersion<2 || !session.capabilities.includes('host-displays') || !session.capabilities.includes('viewer-displays'))) {
        return this.reject(connection.socket,'display signaling not negotiated');
      }
      if(connection.ticket.role==='controller') {
        if(connection.ticket.sessionId!==session.id || connection.ticket.authSessionId!==session.authSessionId ||
          (display ? !['get-displays','select-display'].includes(String(message.type)) : message.type==='answer')) return this.reject(connection.socket,'route denied');
        const signal=display?canonicalDisplaySignal(message):canonicalSignal(message); if(!signal) return this.reject(connection.socket,'invalid signaling payload');
        const host=this.devices.get(session.hostId); if(!host) return this.reject(connection.socket,'host offline');
        if(!this.supportsHost(host,session)) {
          await this.sessions.endIfActive(session.ownerAccountId,session.id,'host_protocol_changed');
          return this.reject(connection.socket,'host endpoint incompatible');
        }
        this.send(host.socket,signal); return;
      }
      if(connection.ticket.deviceId!==session.hostId ||
        (display ? !['displays','display-error'].includes(String(message.type)) : message.type==='offer')) return this.reject(connection.socket,'route denied');
      if(!this.supportsHost(connection,session)) return this.reject(connection.socket,'host endpoint incompatible');
      const signal=display?canonicalDisplaySignal(message):canonicalSignal(message); if(!signal) return this.reject(connection.socket,'invalid signaling payload');
      const controller=this.controllers.get(session.id); if(controller) this.send(controller.socket,signal);
    } finally { this.pendingSnapshots.delete(ended); }
  }

  private async closed(connection:Connection):Promise<void> {
    if(connection.ticket.role==='device') {
      const current=this.devices.get(connection.ticket.deviceId);
      if(current?.id!==connection.id) return;
      this.devices.delete(connection.ticket.deviceId);
      await this.redis.client.eval(
        `if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`,
        1,this.presenceKey(connection.ticket.deviceId),this.presenceValue(connection),
      );
      if(this.devices.has(connection.ticket.deviceId)) return;
      await this.sessions.endForHostEndpoint(connection.ticket.deviceId,connection.id,'device_disconnected');
      return;
    }
    const current=this.controllers.get(connection.ticket.sessionId);
    if(current?.id!==connection.id) return;
    this.controllers.delete(connection.ticket.sessionId);
    const session=await this.sessions.findActive(connection.ticket.sessionId);
    if(this.controllers.has(connection.ticket.sessionId)) return;
    if(session) await this.sessions.endIfActive(session.ownerAccountId,session.id,'controller_disconnected');
  }

  private handleRevocation(event:RevocationEvent):void {
    for(const pending of this.pendingSnapshots) pending.add(event.kind==='session'?event.id:`${event.kind}:${event.id}`);
    if(event.kind==='session') {
      const controller=this.controllers.get(event.id);
      this.controllers.delete(event.id);
      if(controller) { this.send(controller.socket,{type:'session-ended',sessionId:event.id,reason:event.reason}); controller.socket.close(4003,event.reason); }
      const hostId=this.sessionHosts.get(event.id);
      if(hostId) this.send(this.devices.get(hostId)?.socket as WebSocket,{type:'session-ended',sessionId:event.id,reason:event.reason});
      this.sessionHosts.delete(event.id);
    } else if(event.kind==='device') {
      void this.sessions.endForDevice(event.id,event.reason).catch(()=>this.failClosed('authorization_uncertain'));
      this.devices.get(event.id)?.socket.close(4003,event.reason);
    } else if(event.kind==='auth-session') {
      for(const connection of this.controllers.values()) if(connection.ticket.role==='controller' && connection.ticket.authSessionId===event.id) connection.socket.close(4003,event.reason);
      for(const connection of this.devices.values()) if(connection.ticket.role==='device' && connection.ticket.authSessionId===event.id) {
        void this.sessions.endForDevice(connection.ticket.deviceId,event.reason).catch(()=>this.failClosed('authorization_uncertain'));
        connection.socket.close(4003,event.reason);
      }
    } else if(event.kind==='runtime') {
      this.failClosed(event.reason);
    }
  }

  private async maintain():Promise<void> {
    const now=Date.now();
    await this.sessions.endExpired();
    for(const [deviceId,connection] of this.devices) {
      if(!this.isLive(connection,now)) { connection.socket.terminate(); continue; }
      try { await this.authSessions.revalidateById(connection.ticket.authSessionId); }
      catch {
        if(!this.isCurrent(connection)) continue;
        await this.sessions.endForDevice(deviceId,'device_authorization_revoked');
        connection.socket.close(4003,'authorization revoked');
        continue;
      }
      this.ping(connection,now);
      if(this.isCurrent(connection)) await this.redis.client.set(this.presenceKey(deviceId),this.presenceValue(connection),'EX',30);
    }
    for(const [sessionId,connection] of this.controllers) {
      if(!this.isLive(connection,now)) { connection.socket.terminate(); continue; }
      this.ping(connection,now);
      const session=await this.sessions.findActive(sessionId);
      let authorized=Boolean(session);
      if(session) {
        try { await this.authSessions.revalidateById(session.authSessionId); }
        catch { authorized=false; }
      }
      const modeValid=session ? await this.modeMatches(session) : false;
      if(!session || !authorized || !modeValid) {
        const stillActive=session ? await this.sessions.findActive(session.id) : undefined;
        if(stillActive) await this.sessions.endIfActive(session!.ownerAccountId,session!.id,authorized?'mode_expired':'authorization_revoked');
        connection.socket.close(4003,'session expired');
      }
    }
  }

  private async runMaintain():Promise<void> {
    if(this.maintaining) return;
    this.maintaining=true;
    try { await this.maintain(); }
    catch { this.failClosed('authorization_uncertain'); }
    finally { this.maintaining=false; }
  }

  private isLive(connection:Connection,now:number):boolean {
    return connection.socket.readyState===WebSocket.OPEN && now-connection.lastPongAt<=15_000;
  }
  private isCurrent(connection:Connection):boolean {
    return connection.ticket.role==='device'
      ? this.devices.get(connection.ticket.deviceId)?.id===connection.id
      : this.controllers.get(connection.ticket.sessionId)?.id===connection.id;
  }
  private snapshotRevoked(snapshot:Set<string>,connection:Connection,session:RemoteSession):boolean {
    return snapshot.has(session.id) || snapshot.has(`auth-session:${connection.ticket.authSessionId}`) ||
      snapshot.has(`device:${session.hostId}`) || Boolean(session.controllerDeviceId && snapshot.has(`device:${session.controllerDeviceId}`));
  }
  private presenceValue(connection:Connection):string {
    return JSON.stringify({id:connection.id,...endpointFeatures(connection.ticket.role==='device'?connection.ticket:{})});
  }
  private ping(connection:Connection,now:number):void {
    if(now-connection.lastPingAt>=5_000) { connection.lastPingAt=now; connection.socket.ping(); }
  }
  private failClosed(reason:string):void {
    for(const [sessionId,connection] of [...this.controllers]) {
      this.send(connection.socket,{type:'session-ended',sessionId,reason});
      const hostId=this.sessionHosts.get(sessionId);
      if(hostId) this.send(this.devices.get(hostId)?.socket,{type:'session-ended',sessionId,reason});
      connection.socket.close(1011,reason);
    }
    for(const connection of [...this.devices.values()]) connection.socket.close(1011,reason);
  }
  private localDrop(connection:Connection):void {
    if(connection.ticket.role==='device') {
      if(this.devices.get(connection.ticket.deviceId)?.id===connection.id) this.devices.delete(connection.ticket.deviceId);
    } else if(this.controllers.get(connection.ticket.sessionId)?.id===connection.id) {
      this.controllers.delete(connection.ticket.sessionId);
    }
  }

  private async modeMatches(session:RemoteSession):Promise<boolean> {
    const mode=await this.modes.get(session.ownerAccountId,session.hostId);
    return Boolean(mode && mode.epoch===session.epoch);
  }
  private supportsHost(connection:Connection,session:RemoteSession):boolean {
    if(connection.ticket.role!=='device' || !supportsSession(endpointFeatures(connection.ticket),session,this.config.config.requireBoundedHosts)) return false;
    if(session.purpose==='cli' && session.cliProtocolVersion===undefined) return false;
    return session.cliProtocolVersion===undefined || (session.hostEndpointId===connection.id && connection.ticket.platform==='macos' &&
      connection.ticket.ownerAccountId===session.ownerAccountId && session.controllerKind==='native' && session.scope==='control' &&
      Boolean(session.controllerDeviceId && session.authorizationGrantId));
  }
  private sendSessionStart(socket:WebSocket,session:RemoteSession):void {
    this.send(socket,{type:'session-start',session:presentSession(session),iceServers:this.ice.forAccount({id:session.ownerAccountId,name:'',permission:'member'})});
  }
  private send(socket:WebSocket|undefined,value:unknown):void { if(socket?.readyState===WebSocket.OPEN) socket.send(JSON.stringify(value)); }
  private reject(socket:WebSocket,reason:string):void { if(socket.readyState===WebSocket.OPEN || socket.readyState===WebSocket.CONNECTING) socket.close(1008,reason.slice(0,120)); }
  private presenceKey(deviceId:string):string { return this.redis.key('presence',deviceId); }
}

function canonicalSignal(message:Record<string,unknown>):Record<string,unknown>|undefined {
  if((message.type==='offer' || message.type==='answer') && typeof message.sdp==='string' && message.sdp.length>0 && message.sdp.length<=120_000) {
    if(!onlyKeys(message,['type','sessionId','sdp'])) return undefined;
    return {type:message.type,sessionId:message.sessionId,sdp:message.sdp};
  }
  const candidate=message.candidate;
  if(message.type!=='ice' || !candidate || typeof candidate!=='object' || Array.isArray(candidate)) return undefined;
  const value=candidate as Record<string,unknown>;
  if(!onlyKeys(message,['type','sessionId','candidate']) || !onlyKeys(value,['candidate','sdpMid','sdpMLineIndex','usernameFragment'])) return undefined;
  if(!(typeof value.candidate==='string' && value.candidate.length<=8192 &&
    (value.sdpMid===null || value.sdpMid===undefined || typeof value.sdpMid==='string') &&
    (value.sdpMLineIndex===null || value.sdpMLineIndex===undefined || (Number.isInteger(value.sdpMLineIndex) && Number(value.sdpMLineIndex)>=0)))) return undefined;
  return {type:'ice',sessionId:message.sessionId,candidate:{candidate:value.candidate,sdpMid:value.sdpMid ?? null,sdpMLineIndex:value.sdpMLineIndex ?? null}};
}

function onlyKeys(value:Record<string,unknown>,allowed:string[]):boolean { return Object.keys(value).every((key)=>allowed.includes(key)); }
