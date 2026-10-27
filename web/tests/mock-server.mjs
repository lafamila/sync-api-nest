import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";

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
    urls: ["turn:127.0.0.1:3478?transport=udp"],
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
  const socket = new WebSocket('ws://' + location.host + '/api/signaling?ticket=host-test');
  const canvas = document.querySelector('#source');
  const context = canvas.getContext('2d');
  let frame = 0;
  setInterval(() => {
    frame += 1;
    context.fillStyle = frame % 2 ? '#145c4b' : '#173b47';
    context.fillRect(0, 0, 640, 360);
    context.fillStyle = '#ffffff';
    context.font = '36px sans-serif';
    context.fillText('Sync test peer ' + frame, 120, 190);
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
  socket.onmessage = async (event) => {
    const message = JSON.parse(event.data);
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
    return json(response, 200, { ok: true });
  }
  if (url.pathname === "/__test/state") {
    return json(response, 200, { connectCount, activeSessionId, endedSessionIds });
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
    connectCount += 1;
    if (nextConnectStatus !== null) {
      const status = nextConnectStatus;
      nextConnectStatus = null;
      return json(response, status, { message: "Invalid access code" });
    }
    if (modeOff) return json(response, 403, { message: "Remote mode is not active" });
    if (body.code !== "123456") return json(response, 403, { message: "Invalid access code" });
    const sessionId = sessionIdFor(connectCount);
    const ticket = `controller-test-${connectCount}`;
    activeSessionId = sessionId;
    ticketSessions.set(ticket, sessionId);
    return json(response, 200, {
      session: {
        id: sessionId,
        hostId: "mac-online",
        controllerId: "browser",
        scope: body.scope,
        epoch: "6d4f8db7-45e0-4c94-b99a-0c813809cd41",
        expiresAt: "2030-01-01T12:00:00.000Z",
      },
      ticket,
      iceServers,
    });
  }
  if (url.pathname.startsWith("/api/sessions/") && request.method === "DELETE") {
    if (!csrfValid(request)) return json(response, 403, { message: "Valid CSRF token is required" });
    endedSessionIds.push(decodeURIComponent(url.pathname.slice("/api/sessions/".length)));
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
      const target = webSocket === hostSocket ? controllerSocket : hostSocket;
      if (target?.readyState === 1) target.send(data.toString());
    });
    webSocket.on("close", () => {
      if (webSocket === hostSocket) hostSocket = null;
      if (webSocket === controllerSocket) controllerSocket = null;
    });
    if (ticket && ticketSessions.has(ticket)) {
      webSocket.send(JSON.stringify({ type: "ready", session: { id: ticketSessions.get(ticket) } }));
    }
  });
});

server.listen(PORT, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    sockets.close();
    await vite.close();
    server.close(() => process.exit(0));
  });
}
