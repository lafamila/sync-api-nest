import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { readFileSync } from "node:fs";

const PORT = 4179;
const FORCE_TURN = process.env.SYNC_TEST_FORCE_TURN === "1";
const iceServers = turnIceServers();
let hostSocket = null;
let controllerSocket = null;
let connectCount = 0;
let activeSessionId = null;
let modeOff = false;
let nextConnectStatus = null;
const ticketSessions = new Map();
const consumedTickets = new Set();
const endedSessionIds = [];
const golden = JSON.parse(readFileSync(new URL('./fixtures/sync-golden.json',import.meta.url),'utf8'));
const modernConfig = golden.valid.find(fixture => fixture.name === 'public-config').value;
const sessions = new Map();
const connectBodies = [];
const recoveryBodies = [];
let activityCount = 0;
let jsonPingCount = 0;
let jsonPongCount = 0;
let protocolPongCount = 0;
let options = {};
const serverNow = () => Date.now() + (options.serverOffsetMs ?? 0);
const browserState = state => ({ serverNow:new Date(serverNow()).toISOString(),lastActivityAt:new Date(state.lastActivityAt).toISOString(),idleDeadline:new Date(state.deadline).toISOString() });

function connectResult(state) {
  return { session:state.session,ticket:state.ticket,iceServers,...(!options.legacy ? { webAccess:{ activityToken:state.token,...browserState(state) } } : {}) };
}

function createSession(scope, previous) {
  connectCount++;
  const id = sessionIdFor(connectCount);
  const state = {
    session:{ id,hostId:'mac-online',controllerId:'browser',scope,epoch:'6d4f8db7-45e0-4c94-b99a-0c813809cd41',expiresAt:previous?.session.expiresAt ?? new Date(serverNow()+(options.sessionSeconds ?? 43200)*1000).toISOString(),
      ...(!options.legacy ? { protocolVersion:options.hostProtocol ?? 2,capabilities:options.hostProtocol === 1 ? [] : ['host-displays','viewer-displays'] } : {}) },
    ticket:`controller-test-${connectCount}`,token:`public-test-activity-${randomUUID()}`,
    lastActivityAt:previous?.lastActivityAt ?? serverNow(),deadline:previous?.deadline ?? serverNow()+(options.idleSeconds ?? 900)*1000,
    active:true,recovered:false,
  };
  sessions.set(id,state);
  activeSessionId=id;
  ticketSessions.set(state.ticket,id);
  return state;
}

