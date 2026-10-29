import type { WireAccount, WireMode, WireDevice, WireRemoteSession, WireICEServer, WireConnectResult, WirePublicConfig, WireFeatureFlags, WireDisplay } from "./generated/sync-wire";

export type Permission = WireAccount["permission"];
export type Account = WireAccount;
export type AccessMode = WireMode;
export type Device = WireDevice;
export type RemoteSession = WireRemoteSession;
export type IceServer = WireICEServer;
export type ConnectResponse = WireConnectResult;
export type PublicConfig = WirePublicConfig & { protocolVersion: number; minimumProtocolVersion: number; minimumWebProtocolVersion: number; capabilities: string[]; features: Required<WireFeatureFlags> };

export interface DisplayState {
  displays: WireDisplay[];
  selectedDisplayId: string | null;
  busy: boolean;
  error: string | null;
}

export type ConnectionPhase =
  | "idle"
  | "signaling"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "failed";

export interface ConnectionMetrics {
  bitrateKbps: number | null;
  framesPerSecond: number | null;
  resolution: string | null;
  roundTripMs: number | null;
  packetsLost: number | null;
  dataMessagesReceived: number;
}

export type Modifier = "meta" | "ctrl" | "alt" | "shift";

export type ControlPayload =
  | { type: "heartbeat" }
  | { type: "release-all" }
  | { type: "pointer"; x: number; y: number }
  | { type: "button"; x: number; y: number; button: "left" | "right"; down: boolean }
  | { type: "scroll"; dx: number; dy: number }
  | { type: "key"; key: string; down: boolean; modifiers: Modifier[] }
  | { type: "text"; text: string };

export type DataMessage = ControlPayload & { seq: number; epoch: string; inputEpoch?: string };
