import { WebSocket } from 'ws';
import { RevocationBusService } from '../src/common/revocation-bus.service';
import { SignalingService } from '../src/signaling/signaling.service';

interface FakeSocket {
  readyState:number;
  send:jest.Mock;
  close:jest.Mock;
  terminate:jest.Mock;
  ping:jest.Mock;
}

describe('SignalingService fail-closed maintenance',()=>{
  it('notifies both local peers and closes every socket when dependency checks are uncertain',async()=>{
    const sessions={endExpired:jest.fn().mockRejectedValue(new Error('database unavailable'))};
    const service=createService(sessions,{});
    const host=socket(); const controller=socket();
    const internal=service as unknown as InternalSignaling;
    internal.devices.set('host-1',connection(host,{role:'device',deviceId:'host-1',ownerAccountId:'owner',platform:'macos',authSessionId:'auth-1'}));
    internal.controllers.set('session-1',connection(controller,{role:'controller',sessionId:'session-1',ownerAccountId:'owner',browser:true,authSessionId:'auth-1'}));
    internal.sessionHosts.set('session-1','host-1');
    await internal.runMaintain();
    expect(host.send).toHaveBeenCalledWith(expect.stringContaining('authorization_uncertain'));
    expect(controller.send).toHaveBeenCalledWith(expect.stringContaining('session-ended'));
    expect(controller.close).toHaveBeenCalledWith(1011,'authorization_uncertain');
    expect(host.close).toHaveBeenCalledWith(1011,'authorization_uncertain');
    await service.onModuleDestroy();
  });

  it('does not renew presence for a socket that missed the pong deadline',async()=>{
    const redis={client:{set:jest.fn()}};
    const service=createService({endExpired:jest.fn().mockResolvedValue([])},redis);
    const host=socket();
    const entry=connection(host,{role:'device',deviceId:'host-1',ownerAccountId:'owner',platform:'macos',authSessionId:'auth-1'});
    entry.lastPongAt=Date.now()-16_000;
    (service as unknown as InternalSignaling).devices.set('host-1',entry);
    await (service as unknown as InternalSignaling).runMaintain();
    expect(host.terminate).toHaveBeenCalled();
    expect(redis.client.set).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('revalidates device-ticket auth and closes the host when it is no longer valid',async()=>{
    const sessions={endExpired:jest.fn().mockResolvedValue([]),endForDevice:jest.fn().mockResolvedValue([])};
    const authSessions={revalidateById:jest.fn().mockRejectedValue(new Error('auth uncertain'))};
    const service=createService(sessions,{client:{set:jest.fn()}},authSessions);
    const host=socket();
    (service as unknown as InternalSignaling).devices.set('host-1',connection(host,{role:'device',deviceId:'host-1',ownerAccountId:'owner',platform:'macos',authSessionId:'auth-1'}));
    await (service as unknown as InternalSignaling).runMaintain();
    expect(authSessions.revalidateById).toHaveBeenCalledWith('auth-1');
    expect(sessions.endForDevice).toHaveBeenCalledWith('host-1','device_authorization_revoked');
    expect(host.close).toHaveBeenCalledWith(4003,'authorization revoked');
    await service.onModuleDestroy();
  });
});

type Ticket=Parameters<typeof connection>[1];
interface InternalConnection {id:string;socket:WebSocket;ticket:Ticket;lastPongAt:number;lastPingAt:number}
interface InternalSignaling {
  devices:Map<string,InternalConnection>;
  controllers:Map<string,InternalConnection>;
  sessionHosts:Map<string,string>;
  runMaintain():Promise<void>;
}

function createService(sessions:object,redis:object,authSessions:object={revalidateById:jest.fn().mockResolvedValue(undefined)}):SignalingService {
  const sessionStub={endForInstance:jest.fn().mockResolvedValue([]),...sessions};
  return new SignalingService({} as never,{} as never,{} as never,sessionStub as never,{} as never,{} as never,redis as never,
    authSessions as never,{namespace:'sync:test',instanceId:'00000000-0000-4000-8000-000000000001'} as never,new RevocationBusService());
}
function socket():FakeSocket { return {readyState:WebSocket.OPEN,send:jest.fn(),close:jest.fn(),terminate:jest.fn(),ping:jest.fn()}; }
function connection(socketValue:FakeSocket,ticket:
  |{role:'device';ownerAccountId:string;deviceId:string;platform:'macos'|'ios';authSessionId:string}
  |{role:'controller';ownerAccountId:string;sessionId:string;browser:boolean;authSessionId:string},
):InternalConnection {
  return {id:Math.random().toString(),socket:socketValue as unknown as WebSocket,ticket,lastPongAt:Date.now(),lastPingAt:0};
}
