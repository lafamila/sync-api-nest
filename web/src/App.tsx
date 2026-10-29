import {
  ArrowRight,
  CircleAlert,
  Laptop,
  Monitor,
  LoaderCircle,
  LogIn,
  LogOut,
  MonitorOff,
  RefreshCw,
  ShieldCheck,
  Wifi,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, supportsV2 } from "./api";
import { BrowserAccess } from "./browserAccess";
import { RemoteConsole } from "./RemoteConsole";
import { RemoteConnection } from "./remoteConnection";
import type {
  Account,
  ConnectionMetrics,
  ConnectionPhase,
  Device,
  RemoteSession,
  PublicConfig,
  DisplayState,
} from "./types";

type AuthState = "checking" | "guest" | "authenticated" | "forbidden";

interface LiveConnection {
  connection: RemoteConnection;
  session: RemoteSession;
  host: Device;
  generation: number;
}

interface ActiveAccess {
  host: Device;
  pin: string;
  scope: "view" | "control";
  lease: BrowserAccess;
}

interface ReconnectTask {
  generation: number;
  abort: AbortController;
}

const RECONNECT_BACKOFF_MS = [0, 500, 1_500] as const;

const EMPTY_METRICS: ConnectionMetrics = {
  bitrateKbps: null,
  framesPerSecond: null,
  resolution: null,
  roundTripMs: null,
  packetsLost: null,
  dataMessagesReceived: 0,
};

function readableError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}

function expiryLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown expiry";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = 0;
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = window.setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function retryableReconnectError(error: unknown): boolean {
  return error instanceof ApiError
    ? error.status === 409 || error.status >= 500
    : error instanceof TypeError;
}

