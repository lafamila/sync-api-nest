import {
  ChevronsLeftRightEllipsis,
  Command,
  Delete,
  Expand,
  Keyboard,
  LogOut,
  Maximize2,
  Minimize2,
  MousePointer2,
  MoveHorizontal,
  Power,
  RotateCcw,
  Send,
  Shrink,
} from "lucide-react";
import {
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RemoteConnection } from "./remoteConnection";
import type {
  Account,
  ConnectionMetrics,
  ConnectionPhase,
  Device,
  Modifier,
  RemoteSession,
} from "./types";

interface RemoteConsoleProps {
  account: Account;
  connection: RemoteConnection;
  error: string | null;
  host: Device;
  metrics: ConnectionMetrics;
  onEnd: () => void;
  onLogout: () => void;
  phase: ConnectionPhase;
  session: RemoteSession;
  stream: MediaStream | null;
}

interface Point {
  x: number;
  y: number;
}

interface TouchPoint extends Point {
  startX: number;
  startY: number;
}

type FitMode = "fit" | "fill";
type GestureMode = "none" | "scroll" | "pinch";

const MODIFIER_KEYS: Array<{ modifier: Modifier; key: string; label: string }> = [
  { modifier: "meta", key: "MetaLeft", label: "Command" },
  { modifier: "ctrl", key: "ControlLeft", label: "Control" },
  { modifier: "alt", key: "AltLeft", label: "Option" },
  { modifier: "shift", key: "ShiftLeft", label: "Shift" },
];

