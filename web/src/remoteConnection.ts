import type {
  ConnectionMetrics,
  ConnectionPhase,
  ControlPayload,
  DataMessage,
  IceServer,
  RemoteSession,
  DisplayState,
} from "./types";
import { SYNC_LIMITS, validateWire } from "./generated/sync-wire";
import type { WireSignal } from "./generated/sync-wire";

interface RemoteConnectionEvents {
  onMetrics: (metrics: ConnectionMetrics) => void;
  onPhase: (phase: ConnectionPhase) => void;
  onRecoveryNeeded: (reason: string) => void;
  onStream: (stream: MediaStream) => void;
  onSessionEnded: (reason: string) => void;
  onDisplays: (state: DisplayState) => void;
  onActivity: () => void;
  hasAuthority: () => boolean;
}

interface SignalingMessage {
  type: string;
  sessionId?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  reason?: string;
  displays?: WireSignal["displays"];
  selectedDisplayId?: string;
  inputEpoch?: string;
  requestId?: string;
}

const EMPTY_METRICS: ConnectionMetrics = {
  bitrateKbps: null,
  framesPerSecond: null,
  resolution: null,
  roundTripMs: null,
  packetsLost: null,
  dataMessagesReceived: 0,
};

function signalingUrl(ticket: string): string {
  const url = new URL("/api/signaling", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class RemoteConnection {
  private readonly peer: RTCPeerConnection;
  private readonly control: RTCDataChannel;
  private readonly motion: RTCDataChannel;
  private socket: WebSocket | null = null;
  private seq = 0;
  private heartbeatTimer: number | null = null;
  private metricsTimer: number | null = null;
  private signalingPingTimer: number | null = null;
  private signalingDeadlineTimer: number | null = null;
  private lastPongAt = performance.now();
  private lastPongWallAt = Date.now();
  private previousBytes: { at: number; bytes: number } | null = null;
  private metrics: ConnectionMetrics = { ...EMPTY_METRICS };
  private disposed = false;
  private offerSent = false;
  private authorizationValid = false;
  private recoveryRequested = false;
  private lastHeartbeatSentAt: number | null = null;
  private lastHeartbeatWallAt: number | null = null;
  private heartbeatSuspendedAt: number | null = null;
  private heartbeatSuspendedWallAt: number | null = null;
  private readonly pendingIce: RTCIceCandidateInit[] = [];
  private inputEpoch: string;
  private inputArmed = false;
  private initialDisplaysReceived = false;
  private displayTimer: number | null = null;
  private displayState: DisplayState = { displays: [], selectedDisplayId: null, busy: false, error: null };
  private pendingDisplay: { requestId: string; displayId: string; previousEpoch: string; querying: boolean } | null = null;
  private readonly completedDisplayRequests = new Set<string>();

  constructor(
    readonly session: RemoteSession,
    iceServers: IceServer[],
    private readonly events: RemoteConnectionEvents,
  ) {
    this.inputEpoch = session.epoch;
    this.peer = new RTCPeerConnection({ iceServers });
    this.peer.addTransceiver("video", { direction: "recvonly" });
    this.control = this.peer.createDataChannel("sync-control", { ordered: true });
    this.motion = this.peer.createDataChannel("sync-motion", {
      ordered: false,
      maxRetransmits: 0,
    });
    this.bindPeer();
    this.bindChannels();
  }

  async start(ticket: string): Promise<void> {
    if (!this.enforceLifetime()) return;
    this.events.onPhase("signaling");
    try {
      this.socket = new WebSocket(signalingUrl(ticket));
    } catch {
      this.requestRecovery("Signaling connection failed");
      return;
    }
    this.socket.addEventListener("message", (event) => void this.handleSignal(event));
    this.socket.addEventListener("open", () => this.signal({ type: "ping" }));
    this.socket.addEventListener("error", () => this.requestRecovery("Signaling connection failed"));
    this.socket.addEventListener("close", () => {
      if (this.disposed) return;
      this.requestRecovery("The authorized signaling connection closed");
    });
    this.signalingPingTimer = window.setInterval(() => this.signal({ type: "ping" }), SYNC_LIMITS.signalingPingIntervalSeconds * 1000);
    this.scheduleSignalingDeadline();
  }

  requestRecovery(reason: string): void {
    if (this.disposed || this.recoveryRequested) return;
    this.recoveryRequested = true;
    this.authorizationValid = false;
    this.inputArmed = false;
    this.dispose();
    this.events.onRecoveryNeeded(reason);
  }

  checkAuthorization(): boolean { return this.enforceLifetime(); }

  inputHeartbeatExpired(now = performance.now(), wallNow = Date.now()): boolean {
    return this.session.scope === "control"
      && ((this.heartbeatSuspendedAt !== null && Math.max(now - this.heartbeatSuspendedAt, wallNow - this.heartbeatSuspendedWallAt!) > 1_500)
        || (this.lastHeartbeatSentAt !== null && Math.max(now - this.lastHeartbeatSentAt, wallNow - this.lastHeartbeatWallAt!) > 1_500));
  }

  suspendInputHeartbeat(): void {
    if (this.session.scope !== "control" || this.heartbeatSuspendedAt !== null) return;
    this.releaseAll();
    this.heartbeatSuspendedAt = performance.now();
    this.heartbeatSuspendedWallAt = Date.now();
  }

  resumeInputHeartbeat(): void {
    if (this.heartbeatSuspendedAt === null) return;
    this.heartbeatSuspendedAt = null;
    this.heartbeatSuspendedWallAt = null;
    this.sendReliable({ type: "heartbeat" });
  }

  canControl(): boolean {
    return (
      !this.disposed &&
      !this.recoveryRequested &&
      document.visibilityState === "visible" &&
      this.events.hasAuthority() &&
      !this.signalingExpired() &&
      this.heartbeatSuspendedAt === null &&
      this.authorizationValid &&
      this.inputArmed &&
      !this.displayState.busy &&
      this.session.scope === "control" &&
      this.peer.connectionState === "connected" &&
      this.control.readyState === "open" &&
      this.motion.readyState === "open"
    );
  }

  sendReliable(payload: ControlPayload): boolean {
    return this.send(this.control, payload);
  }

  sendMotion(payload: ControlPayload): boolean {
    return this.send(this.motion, payload);
  }

  releaseAll(): void {
    if (this.session.scope !== "control" || this.control.readyState !== "open") return;
    try { this.control.send(this.encode({ type: "release-all" })); } catch { /* Closing transport must not interrupt local cleanup. */ }
  }

  get supportsDisplays(): boolean {
    return (this.session.protocolVersion ?? 1) >= 2
      && this.session.capabilities?.includes("host-displays") === true
      && this.session.capabilities?.includes("viewer-displays") === true;
  }

  userActivity(): void {
    if (this.enforceLifetime() && this.authorizationValid && this.peer.connectionState === "connected") this.events.onActivity();
  }

  selectDisplay(displayId: string): boolean {
    if (!this.enforceLifetime() || !this.supportsDisplays || !this.authorizationValid || this.displayState.busy
      || !this.displayState.displays.some(display => display.id === displayId) || displayId === this.displayState.selectedDisplayId) return false;
    this.releaseAll();
    this.inputArmed = false;
    const pending = { requestId: crypto.randomUUID(), displayId, previousEpoch: this.inputEpoch, querying: false };
    this.pendingDisplay = pending;
    this.displayState = { ...this.displayState, busy: true, error: null };
    this.publishDisplays();
    if (!this.signal({ type: "select-display", sessionId: this.session.id, displayId, inputEpoch: this.inputEpoch, requestId: pending.requestId })) {
      this.endDisplayFailure("Display signaling closed");
      return false;
    }
    this.displayTimer = window.setTimeout(() => {
      if (this.disposed || this.pendingDisplay !== pending) return;
      pending.querying = true;
      this.signal({ type: "get-displays", sessionId: this.session.id });
      this.displayTimer = window.setTimeout(() => this.endDisplayFailure("Display selection timed out"), SYNC_LIMITS.displayRecoveryTimeoutSeconds * 1000);
    }, SYNC_LIMITS.displaySelectionTimeoutSeconds * 1000);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.releaseAll();
    this.disposed = true;
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    if (this.metricsTimer !== null) window.clearInterval(this.metricsTimer);
    if (this.signalingPingTimer !== null) window.clearInterval(this.signalingPingTimer);
    if (this.signalingDeadlineTimer !== null) window.clearTimeout(this.signalingDeadlineTimer);
    if (this.displayTimer !== null) window.clearTimeout(this.displayTimer);
    this.pendingDisplay = null;
    this.inputArmed = false;
    this.control.close();
    this.motion.close();
    this.peer.close();
    this.socket?.close();
    this.socket = null;
  }

  private bindPeer(): void {
    this.peer.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      this.signal({
        type: "ice",
        sessionId: this.session.id,
        candidate: event.candidate.toJSON(),
      });
    });
    this.peer.addEventListener("track", (event) => {
      if (!this.enforceLifetime()) return;
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      event.track.addEventListener("ended", () => this.requestRecovery("The remote video track ended"));
      this.events.onStream(stream);
    });
    this.peer.addEventListener("connectionstatechange", () => {
      if (!this.enforceLifetime()) return;
      const state = this.peer.connectionState;
      if (state === "connected") {
        this.events.onPhase("connected");
        this.startMetrics();
        this.armInput();
      } else if (state === "connecting" || state === "new") {
        this.events.onPhase("connecting");
      } else if (state === "disconnected") {
        this.requestRecovery("The peer connection was interrupted");
      } else if (state === "failed") {
        this.requestRecovery("The peer connection could not be established");
      } else if (state === "closed" && !this.disposed) {
        this.events.onPhase("ended");
      }
    });
  }

  private bindChannels(): void {
    this.control.addEventListener("open", () => {
      if (this.session.scope !== "control") return;
      this.heartbeatTimer = window.setInterval(() => {
        if (this.heartbeatSuspendedAt === null) this.sendReliable({ type: "heartbeat" });
      }, 500);
      this.sendReliable({ type: "heartbeat" });
      this.armInput();
    });
    this.motion.addEventListener("open", () => this.armInput());
    this.control.addEventListener("message", () => this.recordDataMessage());
    this.motion.addEventListener("message", () => this.recordDataMessage());
    this.control.addEventListener("close", () => this.requestRecovery("The control channel closed"));
    this.motion.addEventListener("close", () => this.requestRecovery("The motion channel closed"));
    this.control.addEventListener("error", () => this.requestRecovery("The control channel failed"));
    this.motion.addEventListener("error", () => this.requestRecovery("The motion channel failed"));
  }

  private async handleSignal(event: MessageEvent): Promise<void> {
    if (!this.enforceLifetime()) return;
    let message: SignalingMessage;
    try {
      if (typeof event.data !== "string" || new TextEncoder().encode(event.data).byteLength > SYNC_LIMITS.maxSignalBytes) throw new Error("Oversized signal");
      message = JSON.parse(event.data) as SignalingMessage;
      if (!message || typeof message !== "object" || !["ready", "answer", "ice", "session-ended", "pong", "displays", "display-error"].includes(message.type)) throw new Error("Unknown signal");
    } catch {
      this.requestRecovery("The signaling server sent an invalid message");
      return;
    }

    if (message.type === "pong") {
      if (!validateWire("WireSignal", message) || Object.keys(message).some(key => key !== "type")) {
        this.requestRecovery("The signaling server sent an invalid pong");
        return;
      }
      this.lastPongAt = performance.now();
      this.lastPongWallAt = Date.now();
      this.scheduleSignalingDeadline();
      return;
    }

    if (message.type === "ready" && !this.offerSent) {
      this.authorizationValid = true;
      this.offerSent = true;
      if (this.supportsDisplays) {
        this.displayState = { ...this.displayState, busy: true };
        this.publishDisplays();
        this.signal({ type: "get-displays", sessionId: this.session.id });
        this.displayTimer = window.setTimeout(() => this.endDisplayFailure("Display metadata timed out"), SYNC_LIMITS.displaySelectionTimeoutSeconds * 1000);
      }
      try {
        const offer = await this.peer.createOffer();
        await this.peer.setLocalDescription(offer);
        this.signal({ type: "offer", sessionId: this.session.id, sdp: offer.sdp });
        this.events.onPhase("connecting");
      } catch {
        this.requestRecovery("Could not create the WebRTC offer");
      }
      return;
    }

    if (message.sessionId && message.sessionId !== this.session.id) return;
    if (message.type === "displays" || message.type === "display-error") {
      this.handleDisplaySignal(message);
      return;
    }

    try {
      if (message.type === "answer" && message.sdp) {
        await this.peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
        for (const candidate of this.pendingIce.splice(0)) {
          await this.peer.addIceCandidate(candidate);
        }
      } else if (message.type === "ice" && message.candidate) {
        if (this.peer.remoteDescription) await this.peer.addIceCandidate(message.candidate);
        else if (this.pendingIce.length < 256) this.pendingIce.push(message.candidate);
        else throw new Error("Too many pending ICE candidates");
      } else if (message.type === "session-ended") {
        this.releaseAll();
        this.authorizationValid = false;
        this.events.onSessionEnded(message.reason ?? "Session ended by the host");
        this.dispose();
      }
    } catch {
      this.requestRecovery("WebRTC negotiation failed");
    }
  }

  private send(channel: RTCDataChannel, payload: ControlPayload): boolean {
    if (!this.enforceLifetime() || !this.canControl() || channel.readyState !== "open") return false;
    try { channel.send(this.encode(payload)); }
    catch { this.requestRecovery("The input channel closed"); return false; }
    if (payload.type === "heartbeat") { this.lastHeartbeatSentAt = performance.now(); this.lastHeartbeatWallAt = Date.now(); }
    if (payload.type !== "heartbeat" && payload.type !== "release-all") this.userActivity();
    return true;
  }

  private encode(payload: ControlPayload): string {
    const message: DataMessage = {
      ...payload,
      seq: ++this.seq,
      epoch: this.session.epoch,
      ...((this.session.protocolVersion ?? 1) >= 2 ? { inputEpoch: this.inputEpoch } : {}),
    };
    return JSON.stringify(message);
  }

  private signal(message: object): boolean {
    if (!this.enforceLifetime() || this.socket?.readyState !== WebSocket.OPEN) return false;
    try { this.socket.send(JSON.stringify(message)); }
    catch { this.requestRecovery("The authorized signaling connection closed"); return false; }
    return true;
  }

  private signalingExpired(): boolean {
    return this.signalingAge() >= SYNC_LIMITS.signalingLivenessTimeoutSeconds * 1000;
  }

  private signalingAge(): number {
    // Monotonic time defeats rollback; forward wall time also detects platforms that pause it during sleep.
    return Math.max(performance.now() - this.lastPongAt, Date.now() - this.lastPongWallAt);
  }

  private enforceLifetime(): boolean {
    if (this.disposed || this.recoveryRequested) return false;
    if (!this.events.hasAuthority()) {
      this.authorizationValid = false;
      this.inputArmed = false;
      this.dispose();
      this.events.onSessionEnded("Remote access expired. Enter a new access code.");
      return false;
    }
    if (document.visibilityState !== "visible") {
      this.requestRecovery("The page was hidden");
      return false;
    }
    if (this.signalingExpired()) {
      this.requestRecovery("The authorized signaling connection stopped responding");
      return false;
    }
    return true;
  }

  private scheduleSignalingDeadline(): void {
    if (this.signalingDeadlineTimer !== null) window.clearTimeout(this.signalingDeadlineTimer);
    const remaining = SYNC_LIMITS.signalingLivenessTimeoutSeconds * 1000 - this.signalingAge();
    this.signalingDeadlineTimer = window.setTimeout(() => {
      if (this.enforceLifetime()) this.scheduleSignalingDeadline();
    }, Math.max(1, remaining));
  }

  private publishDisplays(): void { this.events.onDisplays({ ...this.displayState, displays: [...this.displayState.displays] }); }

  private armInput(): void {
    if (!this.enforceLifetime() || !this.authorizationValid || this.pendingDisplay || this.displayState.busy
      || (this.supportsDisplays && !this.initialDisplaysReceived)
      || this.peer.connectionState !== "connected" || this.control.readyState !== "open" || this.motion.readyState !== "open") return;
    if (this.session.scope === "control") {
      try { this.control.send(this.encode({ type: "heartbeat" })); }
      catch { this.requestRecovery("The input channel closed"); return; }
      this.lastHeartbeatSentAt = performance.now();
      this.lastHeartbeatWallAt = Date.now();
    }
    this.inputArmed = true;
    this.publishDisplays();
  }

  private handleDisplaySignal(message: SignalingMessage): void {
    if (!this.supportsDisplays || message.sessionId !== this.session.id || !validateWire("WireSignal", message)) {
      this.endDisplayFailure("Invalid display metadata");
      return;
    }
    if (message.requestId && this.completedDisplayRequests.has(message.requestId)) return;
    const pending = this.pendingDisplay;
    if (message.type === "display-error") {
      if (pending && message.requestId && message.requestId !== pending.requestId) return;
      this.endDisplayFailure(`Display ${message.reason ?? "unavailable"}`);
      return;
    }
    if (!message.displays || !message.inputEpoch || !message.selectedDisplayId) return;
    const ids = new Set(message.displays.map(display => display.id));
    if (ids.size !== message.displays.length || !ids.has(message.selectedDisplayId)) {
      this.endDisplayFailure("The selected display is unavailable");
      return;
    }
    if (pending) {
      if (message.requestId !== pending.requestId && !(pending.querying && !message.requestId)) return;
      if (message.selectedDisplayId !== pending.displayId || message.inputEpoch === pending.previousEpoch) {
        this.endDisplayFailure("Display selection could not be confirmed");
        return;
      }
      this.completedDisplayRequests.add(pending.requestId);
      if (this.completedDisplayRequests.size > 32) this.completedDisplayRequests.delete(this.completedDisplayRequests.values().next().value!);
    } else if (message.requestId) return;
    else if (this.initialDisplaysReceived && (message.inputEpoch !== this.inputEpoch || message.selectedDisplayId !== this.displayState.selectedDisplayId)) {
      this.endDisplayFailure("The remote display changed");
      return;
    } else if (!this.initialDisplaysReceived && message.inputEpoch !== this.session.epoch) {
      this.endDisplayFailure("Invalid initial display epoch");
      return;
    }
    if (this.displayTimer !== null) window.clearTimeout(this.displayTimer);
    this.displayTimer = null;
    this.pendingDisplay = null;
    this.initialDisplaysReceived = true;
    this.inputEpoch = message.inputEpoch;
    this.displayState = { displays: message.displays, selectedDisplayId: message.selectedDisplayId, busy: false, error: null };
    this.publishDisplays();
    this.armInput();
  }

  private endDisplayFailure(reason: string): void {
    if (this.disposed) return;
    this.inputArmed = false;
    this.authorizationValid = false;
    this.events.onSessionEnded(reason);
    this.dispose();
  }

  private recordDataMessage(): void {
    if (!this.enforceLifetime()) return;
    this.metrics = {
      ...this.metrics,
      dataMessagesReceived: this.metrics.dataMessagesReceived + 1,
    };
    this.events.onMetrics(this.metrics);
  }

  private startMetrics(): void {
    if (this.metricsTimer !== null) return;
    void this.collectMetrics();
    this.metricsTimer = window.setInterval(() => void this.collectMetrics(), 1000);
  }

  private async collectMetrics(): Promise<void> {
    if (!this.enforceLifetime()) return;
    let reports: RTCStatsReport;
    try { reports = await this.peer.getStats(); } catch { return; }
    if (!this.enforceLifetime()) return;
    let bitrateKbps: number | null = null;
    let framesPerSecond: number | null = null;
    let resolution: string | null = null;
    let roundTripMs: number | null = null;
    let packetsLost: number | null = null;
    const now = performance.now();

    reports.forEach((report) => {
      if (report.type === "inbound-rtp" && report.kind === "video") {
        framesPerSecond = finite(report.framesPerSecond);
        packetsLost = finite(report.packetsLost);
        if (finite(report.frameWidth) && finite(report.frameHeight)) {
          resolution = `${report.frameWidth}x${report.frameHeight}`;
        }
        const bytes = finite(report.bytesReceived);
        if (bytes !== null && this.previousBytes) {
          const seconds = (now - this.previousBytes.at) / 1000;
          if (seconds > 0) bitrateKbps = Math.round(((bytes - this.previousBytes.bytes) * 8) / seconds / 1000);
        }
        if (bytes !== null) this.previousBytes = { at: now, bytes };
      }
      if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
        const rtt = finite(report.currentRoundTripTime);
        if (rtt !== null) roundTripMs = Math.round(rtt * 1000);
      }
    });

    this.metrics = {
      ...this.metrics,
      bitrateKbps,
      framesPerSecond,
      resolution,
      roundTripMs,
      packetsLost,
    };
    this.events.onMetrics(this.metrics);
  }
}
