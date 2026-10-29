# Sync Web Control

Browser controller for owned macOS/Windows desktop hosts. Authentication remains
the API's HttpOnly session and CSRF boundary; no native credential substitution.
This React/Vite package is independently installable; browser source, assets and
Playwright tests live under `web/`.

## Controls

- Owned online desktop selection, six-digit mode PIN, view/control scopes and
  permission/error states.
- Real WebRTC offerer with recvonly video, reliable ordered `sync-control` and
  unordered zero-retransmit `sync-motion` channels.
- Sequence envelopes, 500 ms heartbeat, release-all lifecycle, keyboard modifiers,
  IME-confirmed text, pointer, drag, wheel, two-finger right-click/scroll and pinch.
- Metrics, fit/fill, fullscreen, display selection, logout and explicit termination.
- Generation-bound fresh-peer recovery after transport or background lease loss;
  old reliable input is never replayed.

## Verification

```sh
npm run typecheck
npm run build
npm run test:browser
SYNC_TEST_TURN_URL='turn:127.0.0.1:3478?transport=udp' npm run test:turn
```

The TURN command uses an already-running listener and generates short-lived test
credentials from the API's local test configuration. Select its actual bind
address with `SYNC_TEST_TURN_URL`; the fixture never starts or restarts infra.
Direct/relay browser peers are synthetic video sources, not native OS/hardware or
WAN evidence. Test screenshots persist under ignored `artifacts/v2-*.png`.

## Compatibility And Safety

- Read `/api/config` successfully before choosing request fields. Explicit legacy
  config omits v2 metadata/endpoints; auth, network and validation errors never
  trigger downgrade. A current browser declares protocol 2 even with a v1 host.
- Shared DTOs, allowed key domains, bounds, schema hash and proof fixtures come
  from `src/generated/sync-wire.ts` / `tests/fixtures/sync-golden.json`. Run the
  canonical generator in the parent repo, not hand edits to either output.
- Display selection requires effective protocol 2 plus both negotiated display
  capabilities. Requests correlate UUIDs; input remains blocked through selection
  and a single 10-second authoritative query, then closes after 5 more seconds.
  New-epoch reliable heartbeat precedes input; the mode authorization epoch is
  never replaced. Duplicate or stale replies cannot restore an older epoch.
- Wire scroll `dx > 0` means right and `dy > 0` means down, matching DOM wheel.
  Two-finger gestures use negative finger movement. Both axes stay in -100...100.
- PINs, activity tokens and recovery authority exist only in memory. Modern
  recovery consumes the previous session/token once and never retries a PIN.
  Recovery preserves both inactivity and absolute session deadlines.
- Server clock offset governs local deadline guards, including hidden-tab/focus
  return when terminal signaling is lost. Late activity never revives access.
  Heartbeats, metrics, focus, visibility and view-only hover are not activity;
  actual remote input or an explicit video-surface interaction is activity.
- JSON signaling ping every 5 seconds requires a valid pong within 15 seconds.
  Monotonic time and forward wall-clock movement detect stale authority even if
  RTP, ICE and protocol-level WebSocket pong frames remain healthy. Input and
  startup paths check lifetime directly, not only from timer callbacks.
- Hidden pages close the affected peer immediately and defer fresh-server recovery
  until visible, without consuming recovery authority or creating hidden rows.
  In-flight responses received while hidden are deleted, never installed. Visible
  unfocused windows may keep rendering but release held input. Local absolute and
  idle deadlines cannot be extended by clock rollback or recovery.
- Explicit legacy servers get local-only 15-minute idle protection. This is not
  represented as server enforcement. Logout, revoke, idle or mode terminal state
  clears automatic recovery before any asynchronous cleanup.

The test server uses fake, isolated account cookies and public vectors only. It
does not log into real accounts, deploy services or accept OS capture prompts.

The separate `npm run test:real-api` lane checks readiness, unauthenticated
boundaries and configured provider navigation without entering credentials.
Authenticated epoch checks run only when real session cookies are explicitly
supplied. That lane was not run for this change; no real user login was performed.

Backend auth and contracts remain parent-package owned. Native OS capture/input,
signing, installation and lifecycle belong to the native clients. This browser
package does not bypass auth or provide a production fallback. NAS deployment,
DNS/public auth registration, native hardware, external TURN/WAN and publishing
remain outside these local browser checks.
