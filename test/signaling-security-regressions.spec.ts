import { spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { RevocationBusService } from '../src/common/revocation-bus.service';
import { DatabaseService } from '../src/database/database.service';
import { RemoteSession, RemoteSessionRepository } from '../src/sessions/remote-session.repository';
import { RemoteSessionService } from '../src/sessions/remote-session.service';
import { SignalingService } from '../src/signaling/signaling.service';
import { SyncConfigService } from '../src/config/config.service';
import { testConfig } from './helpers';

describe('pre-auth signaling transport safety',()=>{
  it.each(['pending-ticket','rejected-ticket'])('survives a malformed frame with %s without an uncaught-error handler',phase=>{
    const result=spawnSync(process.execPath,['-r',require.resolve('ts-node/register'),'-e',`
      const {Duplex}=require('node:stream');
      const {WebSocket}=require('ws');
      const {SignalingService}=require('./src/signaling/signaling.service');
      const {RevocationBusService}=require('./src/common/revocation-bus.service');
      (async()=>{
        let rejectPeek;
        const pending=new Promise((_,reject)=>{rejectPeek=reject;});
        const service=new SignalingService({peek:()=>pending},{},{},{endForInstance:async()=>[]},{},{},{},{},
          {namespace:'test',instanceId:'test'},new RevocationBusService(),{config:{}});
        const stream=new Duplex({read(){},write(chunk,encoding,done){done();}});
        const socket=new WebSocket(null,undefined,{autoPong:true,closeTimeout:10});
        socket.setSocket(stream,Buffer.alloc(0),{maxPayload:128*1024});
        const phase=${JSON.stringify(phase)};
        const accepting=service.accept(socket,{url:phase==='pending-ticket'?'/api/signaling?ticket=invalid':'/api/signaling',headers:{}});
        // An unmasked client frame makes the real ws receiver emit an error.
        stream.push(Buffer.from([0x82,0x00]));
        await new Promise(resolve=>setImmediate(resolve));
        socket.terminate();
        if(phase==='pending-ticket') rejectPeek(new Error('invalid ticket'));
        await accepting;
        await service.onModuleDestroy();
        console.log('survived malformed pre-auth frame');
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `],{cwd:process.cwd(),env:{...process.env,TS_NODE_TRANSPILE_ONLY:'true'},encoding:'utf8',timeout:8_000});
    expect({status:result.status,signal:result.signal,error:result.error,stderr:result.stderr})
      .toEqual({status:0,signal:null,error:undefined,stderr:''});
    expect(result.stdout).toContain('survived malformed pre-auth frame');
  });
});

describe('host disconnect generation fencing',()=>{
  it('does not rebind a session when the registering host was superseded while waiting for the row lock',async()=>{
    let locked!:()=>void,release!:()=>void;
    const reached=new Promise<void>(resolve=>{locked=resolve;});
    const waiting=new Promise<void>(resolve=>{release=resolve;});
    const query=jest.fn(async()=>{locked();await waiting;return {rows:[],rowCount:0};});
    const db={transaction:async(work:(transactionQuery:typeof query)=>Promise<unknown>)=>work(query)} as unknown as DatabaseService;
    let current=true;
    const isCurrent=jest.fn(()=>current);
    const binding=new RemoteSessionRepository(db).bindHostEndpoint({id:'session'} as RemoteSession,'old-endpoint',isCurrent);
    await reached;
    expect(isCurrent).not.toHaveBeenCalled();
    current=false;release();
    expect(await binding).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('for update'),['session']);
  });

  it('keeps the disconnected endpoint in the SQL predicate after delayed database dispatch and replacement',async()=>{
    let dispatch!:()=>void,release!:()=>void;
    const reached=new Promise<void>(resolve=>{dispatch=resolve;});
    const waiting=new Promise<void>(resolve=>{release=resolve;});
    const query=jest.fn().mockResolvedValue({rows:[],rowCount:0});
    const db={transaction:async(work:(transactionQuery:typeof query)=>Promise<unknown>)=>{
      dispatch();await waiting;return work(query);
    }} as unknown as DatabaseService;
    const bus=new RevocationBusService();
    const sessions=new RemoteSessionService(new RemoteSessionRepository(db),bus,{} as never);
    jest.spyOn(sessions,'findActiveForHost').mockResolvedValue([]);
    jest.spyOn(sessions,'endForInstance').mockResolvedValue([]);
    const signaling=new SignalingService({} as never,{} as never,
      {findOwned:async()=>({id:'host'}),touch:async()=>{}} as never,sessions,{} as never,{} as never,
      {key:(...parts:string[])=>parts.join(':'),client:{eval:async()=>1,set:async()=>'OK'}} as never,
      {revalidateById:async()=>{}} as never,{} as never,bus,new SyncConfigService(testConfig()));
    const peer=(id:string)=>({id,ticket:{role:'device' as const,deviceId:'host',ownerAccountId:'owner',platform:'macos' as const,
      authSessionId:'auth'},socket:{readyState:WebSocket.OPEN,send:jest.fn(),close:jest.fn()} as unknown as WebSocket,
      lastPongAt:Date.now(),lastPingAt:0});
    const internal=signaling as unknown as {
      devices:Map<string,ReturnType<typeof peer>>;
      closed(connection:ReturnType<typeof peer>):Promise<void>;
      registerDevice(connection:ReturnType<typeof peer>):Promise<void>;
    };
    const old=peer('old-endpoint'),replacement=peer('new-endpoint');
    internal.devices.set('host',old);
    const closing=internal.closed(old);
    try {
      await reached;
      await internal.registerDevice(replacement);
      release();await closing;
      expect(internal.devices.get('host')).toBe(replacement);
      expect(query).toHaveBeenCalledWith(expect.stringContaining('host_endpoint_id=$2'),['host',old.id,'device_disconnected']);
    } finally { release();await closing;await signaling.onModuleDestroy(); }
  });
});
