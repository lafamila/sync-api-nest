import type {
  ConnectionMetrics,
  ConnectionPhase,
  ControlPayload,
  DataMessage,
  IceServer,
  RemoteSession,
} from "./types";

interface RemoteConnectionEvents {
  onMetrics: (metrics: ConnectionMetrics) => void;
  onPhase: (phase: ConnectionPhase) => void;
  onRecoveryNeeded: (reason: string) => void;
  onStream: (stream: MediaStream) => void;
  onSessionEnded: (reason: string) => void;
}

interface SignalingMessage {
  type: "ready" | "answer" | "ice" | "session-ended" | "pong";
  sessionId?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  reason?: string;
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
  private previousBytes: { at: number; bytes: number } | null = null;
  private metrics: ConnectionMetrics = { ...EMPTY_METRICS };
  private disposed = false;
  private offerSent = false;
  private authorizationValid = false;
  private recoveryRequested = false;
  private lastHeartbeatSentAt: number | null = null;
  private heartbeatSuspendedAt: number | null = null;
  private readonly pendingIce: RTCIceCandidateInit[] = [];

  constructor(
    readonly session: RemoteSession,
    iceServers: IceServer[],
    private readonly events: RemoteConnectionEvents,
  ) {
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
    this.events.onPhase("signaling");
    try {
      this.socket = new WebSocket(signalingUrl(ticket));
    } catch {
      this.requestRecovery("Signaling connection failed");
      return;
    }
    this.socket.addEventListener("message", (event) => void this.handleSignal(event));
    this.socket.addEventListener("error", () => this.requestRecovery("Signaling connection failed"));
    this.socket.addEventListener("close", () => {
      if (this.disposed) return;
      this.requestRecovery("The authorized signaling connection closed");
    });
  }

  requestRecovery(reason: string): void {
    if (this.disposed || this.recoveryRequested) return;
    this.recoveryRequested = true;
    this.releaseAll();
    this.authorizationValid = false;
    this.events.onRecoveryNeeded(reason);
  }

  inputHeartbeatExpired(now = Date.now()): boolean {
    return this.session.scope === "control"
      && ((this.heartbeatSuspendedAt !== null && now - this.heartbeatSuspendedAt > 1_500)
        || (this.lastHeartbeatSentAt !== null && now - this.lastHeartbeatSentAt > 1_500));
  }

  suspendInputHeartbeat(): void {
    if (this.session.scope !== "control" || this.heartbeatSuspendedAt !== null) return;
    this.releaseAll();
    this.heartbeatSuspendedAt = Date.now();
  }

  resumeInputHeartbeat(): void {
    if (this.heartbeatSuspendedAt === null) return;
    this.heartbeatSuspendedAt = null;
    this.sendReliable({ type: "heartbeat" });
  }

  canControl(): boolean {
    return (
      !this.disposed &&
      this.authorizationValid &&
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
    this.control.send(this.encode({ type: "release-all" }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.releaseAll();
    this.disposed = true;
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    if (this.metricsTimer !== null) window.clearInterval(this.metricsTimer);
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
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      event.track.addEventListener("ended", () => this.requestRecovery("The remote video track ended"));
      this.events.onStream(stream);
    });
    this.peer.addEventListener("connectionstatechange", () => {
      const state = this.peer.connectionState;
      if (state === "connected") {
        this.events.onPhase("connected");
        this.startMetrics();
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
    });
    this.control.addEventListener("message", () => this.recordDataMessage());
    this.motion.addEventListener("message", () => this.recordDataMessage());
    this.control.addEventListener("close", () => this.requestRecovery("The control channel closed"));
    this.motion.addEventListener("close", () => this.requestRecovery("The motion channel closed"));
    this.control.addEventListener("error", () => this.requestRecovery("The control channel failed"));
    this.motion.addEventListener("error", () => this.requestRecovery("The motion channel failed"));
  }

  private async handleSignal(event: MessageEvent): Promise<void> {
    let message: SignalingMessage;
    try {
      message = JSON.parse(String(event.data)) as SignalingMessage;
    } catch {
      this.requestRecovery("The signaling server sent an invalid message");
      return;
    }

    if (message.type === "ready" && !this.offerSent) {
      this.authorizationValid = true;
      this.offerSent = true;
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

    try {
      if (message.type === "answer" && message.sdp) {
        await this.peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
        for (const candidate of this.pendingIce.splice(0)) {
          await this.peer.addIceCandidate(candidate);
        }
      } else if (message.type === "ice" && message.candidate) {
        if (this.peer.remoteDescription) await this.peer.addIceCandidate(message.candidate);
        else this.pendingIce.push(message.candidate);
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
    if (!this.canControl() || channel.readyState !== "open") return false;
    channel.send(this.encode(payload));
    if (payload.type === "heartbeat") this.lastHeartbeatSentAt = Date.now();
    return true;
  }

  private encode(payload: ControlPayload): string {
    const message: DataMessage = {
      ...payload,
      seq: ++this.seq,
      epoch: this.session.epoch,
    };
    return JSON.stringify(message);
  }

  private signal(message: object): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private recordDataMessage(): void {
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
    if (this.disposed) return;
    const reports = await this.peer.getStats();
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
