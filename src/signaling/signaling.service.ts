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

interface Connection { id:string; socket:WebSocket; ticket:TicketPayload; lastPongAt:number; lastPingAt:number }

@Injectable()
export class SignalingService implements OnModuleDestroy {
  private server?: WebSocketServer;
  private readonly devices = new Map<string,Connection>();
  private readonly controllers = new Map<string,Connection>();
  private readonly sessionHosts = new Map<string,string>();
  private readonly unsubscribe: () => void;
  private readonly interval: NodeJS.Timeout;
  private maintaining=false;

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
    clearInterval(this.interval);
    await this.sessions.endForInstance(this.identity.namespace,this.identity.instanceId,'server_shutdown').catch(()=>this.failClosed('server_shutdown'));
    this.unsubscribe();
    const connections=[...this.devices.values(),...this.controllers.values()];
    for(const entry of connections) entry.socket.close(1012,'server shutdown');
    if(!this.server) return;
    const closed=new Promise<void>((resolve)=>this.server!.close(()=>resolve()));
    const deadline=setTimeout(()=>{
      for(const entry of connections) if(entry.socket.readyState!==WebSocket.CLOSED) entry.socket.terminate();
    },2_000);
    deadline.unref();
    await closed;
    clearTimeout(deadline);
  }

  private async accept(socket:WebSocket,request:IncomingMessage):Promise<void> {
    try {
      const url=new URL(request.url ?? '', 'http://localhost');
      const token=url.searchParams.get('ticket');
      if(!token) return this.reject(socket,'ticket required');
      const preview=await this.tickets.peek(token);
      if(preview.role==='controller' && preview.browser && !this.security.isAllowedOrigin(request.headers.origin)) return this.reject(socket,'origin denied');
      const ticket=await this.tickets.consume(token);
      const now=Date.now();
      const connection:Connection={ id:randomUUID(),socket,ticket,lastPongAt:now,lastPingAt:0 };
      if(ticket.role==='device') await this.registerDevice(connection);
      else await this.registerController(connection);
      socket.on('message',(data,isBinary)=>void this.message(connection,data,isBinary));
      socket.on('pong',()=>{ connection.lastPongAt=Date.now(); });
      socket.on('close',()=>void this.closed(connection).catch(()=>this.localDrop(connection)));
      socket.on('error',()=>undefined);
    } catch { this.reject(socket,'ticket invalid'); }
  }

  private async registerDevice(connection:Connection):Promise<void> {
    const ticket=connection.ticket;
    if(ticket.role!=='device') return;
    await this.authSessions.revalidateById(ticket.authSessionId);
    const device=await this.deviceRepository.findOwned(ticket.ownerAccountId,ticket.deviceId);
    if(!device) throw new Error('device revoked');
    const previous=this.devices.get(device.id);
    this.devices.set(device.id,connection);
    await this.redis.client.set(this.presenceKey(device.id),connection.id,'EX',30);
    await this.deviceRepository.touch(device.id);
    this.send(connection.socket,{type:'ready',deviceId:device.id});
    if(previous && previous.id!==connection.id) previous.socket.close(4001,'connection replaced');
    for(const session of await this.sessions.findActiveForHost(device.id)) {
      this.sessionHosts.set(session.id,session.hostId);
      this.sendSessionStart(connection.socket,session);
    }
  }

  private async registerController(connection:Connection):Promise<void> {
    const ticket=connection.ticket;
    if(ticket.role!=='controller') return;
    await this.authSessions.revalidateById(ticket.authSessionId);
    const session=await this.sessions.findActive(ticket.sessionId);
    if(!session || session.ownerAccountId!==ticket.ownerAccountId || session.authSessionId!==ticket.authSessionId) throw new Error('session invalid');
    if(!await this.modeMatches(session)) { await this.sessions.endIfActive(session.ownerAccountId,session.id,'mode_invalid'); throw new Error('mode invalid'); }
    const previous=this.controllers.get(session.id);
    this.controllers.set(session.id,connection);
    this.sessionHosts.set(session.id,session.hostId);
    this.send(connection.socket,{type:'ready',session:presentSession(session)});
    if(previous && previous.id!==connection.id) previous.socket.close(4001,'connection replaced');
    const host=this.devices.get(session.hostId);
    if(host) this.sendSessionStart(host.socket,session);
  }

  private async message(connection:Connection,data:RawData,isBinary:boolean):Promise<void> {
    if(isBinary) return this.reject(connection.socket,'binary messages are not supported');
    let value:unknown;
    try { value=JSON.parse(data.toString()); } catch { return this.reject(connection.socket,'invalid json'); }
    if(!value || typeof value!=='object' || Array.isArray(value)) return this.reject(connection.socket,'invalid message');
    const message=value as Record<string,unknown>;
    if(message.type==='ping') { this.send(connection.socket,{type:'pong'}); return; }
    if(!['offer','answer','ice'].includes(String(message.type)) || typeof message.sessionId!=='string') return this.reject(connection.socket,'invalid message type');
    const session=await this.sessions.findActive(message.sessionId);
    if(!session || !await this.modeMatches(session)) {
      if(session) await this.sessions.endIfActive(session.ownerAccountId,session.id,'mode_invalid');
      return this.reject(connection.socket,'session invalid');
    }
    if(connection.ticket.role==='controller') {
      if(connection.ticket.sessionId!==session.id || message.type==='answer') return this.reject(connection.socket,'route denied');
      const signal=canonicalSignal(message); if(!signal) return this.reject(connection.socket,'invalid signaling payload');
      const host=this.devices.get(session.hostId); if(!host) return this.reject(connection.socket,'host offline');
      this.send(host.socket,signal); return;
    }
    if(connection.ticket.deviceId!==session.hostId || message.type==='offer') return this.reject(connection.socket,'route denied');
    const signal=canonicalSignal(message); if(!signal) return this.reject(connection.socket,'invalid signaling payload');
    const controller=this.controllers.get(session.id); if(controller) this.send(controller.socket,signal);
  }

  private async closed(connection:Connection):Promise<void> {
    if(connection.ticket.role==='device') {
      const current=this.devices.get(connection.ticket.deviceId);
      if(current?.id!==connection.id) return;
      this.devices.delete(connection.ticket.deviceId);
      await this.redis.client.eval(
        `if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`,
        1,this.presenceKey(connection.ticket.deviceId),connection.id,
      );
      await this.sessions.endForDevice(connection.ticket.deviceId,'device_disconnected');
      return;
    }
    const current=this.controllers.get(connection.ticket.sessionId);
    if(current?.id!==connection.id) return;
    this.controllers.delete(connection.ticket.sessionId);
    const session=await this.sessions.findActive(connection.ticket.sessionId);
    if(session) await this.sessions.endIfActive(session.ownerAccountId,session.id,'controller_disconnected');
  }

  private handleRevocation(event:RevocationEvent):void {
    if(event.kind==='session') {
      const controller=this.controllers.get(event.id);
      if(controller) { this.send(controller.socket,{type:'session-ended',sessionId:event.id,reason:event.reason}); controller.socket.close(4003,event.reason); }
      const hostId=this.sessionHosts.get(event.id);
      if(hostId) this.send(this.devices.get(hostId)?.socket as WebSocket,{type:'session-ended',sessionId:event.id,reason:event.reason});
      this.sessionHosts.delete(event.id);
    } else if(event.kind==='device') {
      this.devices.get(event.id)?.socket.close(4003,event.reason);
    } else if(event.kind==='auth-session') {
      for(const connection of this.controllers.values()) if(connection.ticket.role==='controller' && connection.ticket.authSessionId===event.id) connection.socket.close(4003,event.reason);
      for(const connection of this.devices.values()) if(connection.ticket.role==='device' && connection.ticket.authSessionId===event.id) connection.socket.close(4003,event.reason);
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
        await this.sessions.endForDevice(deviceId,'device_authorization_revoked');
        connection.socket.close(4003,'authorization revoked');
        continue;
      }
      this.ping(connection,now);
      await this.redis.client.set(this.presenceKey(deviceId),connection.id,'EX',30);
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