function waitForVisible(signal: AbortSignal): Promise<void> {
  if (signal.aborted || document.visibilityState === "visible") return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      if (!signal.aborted && document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    document.addEventListener("visibilitychange", finish);
    signal.addEventListener("abort", finish, { once: true });
    finish();
  });
}

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [account, setAccount] = useState<Account | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [selected, setSelected] = useState<Device | null>(null);
  const [pin, setPin] = useState("");
  const [scope, setScope] = useState<"view" | "control">("control");
  const [submitting, setSubmitting] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [error, setError] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("auth") === "failed"
      ? "Authentication failed"
      : null,
  );
  const [live, setLive] = useState<LiveConnection | null>(null);
  const [phase, setPhase] = useState<ConnectionPhase>("idle");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [metrics, setMetrics] = useState<ConnectionMetrics>(EMPTY_METRICS);
  const [displayState, setDisplayState] = useState<DisplayState>({ displays: [], selectedDisplayId: null, busy: false, error: null });
  const configRef = useRef<PublicConfig | null>(null);
  const liveRef = useRef<LiveConnection | null>(null);
  const activeAccessRef = useRef<ActiveAccess | null>(null);
  const generationRef = useRef(0);
  const reconnectTaskRef = useRef<ReconnectTask | null>(null);

  const loadDevices = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const result = await api.devices();
      setDevices(
        result.devices.filter(
          (device) => (device.platform === "macos" || device.platform === "windows") && device.online,
        ),
      );
    } catch (nextError) {
      if (nextError instanceof ApiError && nextError.status === 401) {
        activeAccessRef.current?.lease.clear();
        activeAccessRef.current = null;
        setAuthState("guest");
        setAccount(null);
      } else {
        setError(readableError(nextError));
      }
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void api.config().then(config => { if (active) configRef.current = config; }).catch(nextError => { if (active) setError(readableError(nextError)); });
    void api
      .me()
      .then(({ account: nextAccount }) => {
        if (!active) return;
        if (!["member", "superadmin"].includes(nextAccount.permission)) {
          setAuthState("forbidden");
          return;
        }
        setAccount(nextAccount);
        setAuthState("authenticated");
      })
      .catch((nextError: unknown) => {
        if (!active) return;
        if (nextError instanceof ApiError && nextError.status === 401) setAuthState("guest");
        else {
          setAuthState("guest");
          setError(readableError(nextError));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (authState !== "authenticated" || live) return;
    void loadDevices();
    const timer = window.setInterval(() => void loadDevices(), 10_000);
    return () => window.clearInterval(timer);
  }, [authState, live, loadDevices]);

  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      reconnectTaskRef.current?.abort.abort();
      reconnectTaskRef.current = null;
      activeAccessRef.current?.lease.clear();
      activeAccessRef.current = null;
      liveRef.current?.connection.dispose();
    },
    [],
  );

  useEffect(() => {
    const foreground = () => {
      if (document.visibilityState !== "visible") return;
      if (activeAccessRef.current?.lease.expired()) {
        finishTerminalSession(generationRef.current, "Remote access expired. Enter a new access code.");
        return;
      }
      if (reconnectTaskRef.current) return;
      const current = liveRef.current;
      if (current && !current.connection.checkAuthorization()) return;
      if (current?.connection.inputHeartbeatExpired()) {
        current.connection.requestRecovery("Input heartbeat paused while the page was in the background");
      } else current?.connection.resumeInputHeartbeat();
    };
    const visibility = () => {
      if (document.visibilityState !== "visible") liveRef.current?.connection.requestRecovery("The page was hidden");
      else foreground();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", foreground);
    window.addEventListener("online", foreground);
    window.addEventListener("pageshow", foreground);
    const idleTimer = window.setInterval(() => {
      if (activeAccessRef.current?.lease.expired()) finishTerminalSession(generationRef.current, "Remote access expired. Enter a new access code.");
    }, 500);
    return () => {
      window.clearInterval(idleTimer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", foreground);
      window.removeEventListener("online", foreground);
      window.removeEventListener("pageshow", foreground);
    };
  }, []);

  async function login() {
    setLoginLoading(true);
    setError(null);
    try {
      const { authorizeUrl } = await api.startLogin();
      const destination = new URL(authorizeUrl, window.location.origin);
      if (!['http:', 'https:'].includes(destination.protocol)) {
        throw new Error("The authentication URL is invalid");
      }
      window.location.assign(destination.toString());
    } catch (nextError) {
      setError(readableError(nextError));
      setLoginLoading(false);
    }
  }

  function isCurrent(generation: number, connection?: RemoteConnection): boolean {
    return generationRef.current === generation
      && (!connection || liveRef.current?.connection === connection);
  }

  function installConnection(result: Awaited<ReturnType<typeof api.connect>>, access: ActiveAccess, generation: number) {
    if (document.visibilityState !== "visible" || access.lease.expired()) {
      void api.endSession(result.session.id).catch(() => undefined);
      finishTerminalSession(generation,"Remote access closed. Enter a new access code.");
      return;
    }
    let connection!: RemoteConnection;
    connection = new RemoteConnection(result.session, result.iceServers, {
      onMetrics: (nextMetrics) => {
        if (isCurrent(generation, connection)) setMetrics(nextMetrics);
      },
      onPhase: (nextPhase) => {
        if (isCurrent(generation, connection)) setPhase(nextPhase);
      },
      onRecoveryNeeded: (reason) => {
        if (isCurrent(generation, connection)) beginReconnect(generation, reason);
      },
      onStream: (nextStream) => {
        if (isCurrent(generation, connection)) setStream(nextStream);
      },
      onSessionEnded: (reason) => {
        if (isCurrent(generation, connection)) finishTerminalSession(generation, reason);
      },
      onDisplays: state => { if (isCurrent(generation,connection)) setDisplayState(state); },
      onActivity: () => { if (isCurrent(generation,connection)) void recordUserActivity(generation); },
      hasAuthority: () => generationRef.current === generation && activeAccessRef.current === access && !access.lease.expired(),
    });
    const nextLive = { connection, session: result.session, host: access.host, generation };
    liveRef.current = nextLive;
    setLive(nextLive);
    setPhase("signaling");
    setStream(null);
    setMetrics(EMPTY_METRICS);
    setDisplayState({ displays: [], selectedDisplayId: null, busy: false, error: null });
    setError(null);
    void connection.start(result.ticket);
  }

  function finishTerminalSession(generation: number, reason: string) {
    if (generationRef.current !== generation) return;
    generationRef.current += 1;
    reconnectTaskRef.current?.abort.abort();
    reconnectTaskRef.current = null;
    activeAccessRef.current?.lease.clear();
    activeAccessRef.current = null;
    setPin("");
    const current = liveRef.current;
    current?.connection.releaseAll();
    current?.connection.dispose();
    if (current) void api.endSession(current.session.id).catch(() => undefined);
    liveRef.current = null;
    setLive(null);
    setSelected(null);
    setStream(null);
    setPhase("ended");
    setError(reason === "idle_timeout" ? "Remote access expired. Enter a new access code." : reason);
  }

  async function recordUserActivity(generation: number) {
    const access = activeAccessRef.current;
    const current = liveRef.current;
    if (!access || !current || generationRef.current !== generation) return;
    if (access.lease.expired()) { finishTerminalSession(generation,"Remote access expired. Enter a new access code."); return; }
    const token = access.lease.recordActivity();
    if (!token) return;
    try {
      const state = await api.activity(current.session.id,token);
      if (!isCurrent(generation,current.connection) || activeAccessRef.current !== access) return;
      if (!access.lease.finishActivity(state)) finishTerminalSession(generation,"Remote access expired. Enter a new access code.");
    } catch (nextError) {
      if (!isCurrent(generation,current.connection) || activeAccessRef.current !== access) return;
      access.lease.finishActivity();
      if (nextError instanceof ApiError && [401,403,404,410,426].includes(nextError.status)) finishTerminalSession(generation,readableError(nextError));
    }
  }

  function beginReconnect(sourceGeneration: number, _reason: string) {
    if (generationRef.current !== sourceGeneration || !activeAccessRef.current || reconnectTaskRef.current) return;
    const current = liveRef.current;
    if (!current || current.generation !== sourceGeneration) return;
    if (activeAccessRef.current.lease.expired()) { finishTerminalSession(sourceGeneration,"Remote access expired. Enter a new access code."); return; }

    const generation = sourceGeneration + 1;
    generationRef.current = generation;
    current.connection.releaseAll();
    current.connection.dispose();
    setPhase("reconnecting");
    setStream(null);
    setMetrics(EMPTY_METRICS);
    setError(null);

    const abort = new AbortController();
    reconnectTaskRef.current = { generation, abort };
    void reconnect(generation, current.session.id, abort.signal).finally(() => {
      if (reconnectTaskRef.current?.generation === generation) reconnectTaskRef.current = null;
    });
  }

  async function reconnect(generation: number, oldSessionId: string, signal: AbortSignal) {
    await waitForVisible(signal);
    if (signal.aborted || generationRef.current !== generation) return;
    const originalAccess = activeAccessRef.current;
    if (!originalAccess) return;
    if (originalAccess.lease.expired()) { finishTerminalSession(generation,"Remote access expired. Enter a new access code."); return; }
    if (supportsV2(originalAccess.lease.config)) {
      const token = originalAccess.lease.takeRecoveryToken();
      if (!token) { finishReconnectFailure(generation,new Error("Remote access expired. Enter a new access code."),false); return; }
      try {
        const result = await api.recover(oldSessionId,token,originalAccess.lease.config,signal);
        if (signal.aborted || generationRef.current !== generation || activeAccessRef.current !== originalAccess) {
          void api.endSession(result.session.id).catch(() => undefined);
          return;
        }
        try { originalAccess.lease.recovered(result); }
        catch (nextError) { void api.endSession(result.session.id).catch(() => undefined); throw nextError; }
        installConnection(result,originalAccess,generation);
      } catch (nextError) {
        if (!signal.aborted && generationRef.current === generation) finishReconnectFailure(generation,nextError,nextError instanceof ApiError && nextError.status === 401);
      }
      return;
    }
    await Promise.race([
      api.endSession(oldSessionId).catch(() => undefined),
      waitFor(750, signal),
    ]);

    for (let attempt = 0; attempt < RECONNECT_BACKOFF_MS.length; attempt += 1) {
      await waitFor(RECONNECT_BACKOFF_MS[attempt], signal);
      await waitForVisible(signal);
      if (signal.aborted || generationRef.current !== generation) return;
      const access = activeAccessRef.current;
      if (!access) return;
      if (access.lease.expired()) { finishTerminalSession(generation,"Remote access expired. Enter a new access code."); return; }

      try {
        const result = await api.connect(access.host.id, access.pin, access.scope, access.lease.config, signal);
        if (signal.aborted || generationRef.current !== generation || !activeAccessRef.current) {
          void api.endSession(result.session.id).catch(() => undefined);
          return;
        }
        try { access.lease.recovered(result); }
        catch (nextError) { void api.endSession(result.session.id).catch(() => undefined); throw nextError; }
        installConnection(result, access, generation);
        return;
      } catch (nextError) {
        if (signal.aborted || generationRef.current !== generation) return;
        const status = nextError instanceof ApiError ? nextError.status : null;
        if (status === 401 || status === 403) {
          finishReconnectFailure(generation, nextError, status === 401);
          return;
        }
        const finalAttempt = attempt === RECONNECT_BACKOFF_MS.length - 1;
        if (!retryableReconnectError(nextError) || finalAttempt) {
          finishReconnectFailure(generation, nextError, false);
          return;
        }
      }
    }
  }

  function finishReconnectFailure(generation: number, nextError: unknown, authLost: boolean) {
    if (generationRef.current !== generation) return;
    generationRef.current += 1;
    reconnectTaskRef.current?.abort.abort();
    reconnectTaskRef.current = null;
    activeAccessRef.current?.lease.clear();
    activeAccessRef.current = null;
    setPin("");
    liveRef.current?.connection.dispose();
    liveRef.current = null;
    setLive(null);
    setSelected(null);
    setStream(null);
    setPhase("failed");
    setError(readableError(nextError));
    if (authLost) {
      setAccount(null);
      setDevices([]);
      setAuthState("guest");
    }
  }

  async function connect() {
    if (!selected || !/^\d{6}$/.test(pin) || submitting) return;
    const pending = { host: selected, pin, scope };
    const generation = ++generationRef.current;
    setSubmitting(true);
    setError(null);
    setPhase("signaling");
    setMetrics(EMPTY_METRICS);
    setStream(null);

    try {
      const config = configRef.current ?? await api.config();
      configRef.current = config;
      const result = await api.connect(pending.host.id, pending.pin, pending.scope, config);
      if (generationRef.current !== generation) { void api.endSession(result.session.id).catch(() => undefined); return; }
      let lease: BrowserAccess;
      try { lease = new BrowserAccess(config,result); }
      catch (nextError) { void api.endSession(result.session.id).catch(() => undefined); throw nextError; }
      const access: ActiveAccess = { ...pending, pin: supportsV2(config) ? "" : pending.pin, lease };
      activeAccessRef.current = access;
      setPin("");
      setSelected(null);
      installConnection(result, access, generation);
    } catch (nextError) {
      if (generationRef.current !== generation) return;
      setError(readableError(nextError));
      setPhase("failed");
      setPin("");
      if (nextError instanceof ApiError && nextError.status === 401) {
        setAccount(null);
        setDevices([]);
        setAuthState("guest");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function endSession() {
    const current = liveRef.current;
    if (!current) return;
    generationRef.current += 1;
    reconnectTaskRef.current?.abort.abort();
    reconnectTaskRef.current = null;
    activeAccessRef.current?.lease.clear();
    activeAccessRef.current = null;
    setPin("");
    current.connection.releaseAll();
    current.connection.dispose();
    setLive(null);
    liveRef.current = null;
    setStream(null);
    setPhase("ended");
    setSelected(null);
    try {
      await api.endSession(current.session.id);
    } catch (nextError) {
      setError(readableError(nextError));
    }
  }

  async function logout() {
    const current = liveRef.current;
    generationRef.current += 1;
    reconnectTaskRef.current?.abort.abort();
    reconnectTaskRef.current = null;
    activeAccessRef.current?.lease.clear();
    activeAccessRef.current = null;
    setPin("");
    current?.connection.releaseAll();
    current?.connection.dispose();
    liveRef.current = null;
    setLive(null);
    setSelected(null);
    setStream(null);
    setError(null);
    try {
      await api.logout();
    } catch (nextError) {
      if (!(nextError instanceof ApiError && nextError.status === 401)) {
        setError(readableError(nextError));
      }
    } finally {
      setAccount(null);
      setDevices([]);
      setAuthState("guest");
    }
  }

  if (authState === "checking") {
    return (
      <main className="centered-shell" aria-busy="true">
        <Brand />
        <LoaderCircle className="spin" aria-label="Checking session" />
      </main>
    );
  }

  if (authState === "guest" || authState === "forbidden") {
    return (
      <main className="auth-shell">
        <div className="auth-panel">
          <Brand />
          <div className="auth-status">
            {authState === "forbidden" ? <CircleAlert /> : <ShieldCheck />}
            <h1>{authState === "forbidden" ? "Access unavailable" : "Remote access"}</h1>
            <p>
              {authState === "forbidden"
                ? "Sync requires member access."
                : "Sign in with your teddy account."}
            </p>
          </div>
          {authState === "guest" && (
            <button className="primary wide" onClick={() => void login()} disabled={loginLoading}>
              {loginLoading ? <LoaderCircle className="spin" /> : <LogIn />}
              Sign in
            </button>
          )}
          {error && <ErrorNotice message={error} />}
        </div>
      </main>
    );
  }

  if (live) {
    return (
      <RemoteConsole
        account={account!}
        connection={live.connection}
        host={live.host}
        metrics={metrics}
        onEnd={() => void endSession()}
        onLogout={() => void logout()}
        phase={phase}
        session={live.session}
        stream={stream}
        error={error}
        displays={displayState}
      />
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <Brand />
        <div className="account-actions">
          <div className="account-copy">
            <strong>{account?.name}</strong>
            <span>{account?.permission}</span>
          </div>
          <button className="icon-button" title="Sign out" aria-label="Sign out" onClick={() => void logout()}>
            <LogOut />
          </button>
        </div>
      </header>

      <section className="device-workspace">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Available hosts</span>
            <h1>Online desktops</h1>
          </div>
          <button
            className="icon-button"
            title="Refresh devices"
            aria-label="Refresh devices"
            onClick={() => void loadDevices()}
            disabled={devicesLoading}
          >
            <RefreshCw className={devicesLoading ? "spin" : ""} />
          </button>
        </div>

        {error && !selected && <ErrorNotice message={error} onDismiss={() => setError(null)} />}

        {devicesLoading && devices.length === 0 ? (
          <div className="empty-state" aria-busy="true">
            <LoaderCircle className="spin" />
            <span>Loading devices</span>
          </div>
        ) : devices.length === 0 ? (
          <div className="empty-state">
            <MonitorOff />
            <strong>No online desktops</strong>
          </div>
        ) : (
          <div className="device-list">
            {devices.map((device) => {
              const available = Boolean(device.mode?.allowBrowser);
              return (
                <button
                  key={device.id}
                  className={`device-row ${selected?.id === device.id ? "selected" : ""}`}
                  disabled={!available}
                  onClick={() => {
                    setSelected(device);
                    setError(null);
                    setPin("");
                  }}
                >
                  <span className="device-icon">{device.platform === "windows" ? <Monitor /> : <Laptop />}</span>
                  <span className="device-copy">
                    <strong>{device.name}</strong>
                    <span>
                      <Wifi /> {available ? `Browser mode until ${expiryLabel(device.mode!.expiresAt)}` : "Browser mode off"}
                    </span>
                  </span>
                  <ArrowRight />
                </button>
              );
            })}
          </div>
        )}
      </section>

      {selected && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => !submitting && setSelected(null)}>
          <section
            className="connect-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connect-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="dialog-device">
              <span className="device-icon">{selected.platform === "windows" ? <Monitor /> : <Laptop />}</span>
              <div>
                <span className="eyebrow">Connect to</span>
                <h2 id="connect-title">{selected.name}</h2>
              </div>
            </div>

            <div className="segmented" aria-label="Access scope">
              <button className={scope === "view" ? "active" : ""} onClick={() => setScope("view")}>View</button>
              <button className={scope === "control" ? "active" : ""} onClick={() => setScope("control")}>Control</button>
            </div>

            <label className="pin-field">
              <span>Access code</span>
              <input
                autoFocus
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void connect();
                }}
                aria-label="6-digit access code"
              />
            </label>

            {error && <ErrorNotice message={error} onDismiss={() => setError(null)} />}

            <div className="dialog-actions">
              <button onClick={() => setSelected(null)} disabled={submitting}>Cancel</button>
              <button className="primary" onClick={() => void connect()} disabled={submitting || pin.length !== 6}>
                {submitting ? <LoaderCircle className="spin" /> : <ArrowRight />}
                Connect
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function Brand() {
  return (
    <div className="brand" aria-label="Sync">
      <span className="brand-mark" aria-hidden="true"><img src="/sync-icon.png" alt="" /></span>
      <strong>Sync</strong>
    </div>
  );
}

function ErrorNotice({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div className="error-notice" role="alert">
      <CircleAlert />
      <span>{message}</span>
      {onDismiss && <button className="icon-button" aria-label="Dismiss error" onClick={onDismiss}>×</button>}
    </div>
  );
}