function sessionIdFor(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function turnIceServers() {
  if (!FORCE_TURN) return [];
  process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), "../../.env"));
  const secret = process.env.SYNC_TURN_SECRET;
  if (!secret) throw new Error("The TURN integration fixture requires SYNC_TURN_SECRET");
  const username = `${Math.floor(Date.now() / 1000) + 600}:sync-playwright-${randomUUID()}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return [{
    urls: [process.env.SYNC_TEST_TURN_URL ?? "turn:127.0.0.1:3478?transport=udp"],
    username,
    credential,
  }];
}

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function authorized(request) {
  return request.headers.cookie?.includes("sync_test_auth=1") ?? false;
}

function csrfValid(request) {
  return request.headers.cookie?.includes("sync_csrf=csrf-test")
    && request.headers["x-csrf-token"] === "csrf-test";
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

const hostPage = `<!doctype html>
<html><body><canvas id="source" width="640" height="360"></canvas><script>
  window.__messages = [];
  window.__channels = [];
  window.__hostReady = false;
  window.__signals = [];
  window.__acceptedMessages = [];
  window.__rejectedMessages = [];
  window.__displayBehavior = {};
  window.__frames = 0;
  const states = new Map();
  const socket = new WebSocket('ws://' + location.host + '/api/signaling?ticket=host-test');
  const canvas = document.querySelector('#source');
  const context = canvas.getContext('2d');
  let frame = 0;
  setInterval(() => {
    frame += 1;
    window.__frames = frame;
    context.fillStyle = frame % 2 ? '#145c4b' : '#173b47';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffffff';
    context.font = '36px sans-serif';
    context.fillText('Sync test peer ' + frame, 24, canvas.height / 2);
  }, 80);
  const stream = canvas.captureStream(12);
  const candidates = new Map();
  let peer = null;
  let peerGeneration = 0;
  let currentSessionId = null;
  window.__peerGeneration = 0;

  function createPeer(sessionId) {
    peer?.close();
    peerGeneration += 1;
    window.__peerGeneration = peerGeneration;
    const generation = peerGeneration;
    currentSessionId = sessionId;
    const next = new RTCPeerConnection({
      iceServers: ${JSON.stringify(iceServers)},
      iceTransportPolicy: ${FORCE_TURN ? "'relay'" : "'all'"},
    });
    peer = next;
    window.__peer = next;
    next.addTrack(stream.getVideoTracks()[0], stream);
    next.ondatachannel = (event) => {
      const channel = event.channel;
      window.__channels.push({ label: channel.label, ordered: channel.ordered, maxRetransmits: channel.maxRetransmits, generation });
      channel.onmessage = (message) => {
        const parsed = JSON.parse(message.data);
        window.__messages.push({ ...parsed, __generation: generation, __sessionId: sessionId });
        const state = states.get(sessionId);
        const validEpoch = state && parsed.epoch === state.epoch && (state.protocolVersion < 2 || parsed.inputEpoch === state.inputEpoch);
        if (validEpoch && parsed.type === 'heartbeat') state.armed = true;
        (validEpoch && (parsed.type === 'heartbeat' || parsed.type === 'release-all' || state.armed) ? window.__acceptedMessages : window.__rejectedMessages).push({ ...parsed, __generation:generation });
        if (channel.readyState === 'open') channel.send(message.data);
      };
    };
    next.onicecandidate = (event) => {
      if (event.candidate && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ice', sessionId, candidate: event.candidate.toJSON() }));
      }
    };
    return next;
  }
  socket.onopen = () => { window.__hostReady = true; };
  window.__sendSignal = message => socket.send(JSON.stringify(message));
  const displays = [{id:'main',name:'Main',width:640,height:360,isPrimary:true},{id:'portrait',name:'Portrait',width:360,height:640,isPrimary:false}];
  function publishDisplays(sessionId, requestId) {
    const state = states.get(sessionId);
    socket.send(JSON.stringify({type:'displays',sessionId,displays,selectedDisplayId:state.selectedDisplayId,inputEpoch:state.inputEpoch,...(requestId ? {requestId} : {})}));
  }
  socket.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    window.__signals.push(message);
    if (message.type === 'session-start') {
      states.set(message.session.id,{epoch:message.session.epoch,inputEpoch:message.session.epoch,protocolVersion:message.session.protocolVersion ?? 1,selectedDisplayId:'main',armed:false});
      return;
    }
    if (message.type === 'get-displays') {
      if (!window.__displayBehavior.ignoreQueries) publishDisplays(message.sessionId);
      return;
    }
    if (message.type === 'select-display') {
      if (window.__displayBehavior.ignoreSelection) return;
      const state = states.get(message.sessionId);
      state.armed = false;
      if (window.__displayBehavior.error) {
        socket.send(JSON.stringify({type:'display-error',sessionId:message.sessionId,requestId:message.requestId,reason:window.__displayBehavior.error}));
        return;
      }
      await new Promise(resolve => setTimeout(resolve,window.__displayBehavior.delayMs ?? 50));
      state.inputEpoch = crypto.randomUUID();
      state.selectedDisplayId = message.displayId;
      canvas.width = message.displayId === 'portrait' ? 360 : 640;
      canvas.height = message.displayId === 'portrait' ? 640 : 360;
      publishDisplays(message.sessionId,message.requestId);
      return;
    }
    if (message.type === 'offer') {
      const next = createPeer(message.sessionId);
      await next.setRemoteDescription({ type: 'offer', sdp: message.sdp });
      for (const candidate of candidates.get(message.sessionId) ?? []) await next.addIceCandidate(candidate);
      candidates.delete(message.sessionId);
      const answer = await next.createAnswer();
      await next.setLocalDescription(answer);
      socket.send(JSON.stringify({ type: 'answer', sessionId: message.sessionId, sdp: answer.sdp }));
    } else if (message.type === 'ice' && message.candidate) {
      if (peer && currentSessionId === message.sessionId && peer.remoteDescription) await peer.addIceCandidate(message.candidate);
      else candidates.set(message.sessionId, [...(candidates.get(message.sessionId) ?? []), message.candidate]);
    }
  };
