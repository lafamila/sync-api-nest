import type { Account, ConnectResponse, Device } from "./types";

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

export const api = {
  me: () => request<{ account: Account }>("/api/session/me"),
  devices: () => request<{ devices: Device[] }>("/api/devices"),
  startLogin: () =>
    request<{ authorizeUrl: string; transactionId: string }>("/api/session/oidc/start", {
      method: "POST",
      body: JSON.stringify({ platform: "web" }),
    }),
  connect: (deviceId: string, code: string, scope: "view" | "control", signal?: AbortSignal) =>
    request<ConnectResponse>(`/api/devices/${encodeURIComponent(deviceId)}/connect`, {
      method: "POST",
      body: JSON.stringify({ code, scope }),
      signal,
    }),
  endSession: (sessionId: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
  logout: () => request<void>("/api/session/logout", { method: "POST" }),
};
