# Sync Web Control

React/Vite browser controller for the Sync API. This package is independently installable and all browser-only source, assets, and Playwright tests live under `web/`.

## Implemented

- Same-origin teddy OIDC BFF login with HttpOnly session cookies and double-submit CSRF mutations.
- Owned online macOS host selection, six-digit mode PIN, view/control scopes, permission and error states.
- Real browser WebRTC offerer with a `recvonly` video transceiver.
- Reliable ordered `sync-control` and unordered zero-retransmit `sync-motion` data channels.
- UUID epoch and sequence envelopes, 500 ms heartbeat, release-all lifecycle, keyboard modifiers, IME-confirmed text, pointer, drag, wheel, two-finger right-click/scroll, and local pinch zoom.
- Connection metrics, fit/fill, fullscreen, logout, and explicit session termination.
- Generation-bound recovery using a fresh API session, signaling ticket, peer connection, and data channels after transport failure or an expired background heartbeat lease.

The active six-digit PIN is retained only in an in-memory ref while recovery is allowed. It is cleared on logout, manual end, server revocation, mode/code changes, authentication failure, terminal reconnect failure, and component teardown. It is never written to browser storage or logs.

## Verification

Package scripts:

- `npm run typecheck`
- `npm run build`
- `npm run test:browser`
- `npm run test:turn`
- `npm run test:real-api`

The standard browser suite uses an isolated API/signaling peer fixture and real Chromium WebRTC. It covers authorization gating, video/control roundtrip, touch and keyboard input, network recovery, fresh-peer sequence reset, old reliable-message non-replay, foreground lease renewal, mode revocation, and non-retry of a reconnect rejected with 403.

The TURN lane derives short-lived credentials in the test process from the local service environment, forces `iceTransportPolicy: "relay"` on both peers, and verifies selected relay candidates plus video/input roundtrip. Secret values are not persisted or logged.

The real-API lane verifies local API readiness, unauthenticated boundaries, and configured provider navigation without entering account credentials. Authenticated epoch checks run only when real session cookies are explicitly supplied. Preserved guest screenshots are ignored by Git under `artifacts/`.

## Handoff Boundaries

- Backend API and shared contracts remain owned by the parent `sync-api-nest` package.
- Native capture, input injection, app lifecycle, signing, and device installation remain owned by `sync-app-swift`.
- This package does not perform authentication bypasses or production fallbacks.
- Remote deployment, NAS/SSH operations, DNS, public auth registration, external TURN/WAN verification, phone installation, and publishing are outside this implementation and have not been performed or verified here.