const SPECIAL_KEYS = new Set([
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

const PHYSICAL_MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function center(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function formatMetric(value: number | null, suffix = ""): string {
  return value === null ? "--" : `${Math.round(value)}${suffix}`;
}

function phaseLabel(phase: ConnectionPhase): string {
  const labels: Record<ConnectionPhase, string> = {
    idle: "Idle",
    signaling: "Authorizing",
    connecting: "Connecting",
    connected: "Connected",
    reconnecting: "Connection lost",
    ended: "Ended",
    failed: "Failed",
  };
  return labels[phase];
}

export function RemoteConsole(props: RemoteConsoleProps) {
  const { account, connection, error, host, metrics, onEnd, onLogout, phase, session, stream } = props;
  const [fit, setFit] = useState<FitMode>("fit");
  const [zoom, setZoom] = useState(1);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [stickyModifiers, setStickyModifiers] = useState<Set<Modifier>>(new Set());
  const [fullscreen, setFullscreen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const suppressedInputRef = useRef<string | null>(null);
  const touchesRef = useRef(new Map<number, TouchPoint>());
  const mouseButtonRef = useRef<"left" | "right" | null>(null);
  const touchDraggingRef = useRef(false);
  const gestureRef = useRef<{
    mode: GestureMode;
    hadTwo: boolean;
    initialDistance: number;
    initialZoom: number;
    lastCenter: Point;
    rightClickPoint: Point;
  } | null>(null);

  const authorized = phase === "connected" && session.scope === "control" && connection.canControl();
  const modifierList = useMemo(() => Array.from(stickyModifiers), [stickyModifiers]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    if (keyboardOpen) keyboardRef.current?.focus();
  }, [keyboardOpen]);

  useEffect(() => {
    const release = () => {
      connection.releaseAll();
      setStickyModifiers(new Set());
      mouseButtonRef.current = null;
      touchDraggingRef.current = false;
    };
    const visibility = () => {
      if (document.visibilityState !== "visible") release();
    };
    const fullscreenChange = () => setFullscreen(document.fullscreenElement === stageRef.current);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("fullscreenchange", fullscreenChange);
    return () => {
      release();
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("fullscreenchange", fullscreenChange);
    };
  }, [connection]);

  function normalized(clientX: number, clientY: number): Point | null {
    const stage = stageRef.current;
    const video = videoRef.current;
    if (!stage || !video || video.videoWidth === 0 || video.videoHeight === 0) return null;
    const rect = stage.getBoundingClientRect();
    const containerRatio = rect.width / rect.height;
    const videoRatio = video.videoWidth / video.videoHeight;
    let width: number;
    let height: number;
    if ((fit === "fit" && videoRatio > containerRatio) || (fit === "fill" && videoRatio < containerRatio)) {
      width = rect.width;
      height = width / videoRatio;
    } else {
      height = rect.height;
      width = height * videoRatio;
    }
    width *= zoom;
    height *= zoom;
    const left = rect.left + (rect.width - width) / 2;
    const top = rect.top + (rect.height - height) / 2;
    const x = (clientX - left) / width;
    const y = (clientY - top) / height;
    if (fit === "fit" && zoom === 1 && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
  }

  function sendButton(point: Point, button: "left" | "right", down: boolean) {
    connection.sendReliable({ type: "button", x: point.x, y: point.y, button, down });
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!authorized) return;
    if ((event.target as Element).closest("button")) return;
    event.currentTarget.focus();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Input remains valid when the browser cannot retain pointer capture.
    }
    const point = normalized(event.clientX, event.clientY);
    if (!point) return;

    if (event.pointerType !== "touch") {
      if (event.button !== 0 && event.button !== 2) return;
      const button = event.button === 2 ? "right" : "left";
      mouseButtonRef.current = button;
      sendButton(point, button, true);
      return;
    }

    touchesRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    });
    const points = Array.from(touchesRef.current.values());
    if (points.length === 2) {
      if (touchDraggingRef.current) {
        connection.releaseAll();
        touchDraggingRef.current = false;
      }
      const midpoint = center(points[0], points[1]);
      gestureRef.current = {
        mode: "none",
        hadTwo: true,
        initialDistance: pointDistance(points[0], points[1]),
        initialZoom: zoom,
        lastCenter: midpoint,
        rightClickPoint: midpoint,
      };
    }
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!authorized) return;
    const mapped = normalized(event.clientX, event.clientY);
    if (event.pointerType !== "touch") {
      if (mapped) connection.sendMotion({ type: "pointer", ...mapped });
      return;
    }

    const touch = touchesRef.current.get(event.pointerId);
    if (!touch) return;
    touch.x = event.clientX;
    touch.y = event.clientY;
    const points = Array.from(touchesRef.current.values());

    if (points.length === 1 && !gestureRef.current?.hadTwo) {
      if (!mapped) return;
      if (!touchDraggingRef.current && pointDistance(touch, { x: touch.startX, y: touch.startY }) > 7) {
        const start = normalized(touch.startX, touch.startY);
        if (start) {
          sendButton(start, "left", true);
          touchDraggingRef.current = true;
        }
      }
      if (touchDraggingRef.current) connection.sendMotion({ type: "pointer", ...mapped });
      return;
    }

    if (points.length !== 2 || !gestureRef.current) return;
    const gesture = gestureRef.current;
    const midpoint = center(points[0], points[1]);
    const distance = pointDistance(points[0], points[1]);
    const distanceDelta = Math.abs(distance - gesture.initialDistance);
    const centerDelta = pointDistance(midpoint, gesture.rightClickPoint);
    if (gesture.mode === "none") {
      if (distanceDelta > 8) gesture.mode = "pinch";
      else if (centerDelta > 5) gesture.mode = "scroll";
    }
    if (gesture.mode === "pinch") {
      setZoom(clamp(gesture.initialZoom * (distance / gesture.initialDistance), 1, 3));
    } else if (gesture.mode === "scroll") {
      connection.sendReliable({
        type: "scroll",
        dx: clamp((gesture.lastCenter.x - midpoint.x) * 1.5, -80, 80),
        dy: clamp((gesture.lastCenter.y - midpoint.y) * 1.5, -80, 80),
      });
    }
    gesture.lastCenter = midpoint;
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!authorized) return;
    const mapped = normalized(event.clientX, event.clientY);
    if (event.pointerType !== "touch") {
      if (mapped && mouseButtonRef.current) sendButton(mapped, mouseButtonRef.current, false);
      mouseButtonRef.current = null;
      return;
    }

    const ended = touchesRef.current.get(event.pointerId);
    touchesRef.current.delete(event.pointerId);
    if (gestureRef.current?.hadTwo) {
      if (touchesRef.current.size === 0) {
        if (gestureRef.current.mode === "none") {
          const click = normalized(gestureRef.current.rightClickPoint.x, gestureRef.current.rightClickPoint.y);
          if (click) {
            sendButton(click, "right", true);
            sendButton(click, "right", false);
          }
        }
        gestureRef.current = null;
      }
      return;
    }

    if (touchDraggingRef.current) {
      if (mapped) sendButton(mapped, "left", false);
      else connection.releaseAll();
      touchDraggingRef.current = false;
    } else if (ended && mapped) {
      sendButton(mapped, "left", true);
      sendButton(mapped, "left", false);
    }
    if (touchesRef.current.size === 0) gestureRef.current = null;
  }

  function pointerCancel(event: PointerEvent<HTMLDivElement>) {
    touchesRef.current.delete(event.pointerId);
    gestureRef.current = null;
    touchDraggingRef.current = false;
    mouseButtonRef.current = null;
    connection.releaseAll();
  }

  function wheel(event: WheelEvent<HTMLDivElement>) {
    if (!authorized) return;
    event.preventDefault();
    connection.sendReliable({
      type: "scroll",
      dx: clamp(event.deltaX, -120, 120),
      dy: clamp(event.deltaY, -120, 120),
    });
  }

  function currentModifiers(event?: KeyboardEvent): Modifier[] {
    const modifiers = new Set(stickyModifiers);
    if (event?.metaKey) modifiers.add("meta");
    if (event?.ctrlKey) modifiers.add("ctrl");
    if (event?.altKey) modifiers.add("alt");
    if (event?.shiftKey) modifiers.add("shift");
    return Array.from(modifiers);
  }

  function keyboardEvent(event: KeyboardEvent<HTMLTextAreaElement>, down: boolean) {
    if (!authorized || composingRef.current) return;
    const hasCommandModifier = event.metaKey || event.ctrlKey || event.altKey;
    const key = SPECIAL_KEYS.has(event.key) ? event.key : event.code;
    if (!SPECIAL_KEYS.has(event.key) && !hasCommandModifier && !PHYSICAL_MODIFIER_CODES.has(event.code)) return;
    event.preventDefault();
    connection.sendReliable({ type: "key", key, down, modifiers: currentModifiers(event) });
  }

  function textInput(event: FormEvent<HTMLTextAreaElement>) {
    const nativeEvent = event.nativeEvent as InputEvent;
    event.currentTarget.value = "";
    if (!authorized || nativeEvent.isComposing || composingRef.current) return;
    const text = nativeEvent.data;
    if (!text) return;
    if (suppressedInputRef.current === text) {
      suppressedInputRef.current = null;
      return;
    }
    connection.sendReliable({ type: "text", text: text.slice(0, 1024) });
  }

  function compositionEnd(event: CompositionEvent<HTMLTextAreaElement>) {
    composingRef.current = false;
    const text = event.data.slice(0, 1024);
    if (!authorized || !text) return;
    suppressedInputRef.current = text;
    connection.sendReliable({ type: "text", text });
    window.setTimeout(() => {
      if (suppressedInputRef.current === text) suppressedInputRef.current = null;
    }, 0);
    event.currentTarget.value = "";
  }

  function toggleModifier(modifier: Modifier, key: string) {
    if (!authorized) return;
    setStickyModifiers((current) => {
      const next = new Set(current);
      const down = !next.has(modifier);
      if (down) next.add(modifier);
      else next.delete(modifier);
      connection.sendReliable({ type: "key", key, down, modifiers: Array.from(next) });
      return next;
    });
  }

  function tapKey(key: string) {
    if (!authorized) return;
    connection.sendReliable({ type: "key", key, down: true, modifiers: modifierList });
    connection.sendReliable({ type: "key", key, down: false, modifiers: modifierList });
  }

  function releaseAll() {
    connection.releaseAll();
    setStickyModifiers(new Set());
  }

  async function toggleFullscreen() {
    if (!stageRef.current) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stageRef.current.requestFullscreen();
  }

  return (
    <main className="remote-shell">
      <header className="remote-header">
        <div className="brand compact">
          <span className="brand-mark" aria-hidden="true"><img src="/sync-icon.png" alt="" /></span>
          <strong>Sync</strong>
        </div>
        <div className="session-title">
          <strong>{host.name}</strong>
          <span className={`status-dot ${phase}`} />
          <span>{phaseLabel(phase)}</span>
          <span className="scope-badge">{session.scope}</span>
        </div>
        <div className="remote-actions">
          <span className="account-inline">{account.name}</span>
          <button className="icon-button danger" title="End session" aria-label="End session" onClick={onEnd}><Power /></button>
          <button className="icon-button" title="Sign out" aria-label="Sign out" onClick={onLogout}><LogOut /></button>
        </div>
      </header>

      <section className="remote-main">
        <div
          className={`video-stage ${authorized ? "controllable" : ""}`}
          ref={stageRef}
          tabIndex={0}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerCancel}
          onWheel={wheel}
          aria-label={`${host.name} remote screen`}
          data-testid="video-stage"
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={fit}
            style={{ transform: `scale(${zoom})` }}
            data-testid="remote-video"
          />
          {!stream && (
            <div className="video-placeholder">
              <div className="signal-rings"><span /><span /><span /></div>
              <strong>{phaseLabel(phase)}</strong>
              {error && <span className="video-error">{error}</span>}
            </div>
          )}
          <div className="stage-controls">
            <div className="segmented icon-segmented" aria-label="Video fit">
              <button className={fit === "fit" ? "active" : ""} title="Fit screen" aria-label="Fit screen" onClick={() => setFit("fit")}><Shrink /></button>
              <button className={fit === "fill" ? "active" : ""} title="Fill screen" aria-label="Fill screen" onClick={() => setFit("fill")}><Maximize2 /></button>
            </div>
            {zoom > 1 && (
              <button className="icon-button overlay" title="Reset zoom" aria-label="Reset zoom" onClick={() => setZoom(1)}><RotateCcw /></button>
            )}
            <button className="icon-button overlay" title={fullscreen ? "Exit fullscreen" : "Fullscreen"} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={() => void toggleFullscreen()}>
              {fullscreen ? <Minimize2 /> : <Expand />}
            </button>
          </div>
        </div>

        <aside className="metrics-panel" aria-label="Connection metrics">
          <Metric label="RTT" value={formatMetric(metrics.roundTripMs, " ms")} />
          <Metric label="Video" value={metrics.resolution ?? "--"} />
          <Metric label="FPS" value={formatMetric(metrics.framesPerSecond)} />
          <Metric label="Rate" value={formatMetric(metrics.bitrateKbps, " kbps")} />
          <Metric label="Loss" value={formatMetric(metrics.packetsLost)} />
          <Metric label="Data RX" value={String(metrics.dataMessagesReceived)} testId="data-rx" />
        </aside>
      </section>

      {session.scope === "control" && (
        <footer className="control-dock">
          <div className="control-state">
            <MousePointer2 />
            <span>{authorized ? "Input active" : "Input locked"}</span>
          </div>
          <div className="key-group">
            {MODIFIER_KEYS.map(({ modifier, key, label }) => (
              <button
                key={modifier}
                className={`key-button ${stickyModifiers.has(modifier) ? "active" : ""}`}
                title={label}
                aria-label={label}
                aria-pressed={stickyModifiers.has(modifier)}
                disabled={!authorized}
                onClick={() => toggleModifier(modifier, key)}
              >
                {modifier === "meta" ? <Command /> : label.slice(0, 3)}
              </button>
            ))}
            <span className="dock-divider" />
            <button className="key-button" title="Escape" aria-label="Escape" disabled={!authorized} onClick={() => tapKey("Escape")}>Esc</button>
            <button className="key-button" title="Tab" aria-label="Tab" disabled={!authorized} onClick={() => tapKey("Tab")}><ChevronsLeftRightEllipsis /></button>
            <button className="key-button" title="Backspace" aria-label="Backspace" disabled={!authorized} onClick={() => tapKey("Backspace")}><Delete /></button>
            <button className="key-button" title="Enter" aria-label="Enter" disabled={!authorized} onClick={() => tapKey("Enter")}><MoveHorizontal /></button>
          </div>
          <div className="dock-actions">
            <button className="icon-button" title="Release all keys" aria-label="Release all keys" disabled={!authorized} onClick={releaseAll}><RotateCcw /></button>
            <button className={`icon-button ${keyboardOpen ? "active" : ""}`} title="Keyboard" aria-label="Keyboard" disabled={!authorized} onClick={() => setKeyboardOpen((open) => !open)}><Keyboard /></button>
          </div>
          {keyboardOpen && (
            <label className="text-entry">
              <textarea
                ref={keyboardRef}
                rows={1}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Remote text input"
                onCompositionStart={() => {
                  composingRef.current = true;
                  suppressedInputRef.current = null;
                }}
                onCompositionEnd={compositionEnd}
                onInput={textInput}
                onKeyDown={(event) => keyboardEvent(event, true)}
                onKeyUp={(event) => keyboardEvent(event, false)}
              />
              <Send />
            </label>
          )}
        </footer>
      )}
    </main>
  );
}

function Metric({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong data-testid={testId}>{value}</strong>
    </div>
  );
}