</script></body></html>`;

const vite = await createViteServer({
  server: { middlewareMode: true, hmr: false },
  appType: "spa",
});

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

  if (url.pathname === "/api/health") return json(response, 200, { status: "ok" });
  if (url.pathname === "/api/config") return json(response,200,{ product:'Sync',version:'0.1.0',authConfigured:true,webUrl:`http://127.0.0.1:${PORT}`,...(!options.legacy ? {...modernConfig,webIdleTimeoutSeconds:options.idleSeconds ?? 900} : {}) });
  if (url.pathname === '/__test/options' && request.method === 'POST') { options={...options,...await readJson(request)}; return json(response,200,{ok:true}); }
  if (url.pathname === "/__test/host") {
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end(hostPage);
    return;
  }
  if ((url.pathname === "/__test/end" || url.pathname === "/__test/mode-off") && request.method === "POST") {
    modeOff = true;
    controllerSocket?.send(JSON.stringify({
      type: "session-ended",
      sessionId: activeSessionId,
      reason: "Mode disabled",
    }));
    controllerSocket?.close(4003, "mode disabled");
    return json(response, 200, { ok: true });
  }
  if (url.pathname === "/__test/drop-controller" && request.method === "POST") {
    controllerSocket?.close(1011, "network interrupted");
    return json(response, 200, { ok: true });
  }
  if (url.pathname === "/__test/reject-next-connect" && request.method === "POST") {
    nextConnectStatus = 403;
    return json(response, 200, { ok: true });
  }
  if (url.pathname === "/__test/reset" && request.method === "POST") {
    controllerSocket?.close(1000, "test reset");
    controllerSocket = null;
    connectCount = 0;
    activeSessionId = null;
    modeOff = false;
    nextConnectStatus = null;
    ticketSessions.clear();
    consumedTickets.clear();
    endedSessionIds.length = 0;
    sessions.clear(); connectBodies.length=0; recoveryBodies.length=0; activityCount=0; options={};
    jsonPingCount=0; jsonPongCount=0; protocolPongCount=0;
    return json(response, 200, { ok: true });
  }
  if (url.pathname === "/__test/state") {
    return json(response, 200, { connectCount, activeSessionId, endedSessionIds,connectBodies,recoveryBodies,activityCount,jsonPingCount,jsonPongCount,protocolPongCount,
      signalingSessionIds:[...consumedTickets].map(ticket=>ticketSessions.get(ticket)),
      accesses:[...sessions.values()].map(state=>({id:state.session.id,active:state.active,...browserState(state)})) });
  }
  if (url.pathname === "/api/session/me") {
    if (!authorized(request)) return json(response, 401, { message: "Sign in required" });
    return json(response, 200, {
      account: { id: "account-test", name: "Test Operator", permission: "member" },
    });
  }
  if (url.pathname === "/api/session/oidc/start" && request.method === "POST") {
    return json(response, 200, { authorizeUrl: "/__test/login", transactionId: "tx-test" });
  }
  if (url.pathname === "/api/session/logout" && request.method === "POST") {
    if (!csrfValid(request)) return json(response, 403, { message: "Valid CSRF token is required" });
    return json(response, 204, undefined);
  }
  if (url.pathname === "/api/devices") {
    if (!authorized(request)) return json(response, 401, { message: "Sign in required" });
    return json(response, 200, {
      devices: [
        {
          id: "windows-online",name:"Desk Windows",platform:"windows",online:true,
          mode: { epoch: "6d4f8db7-45e0-4c94-b99a-0c813809cd41", expiresAt: "2030-01-01T12:00:00.000Z", allowBrowser: true },
        },
        {
          id: "mac-online",
          name: "Studio Mac",
          platform: "macos",
          online: true,
          mode: { epoch: "6d4f8db7-45e0-4c94-b99a-0c813809cd41", expiresAt: "2030-01-01T12:00:00.000Z", allowBrowser: true },
        },
        {
          id: "mac-offline",
          name: "Offline Mac",
          platform: "macos",
          online: false,
          mode: null,
        },
        {
          id: "phone-online",
          name: "Test iPhone",
          platform: "ios",
          online: true,
          mode: null,
        },
      ],
    });
  }
  if (url.pathname === "/api/devices/mac-online/connect" && request.method === "POST") {
    if (!authorized(request)) return json(response, 401, { message: "Sign in required" });
    if (!csrfValid(request)) return json(response, 403, { message: "Valid CSRF token is required" });
    const body = await readJson(request);
    connectBodies.push(body);
    if (!options.legacy && body.protocolVersion !== 2) return json(response,426,{error:'reload-required',message:'Reload Sync to update the browser protocol'});
    if (options.legacy && ('protocolVersion' in body || 'capabilities' in body)) return json(response,400,{message:'Legacy request must omit metadata'});
    if (nextConnectStatus !== null) {
      connectCount++;
      const status = nextConnectStatus;
      nextConnectStatus = null;
      return json(response, status, { message: "Invalid access code" });
    }
    if (modeOff) return json(response, 403, { message: "Remote mode is not active" });
    if (body.code !== "123456") return json(response, 403, { message: "Invalid access code" });
    return json(response,200,connectResult(createSession(body.scope)));
  }
  const authorityRoute = /^\/api\/sessions\/([^/]+)\/(activity|recover)$/.exec(url.pathname);
  if (authorityRoute && request.method === 'POST') {
    if (!authorized(request) || !csrfValid(request)) return json(response,403,{message:'Forbidden'});
    const state = sessions.get(authorityRoute[1]);
    const body = await readJson(request);
    if (authorityRoute[2] === 'recover') recoveryBodies.push(body);
    if (!state || !state.active || state.token !== body.activityToken || state.deadline <= serverNow() || state.recovered) return json(response,403,{message:'Remote access expired. Enter a new access code.'});
    if (authorityRoute[2] === 'activity') {
      activityCount++;
      state.lastActivityAt=serverNow(); state.deadline=serverNow()+(options.idleSeconds ?? 900)*1000;
      return json(response,200,browserState(state));
    }
    if (body.protocolVersion !== 2) return json(response,426,{error:'reload-required',message:'Reload Sync'});
    if (modeOff || nextConnectStatus) {
      connectCount++; nextConnectStatus=null; state.active=false;
      return json(response,403,{message:modeOff ? 'Remote mode is not active' : 'Invalid access code'});
    }
    state.recovered=true; state.active=false; endedSessionIds.push(state.session.id);
    return json(response,200,connectResult(createSession(state.session.scope,state)));
  }
  if (url.pathname.startsWith("/api/sessions/") && request.method === "DELETE") {
    if (!csrfValid(request)) return json(response, 403, { message: "Valid CSRF token is required" });
    endedSessionIds.push(decodeURIComponent(url.pathname.slice("/api/sessions/".length)));
    const state=sessions.get(decodeURIComponent(url.pathname.slice('/api/sessions/'.length))); if(state) state.active=false;
    return json(response, 204, undefined);
  }

  vite.middlewares(request, response, () => {
    response.writeHead(404);
    response.end("Not found");
  });
});

