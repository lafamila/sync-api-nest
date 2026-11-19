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
  Monitor,
  PanelRightOpen,
  PanelRightClose,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import {
  type CompositionEvent,
  type FormEvent,
  type PointerEvent,
  type WheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RemoteConnection } from "./remoteConnection";
import { keyboardBufferTail, remoteTextEdit, wireTextChunks } from "./remoteTextInput";
import { SYNC_KEYS } from "./generated/sync-wire";
import type {
  Account,
  ConnectionMetrics,
  ConnectionPhase,
  Device,
  Modifier,
  RemoteSession,
  DisplayState,
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
  displays: DisplayState;
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

const MODIFIER_KEYS: Array<{ modifier: Modifier; label: string }> = [
  { modifier: "meta", label: "Command" },
  { modifier: "ctrl", label: "Control" },
  { modifier: "alt", label: "Option" },
  { modifier: "shift", label: "Shift" },
];

const WIRE_KEYS = new Set<string>(SYNC_KEYS);
const SPECIAL_KEYS = new Set<string>(SYNC_KEYS.filter(key => !key.startsWith("Key") && !key.startsWith("Digit")));

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
  const { account, connection, error, host, metrics, onEnd, onLogout, phase, session, stream, displays } = props;
  const [fit, setFit] = useState<FitMode>("fit");
  const [zoom, setZoom] = useState(1);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [stickyModifiers, setStickyModifiers] = useState<Set<Modifier>>(new Set());
  const [fullscreen, setFullscreen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  const [sessionControlsOpen, setSessionControlsOpen] = useState(false);
  const [desktopKeyboard, setDesktopKeyboard] = useState(() => window.matchMedia("(hover: hover) and (pointer: fine)").matches);
  const shellRef = useRef<HTMLElement>(null);
  const dockHoveredRef = useRef(false);
  const headerHoveredRef = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const keyboardEpochRef = useRef(0);
  const compositionEpochRef = useRef<number | null>(null);
  const cancelledCompositionRef = useRef(false);
  const keyboardVisibilityRef = useRef(false);
  const inputValueRef = useRef("");
  const forwardedKeysRef = useRef(new Set<string>());
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
    if (keyboardVisibilityRef.current === keyboardOpen) return;
    keyboardVisibilityRef.current = keyboardOpen;
    if (keyboardOpen) keyboardRef.current?.focus();
    else if (desktopKeyboard && authorized && remoteKeyboardTarget(document.activeElement)) keyboardRef.current?.focus({ preventScroll: true });
  }, [keyboardOpen, desktopKeyboard, authorized]);

  useEffect(() => {
    const media = window.matchMedia("(hover: hover) and (pointer: fine)");
    const change = () => setDesktopKeyboard(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  useEffect(() => {
    if (!authorized) {
      resetKeyboardBuffer();
      forwardedKeysRef.current.clear();
    } else if (desktopKeyboard && remoteKeyboardTarget(document.activeElement)) {
      keyboardRef.current?.focus({ preventScroll: true });
    }
  }, [authorized, desktopKeyboard]);

  useEffect(() => {
    const focus = () => {
      if (desktopKeyboard && authorized && connection.canControl() && document.visibilityState === "visible" &&
          remoteKeyboardTarget(document.activeElement)) keyboardRef.current?.focus({ preventScroll: true });
    };
    const key = (event: globalThis.KeyboardEvent, down: boolean) => {
      if (event.target === keyboardRef.current || !remoteKeyboardTarget(event.target) ||
          event.composedPath().some(localControl) || !authorized ||
          !connection.canControl() || document.visibilityState !== "visible" || !document.hasFocus()) return;
      keyboardRef.current?.focus({ preventScroll: true });
      if (down && !event.isComposing && event.keyCode !== 229 && event.key !== "Dead" &&
          Array.from(event.key).length === 1 && !stickyModifiers.has("shift") &&
          currentModifiers(event).every(modifier => modifier === "shift")) {
        event.preventDefault();
        synchronizeKeyboard(); resetKeyboardBuffer();
        connection.sendReliable({ type: "text", text: event.key });
      } else keyboardEvent(event, down, true);
    };
    const down = (event: globalThis.KeyboardEvent) => key(event, true);
    const up = (event: globalThis.KeyboardEvent) => key(event, false);
    window.addEventListener("focus", focus);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [authorized, connection, desktopKeyboard, stickyModifiers]);

  useEffect(() => {
    const release = () => {
      connection.releaseAll();
      resetKeyboardBuffer();
      forwardedKeysRef.current.clear();
      setStickyModifiers(new Set());
      mouseButtonRef.current = null;
      touchDraggingRef.current = false;
    };
    const visibility = () => {
      if (document.visibilityState !== "visible") release();
    };
    const fullscreenChange = () => setFullscreen(document.fullscreenElement === shellRef.current);
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

  function localControl(target: EventTarget | null): boolean {
    return target instanceof Element && target !== keyboardRef.current && Boolean(
      target.closest("button,select,input,textarea,a,[contenteditable]:not([contenteditable=false])"),
    );
  }

  function remoteKeyboardTarget(target: EventTarget | null): boolean {
    return target === keyboardRef.current || target === document.body || target === document.documentElement ||
      target === stageRef.current || target === shellRef.current;
  }

  function keyboardAllowed(): boolean {
    return authorized && connection.canControl() && document.visibilityState === "visible" && document.hasFocus();
  }

  function focusKeyboard() {
    if (desktopKeyboard && authorized && connection.canControl()) keyboardRef.current?.focus({ preventScroll: true });
  }

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
    if (down) {
      synchronizeKeyboard();
      resetKeyboardBuffer();
    }
    connection.sendReliable({ type: "button", x: point.x, y: point.y, button, down });
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as Element).closest("button,select,label,input,textarea,a")) return;
    if (session.scope === "view") connection.userActivity();
    if (!authorized) return;
    if (desktopKeyboard && event.pointerType !== "touch") { event.preventDefault(); focusKeyboard(); }
    else event.currentTarget.focus({ preventScroll: true });
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
      dx: clamp(event.deltaX, -100, 100),
      dy: clamp(event.deltaY, -100, 100),
    });
  }

  function currentModifiers(event?: Pick<globalThis.KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): Modifier[] {
    const modifiers = new Set(stickyModifiers);
    if (event?.metaKey) modifiers.add("meta");
    if (event?.ctrlKey) modifiers.add("ctrl");
    if (event?.altKey) modifiers.add("alt");
    if (event?.shiftKey) modifiers.add("shift");
    return Array.from(modifiers);
  }

  function keyboardEvent(event: globalThis.KeyboardEvent, down: boolean, forceKey = false) {
    if (!keyboardAllowed()) { resetKeyboardBuffer(); return; }
    if (composingRef.current || event.isComposing || event.keyCode === 229 || PHYSICAL_MODIFIER_CODES.has(event.code)) return;
    const modifiers = currentModifiers(event);
    const hasCommandModifier = modifiers.some((modifier) => modifier !== "shift");
    if (down && !hasCommandModifier && !stickyModifiers.has("shift") &&
        (Array.from(event.key).length === 1 || ["Enter", "Backspace", "Delete"].includes(event.key))) {
      beginKeyboardEdit();
    }
    const key = SPECIAL_KEYS.has(event.key) ? event.key : event.code;
    if (!WIRE_KEYS.has(key)) return;
    if (!down) {
      if (!forwardedKeysRef.current.delete(key)) return;
      event.preventDefault();
      connection.sendReliable({ type: "key", key, down: false, modifiers });
      return;
    }
    if (!forceKey && !hasCommandModifier && !stickyModifiers.has("shift")) {
      if (event.key === "Enter") return;
      if ((event.key === "Backspace" || event.key === "Delete") && (keyboardRef.current?.value.length ?? 0) > 0) return;
    }
    if (!SPECIAL_KEYS.has(event.key) && !hasCommandModifier && !stickyModifiers.has("shift")) return;
    event.preventDefault();
    synchronizeKeyboard();
    resetKeyboardBuffer();
    forwardedKeysRef.current.add(key);
    connection.sendReliable({ type: "key", key, down: true, modifiers });
  }

  function textInput(event: FormEvent<HTMLTextAreaElement>) {
    const nativeEvent = event.nativeEvent as InputEvent;
    if (!keyboardAllowed()) { resetKeyboardBuffer(); return; }
    if (cancelledCompositionRef.current) { resetKeyboardBuffer(); return; }
    if (nativeEvent.isComposing || composingRef.current) return;
    synchronizeKeyboard(event.currentTarget.value);
  }

  function compositionEnd(event: CompositionEvent<HTMLTextAreaElement>) {
    if (!keyboardAllowed() || compositionEpochRef.current !== keyboardEpochRef.current) {
      cancelledCompositionRef.current = true;
      resetKeyboardBuffer(); return;
    }
    composingRef.current = false;
    compositionEpochRef.current = null;
    synchronizeKeyboard(event.currentTarget.value);
  }

  function synchronizeKeyboard(value = keyboardRef.current?.value ?? "") {
    if (!keyboardAllowed() || cancelledCompositionRef.current) return;
    const edit = remoteTextEdit(inputValueRef.current, value);
    for (let index = 0; index < edit.backspaces; index += 1) {
      connection.sendReliable({ type: "key", key: "Backspace", down: true, modifiers: [] });
      connection.sendReliable({ type: "key", key: "Backspace", down: false, modifiers: [] });
    }
    for (const text of wireTextChunks(edit.insertion)) {
      if (text === "\n") {
        connection.sendReliable({ type: "key", key: "Enter", down: true, modifiers: [] });
        connection.sendReliable({ type: "key", key: "Enter", down: false, modifiers: [] });
      } else connection.sendReliable({ type: "text", text });
    }
    const retained = keyboardOpen ? edit.value : keyboardBufferTail(edit.value);
    inputValueRef.current = retained;
    if (retained !== edit.value && keyboardRef.current) keyboardRef.current.value = retained;
  }

  function resetKeyboardBuffer() {
    if (composingRef.current || compositionEpochRef.current !== null) cancelledCompositionRef.current = true;
    keyboardEpochRef.current++;
    compositionEpochRef.current = null;
    inputValueRef.current = "";
    composingRef.current = false;
    if (keyboardRef.current) keyboardRef.current.value = "";
  }

  function beginKeyboardEdit() {
    // A cancelled IME can stage old DOM text before its trailing input event arrives.
    if (cancelledCompositionRef.current) resetKeyboardBuffer();
    cancelledCompositionRef.current = false;
  }

  function leaveKeyboard() {
    synchronizeKeyboard();
    resetKeyboardBuffer();
    forwardedKeysRef.current.clear();
    connection.releaseAll();
  }

  function toggleModifier(modifier: Modifier) {
    if (!authorized) return;
    setStickyModifiers((current) => {
      const next = new Set(current);
      const down = !next.has(modifier);
      if (down) next.add(modifier);
      else next.delete(modifier);
      return next;
    });
    focusKeyboard();
  }

  function tapKey(key: string) {
    if (!authorized) return;
    synchronizeKeyboard();
    resetKeyboardBuffer();
    connection.sendReliable({ type: "key", key, down: true, modifiers: modifierList });
    connection.sendReliable({ type: "key", key, down: false, modifiers: modifierList });
    focusKeyboard();
  }

  function releaseAll() {
    connection.releaseAll();
    resetKeyboardBuffer();
    forwardedKeysRef.current.clear();
    setStickyModifiers(new Set());
    focusKeyboard();
  }

  async function toggleFullscreen() {
    if (!shellRef.current) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await shellRef.current.requestFullscreen();
    focusKeyboard();
  }

  return (
    <main className="remote-shell" ref={shellRef} data-testid="remote-console">
      <div className={`session-chrome ${sessionControlsOpen ? "is-open" : ""}`}
        onPointerEnter={event => { if (event.buttons === 0) { headerHoveredRef.current = true; setSessionControlsOpen(true); } }}
        onPointerLeave={event => {
          headerHoveredRef.current = false;
          if (!event.currentTarget.contains(document.activeElement)) setSessionControlsOpen(false);
        }}
        onFocusCapture={() => setSessionControlsOpen(true)}
        onBlurCapture={event => {
          if (!headerHoveredRef.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) setSessionControlsOpen(false);
        }}>
      <button className="chrome-handle top-handle" title={sessionControlsOpen ? "Hide session controls" : "Show session controls"}
        aria-label={sessionControlsOpen ? "Hide session controls" : "Show session controls"}
        aria-expanded={sessionControlsOpen} onClick={() => { setSessionControlsOpen(open => !open); focusKeyboard(); }}>
        {sessionControlsOpen ? <ChevronUp /> : <ChevronDown />}
      </button>
      <header className="remote-header" inert={!sessionControlsOpen}>
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
        <div className="stage-controls">
            {connection.supportsDisplays && (
              <label className="display-picker" title="Display">
                <Monitor />
                <select aria-label="Display" value={displays.selectedDisplayId ?? ""} disabled={displays.busy || phase !== "connected"}
                  onChange={event => connection.selectDisplay(event.target.value)}>
                  {displays.displays.length === 0 && <option value="">Display</option>}
                  {displays.displays.map(display => <option key={display.id} value={display.id}>{display.name}</option>)}
                </select>
              </label>
            )}
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
      </header>
      </div>

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
          onKeyDown={() => { if (session.scope === "view") connection.userActivity(); }}
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
          {displays.busy && <span className="display-status" role="status">Switching display</span>}
        </div>

      </section>

      <div className={`details-edge-zone ${detailsOpen ? "is-open" : ""}`}>
        <button className="icon-button chrome-handle details-handle"
          title={detailsOpen ? "Hide connection details" : "Show connection details"}
          aria-label={detailsOpen ? "Hide connection details" : "Show connection details"}
          aria-expanded={detailsOpen} aria-controls="connection-details"
          onClick={() => { setDetailsOpen(open => !open); focusKeyboard(); }}>
          {detailsOpen ? <PanelRightClose /> : <PanelRightOpen />}
        </button>
      </div>
      {detailsOpen && (
        <aside id="connection-details" className="metrics-panel" aria-label="Connection metrics">
          <Metric label="RTT" value={formatMetric(metrics.roundTripMs, " ms")} />
          <Metric label="Video" value={metrics.resolution ?? "--"} />
          <Metric label="FPS" value={formatMetric(metrics.framesPerSecond)} />
          <Metric label="Rate" value={formatMetric(metrics.bitrateKbps, " kbps")} />
          <Metric label="Loss" value={formatMetric(metrics.packetsLost)} />
          <Metric label="Data RX" value={String(metrics.dataMessagesReceived)} testId="data-rx" />
        </aside>
      )}

      {session.scope === "control" && (
        <div className={`dock-layer ${dockOpen || keyboardOpen ? "is-open" : ""}`}
          onPointerEnter={event => { if (event.buttons === 0) { dockHoveredRef.current = true; setDockOpen(true); } }}
          onPointerLeave={event => {
            dockHoveredRef.current = false;
            if (!keyboardOpen && (!event.currentTarget.contains(document.activeElement) || document.activeElement === keyboardRef.current)) setDockOpen(false);
          }}
          onFocusCapture={event => { if ((event.target as Element) !== keyboardRef.current || keyboardOpen) setDockOpen(true); }}
          onBlurCapture={event => {
            if (!dockHoveredRef.current && !keyboardOpen && (!event.currentTarget.contains(event.relatedTarget as Node | null) || event.relatedTarget === keyboardRef.current)) setDockOpen(false);
          }}>
        <button className="chrome-handle bottom-handle" title={dockOpen || keyboardOpen ? "Hide keyboard controls" : "Show keyboard controls"}
          aria-label={dockOpen || keyboardOpen ? "Hide keyboard controls" : "Show keyboard controls"}
          aria-expanded={dockOpen || keyboardOpen}
          onClick={() => {
            if (dockOpen || keyboardOpen) { leaveKeyboard(); setKeyboardOpen(false); focusKeyboard(); setDockOpen(false); }
            else setDockOpen(true);
          }}>
          {dockOpen || keyboardOpen ? <ChevronDown /> : <ChevronUp />}
        </button>
        <footer className="control-dock" inert={!dockOpen && !keyboardOpen}>
          <div className="control-state">
            <MousePointer2 />
            <span>{authorized ? "Input active" : "Input locked"}</span>
          </div>
          <div className="key-group">
            {MODIFIER_KEYS.map(({ modifier, label }) => (
              <button
                key={modifier}
                className={`key-button ${stickyModifiers.has(modifier) ? "active" : ""}`}
                title={label}
                aria-label={label}
                aria-pressed={stickyModifiers.has(modifier)}
                disabled={!authorized}
                onClick={() => toggleModifier(modifier)}
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
            <button className={`icon-button ${keyboardOpen ? "active" : ""}`} title="Keyboard" aria-label="Keyboard" disabled={!authorized} onClick={() => { if (keyboardOpen) leaveKeyboard(); setKeyboardOpen((open) => !open); focusKeyboard(); }}><Keyboard /></button>
          </div>
        </footer>
            <label className={keyboardOpen ? "text-entry" : "keyboard-capture"}>
              <textarea
                ref={keyboardRef}
                rows={1}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Remote text input"
                disabled={!authorized}
                tabIndex={keyboardOpen ? 0 : -1}
                onCompositionStart={() => {
                  if (keyboardAllowed()) {
                    beginKeyboardEdit();
                    composingRef.current = true;
                    compositionEpochRef.current = keyboardEpochRef.current;
                  } else resetKeyboardBuffer();
                }}
                onCompositionEnd={compositionEnd}
                onPaste={() => { if (keyboardAllowed()) beginKeyboardEdit(); }}
                onDrop={() => { if (keyboardAllowed()) beginKeyboardEdit(); }}
                onInput={textInput}
                onBlur={leaveKeyboard}
                onKeyDown={(event) => keyboardEvent(event.nativeEvent, true)}
                onKeyUp={(event) => keyboardEvent(event.nativeEvent, false)}
              />
              {keyboardOpen && <Send />}
            </label>
        </div>
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
