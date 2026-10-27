export type Permission = "member" | "superadmin";

export interface Account {
  id: string;
  name: string;
  permission: Permission;
}

export interface AccessMode {
  epoch: string;
  expiresAt: string;
  allowBrowser: boolean;
}

export interface Device {
  id: string;
  name: string;
  platform: "macos" | "ios";
  online: boolean;
  mode: AccessMode | null;
}

export interface RemoteSession {
  id: string;
  hostId: string;
  controllerId: string;
  scope: "view" | "control";
  epoch: string;
  expiresAt: string;
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface ConnectResponse {
  session: RemoteSession;
  ticket: string;
  iceServers: IceServer[];
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

export type DataMessage = ControlPayload & { seq: number; epoch: string };
