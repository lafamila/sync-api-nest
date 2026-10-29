import type { Account, ConnectResponse, Device, PublicConfig } from "./types";
import { decodeWire, SYNC_PROTOCOL_VERSION, SYNC_CAPABILITIES } from "./generated/sync-wire";
import type { WireBrowserActivityState } from "./generated/sync-wire";

export function supportsV2(config: PublicConfig): boolean {
  return config.protocolVersion >= SYNC_PROTOCOL_VERSION;
}

function declaration(config: PublicConfig) {
  return supportsV2(config) ? { protocolVersion: SYNC_PROTOCOL_VERSION, capabilities: SYNC_CAPABILITIES.filter(capability => capability === "viewer-displays") } : {};
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function cookie(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`;
  const value = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return value ? decodeURIComponent(value.slice(prefix.length)) : null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  const method = init.method?.toUpperCase() ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    const csrfToken = cookie("sync_csrf");
    if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  if (!response.ok) {
    let message = response.status === 401 ? "Sign in required" : "Request failed";
    try {
      const body = (await response.json()) as { message?: string | string[] };
      if (Array.isArray(body.message)) message = body.message.join(". ");
      else if (body.message) message = body.message;
    } catch {
      // The status remains actionable when the server has no JSON error body.
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function createRemoteSession(path: string, body: object, callerSignal?: AbortSignal): Promise<ConnectResponse> {
  if (callerSignal?.aborted) throw callerSignal.reason ?? new DOMException("The operation was aborted", "AbortError");
  // A committed POST's ID must reach the caller's stale-result cleanup even after UI cancellation.
  const deadline = new AbortController();
  const timer = window.setTimeout(() => deadline.abort(new DOMException("The request timed out", "TimeoutError")), 30_000);
  try {
    return await request<ConnectResponse>(path, { method: "POST", body: JSON.stringify(body), signal: deadline.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

export const api = {
  config: async () => {
    const config = decodeWire<PublicConfig>("WirePublicConfig", await request<unknown>("/api/config"));
    if (config.minimumProtocolVersion > SYNC_PROTOCOL_VERSION || config.minimumWebProtocolVersion > SYNC_PROTOCOL_VERSION) throw new ApiError("Reload Sync to update the browser protocol", 426);
    return config;
  },
  me: () => request<{ account: Account }>("/api/session/me"),
  devices: () => request<{ devices: Device[] }>("/api/devices"),
  startLogin: () =>
    request<{ authorizeUrl: string; transactionId: string }>("/api/session/oidc/start", {
      method: "POST",
      body: JSON.stringify({ platform: "web" }),
    }),
  connect: (deviceId: string, code: string, scope: "view" | "control", config: PublicConfig, signal?: AbortSignal) =>
    createRemoteSession(`/api/devices/${encodeURIComponent(deviceId)}/connect`, { code, scope, ...declaration(config) }, signal),
  activity: async (sessionId: string, activityToken: string, signal?: AbortSignal) =>
    decodeWire<WireBrowserActivityState>("WireBrowserActivityState", await request<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/activity`, {
      method: "POST", body: JSON.stringify({ activityToken }), signal,
    })),
  recover: (sessionId: string, activityToken: string, config: PublicConfig, signal?: AbortSignal) =>
    createRemoteSession(`/api/sessions/${encodeURIComponent(sessionId)}/recover`, { activityToken, ...declaration(config) }, signal),
  endSession: (sessionId: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
  logout: () => request<void>("/api/session/logout", { method: "POST" }),
};