const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname !== "/api/signaling") {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (webSocket) => {
    const ticket = url.searchParams.get("ticket");
    if (ticket === "host-test") hostSocket = webSocket;
    else if (ticket && ticketSessions.has(ticket) && !consumedTickets.has(ticket)) {
      consumedTickets.add(ticket);
      controllerSocket?.close(4001, "connection replaced");
      controllerSocket = webSocket;
    }
    else {
      webSocket.close(1008, "Invalid ticket");
      return;
    }

    webSocket.on("message", (data) => {
      let message;
      try { message=JSON.parse(data.toString()); } catch { webSocket.close(1008,'Invalid JSON'); return; }
      if(message.type === 'ping') {
        if(webSocket === controllerSocket) jsonPingCount++;
        if(!options.dropJsonPongs || webSocket !== controllerSocket) {
          webSocket.send(JSON.stringify({type:'pong'}));
          if(webSocket === controllerSocket) jsonPongCount++;
        }
        return;
      }
      const target = webSocket === hostSocket ? controllerSocket : hostSocket;
      if (target?.readyState === 1) target.send(data.toString());
    });
    webSocket.on('pong',()=>{if(webSocket === controllerSocket) protocolPongCount++;});
    webSocket.on("close", () => {
      if (webSocket === hostSocket) hostSocket = null;
      if (webSocket === controllerSocket) controllerSocket = null;
    });
    if (ticket && ticketSessions.has(ticket)) {
      const state=sessions.get(ticketSessions.get(ticket));
      if(hostSocket?.readyState === 1) hostSocket.send(JSON.stringify({type:'session-start',session:state.session,iceServers}));
      webSocket.send(JSON.stringify({ type: "ready", session: { id: ticketSessions.get(ticket) } }));
    }
  });
});

server.listen(PORT, "127.0.0.1");
const idleTimer=setInterval(()=>{
  const state=sessions.get(activeSessionId);
  if(options.legacy || !state?.active || state.deadline > serverNow()) return;
  state.active=false;
  if(!options.loseTerminal) controllerSocket?.send(JSON.stringify({type:'session-ended',sessionId:state.session.id,reason:'idle_timeout'}));
},100);
idleTimer.unref();
const transportPingTimer=setInterval(()=>{if(controllerSocket?.readyState === 1) controllerSocket.ping();},1000);
transportPingTimer.unref();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    sockets.close();
    await vite.close();
    server.close(() => process.exit(0));
  });
}
