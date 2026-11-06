# Trusted Access Code

`access-code` is an additive protocol2 capability and separate session purpose.
It lets an already trusted native controller inspect a desktop host's current web
access code through a data-only encrypted peer connection. Account login alone,
a temporary PIN, a view grant or a reverse-direction grant is not authorization.
The existing browser SPA has no lookup UI and cannot obtain this authority.

## Negotiation And Authorization

All new native HTTP requests, including initial config probes, send the fixed
header `X-Sync-Extensions: access-code`. This is a compatibility projection opt-in,
not authorization, protocol3, a feature flag or authentication-session metadata.
Only that exact value is recognized; arrays, lists, whitespace variants, other
values and values beyond128 characters remain legacy.

Without opt-in, `GET /api/config` exposes the original seven capabilities,
`GET /api/devices` removes `access-code` from each device's capabilities, and
`GET /api/sessions` omits code-purpose rows entirely. This preserves strict old
enum7/maxItems7/purpose2 decoders. Opted-in responses retain all eight
capabilities and owned code-session rows. All three GET responses set
`Cache-Control: no-store` and add `X-Sync-Extensions` to `Vary` without replacing
other variations such as `Origin`. Projection does not change stored snapshots.

```sh
curl -fsS -H 'X-Sync-Extensions: access-code' http://localhost:3053/api/config
```

Native host signaling tickets and the controller connect request must both declare
protocol2 and `access-code`. No new feature flag, metadata version field, service
key, dependency or environment secret is needed. Persisted device metadata does
not substitute for the current signaling endpoint declaration. Explicit
registration/ticket/connect declarations and proof/grant enforcement do not rely
on the projection header. Forging it from a browser cannot grant code authority.
An old server ignores the header and advertises only legacy capabilities: new
clients keep old flows working and reject unsupported code lookup without fallback.

Use the existing `POST /api/devices/:hostId/connect` with `purpose:"access-code"`,
`scope:"control"`, protocol/capabilities and the controller's fresh one-use device
proof. The native authentication session, controller and Mac/Windows host must
belong to the same owner. Host and controller must differ, and the host must have
issued a live permanent control grant to that controller. Do not send `code`:
even a correct PIN is rejected and never consumed for this purpose. The current
host mode must allow web/temporary access; its epoch and endpoint remain pinned.

Missing live capability/base2 returns HTTP426:

```json
{"statusCode":426,"error":"access-code-update-required","message":"Update both apps to support access code lookup"}
```

Never fall back to PIN/screen/CLI or reissue the mode in response. Authorization
failures are HTTP403. A live duplicate host/controller lookup conflicts with409.
The session snapshot contains only `access-code` and optionally negotiated
`bounded-lifetime`; CLI/chat metadata is stripped even if supplied by both peers.
Ordinary screen/CLI snapshots never negotiate `access-code`.

Creation, controller installation and host binding hold existing auth/device/grant
locks and recheck the current mode/endpoint from inside the transaction. Code-only
installation/binding refuses a missing live-authority callback. After persistence
and before signaling publication, mode and endpoint are checked again. Revocation,
epoch/browser-policy changes, endpoint replacement, expiry and signaling loss
fail closed. A replacement host endpoint ends code authority rather than adopting
it. Browser idle/recovery authority cannot create a code-only session.

## Peer Contract

Canonical schema: `contracts/sync-contract.json`. All10 generated outputs share
SHA-256 `2951454e5a7a6babf4b6f82d3c4a35073430e66600db1b3981f097484ddfbc09`.
`WireAccessCodeFrame` is a strict object on the encrypted WebRTC DTLS/SCTP
`sync-control` channel, not an HTTP or signaling message:

- Common required fields: `type:"access-code"`, `version:1`, `op`, UUID strings
  `sessionId`, `epoch`, `requestId`.
- `op:"request"`: only the six common fields.
- `op:"result"`: additionally `code` (exactly six ASCII digits) and ISO date-time
  string `expiresAt`.
- `op:"error"`: additionally `reason:"unavailable"|"not-authorized"|"invalid-request"`.

Unknown, cross-variant and null fields are invalid. Generated constructors default
type/version for convenience, but received JSON requires both. Enforce serialized
UTF-8 frame size at2048 bytes (including whitespace), one pending request, and a
non-extending10-second timeout. The host accepts requests only; the controller
accepts only the matching result/error for its session/epoch/requestId. Reject
stale, duplicate, unsolicited or wrong-direction frames. Structural validation
does not enforce these runtime properties.

Hosts must inspect current local code, expiry, mode epoch, allowBrowser, trust and
signaling liveness immediately before publishing. Controllers retain codes only
in memory, use explicit Copy, and discard them on close/background/logout/origin
change/mode change/revocation/signaling loss. Do not retry/reissue automatically.

There are no screen/audio transceivers, capture, input, display selection or CLI
operations in this session. The server denies display signals and audio/video
SDP for code-only sessions. It never forwards access-code frames through WSS,
adds a retrieval HTTP endpoint or stores/logs plaintext codes or request bodies.
The pre-existing host mode/PIN issuance API is unchanged; stored mode secrets
remain existing PIN hashes only.

## Migration And Verification

Migration6 is additive and preserves all v5 rows. It extends the purpose check and
adds code-only metadata consistency. The ordinary host-exclusive partial unique
index remains for non-code sessions; a separate partial index permits one live
code lookup per host/controller pair. This permits screen/CLI and different
trusted code controllers to coexist. Closing one lookup ends only that session.

Migration6 was applied only in fresh, UUID-named schemas in the dedicated
loopback `sync_test` DB. Production/dev migrations, deployment and real-service
restarts were not performed. At user-owned deployment, back up the dedicated DB
before the normal migration/start process; never truncate/reset it. Client
updates can be staged because old screen/CLI/chat semantics remain unchanged and
unsupported lookup clients fail explicitly without fallback.

```sh
npm run contracts:check
npm run test:contracts
npm run typecheck
npm test
# Approved isolated integration slot, using only existing loopback env shape:
SYNC_CLI_CHAT_DB_SLOT=approved node --env-file-if-exists=.env scripts/test-access-code-isolated.mjs
```

The isolated runner reuses the existing loopback/sync_test safety gate, overrides
all schema search paths, uses UUID Redis prefixes, runs the new access-code suite
and prior CLI/chat integration suite, and drops only its fresh schemas/keys.
It never runs the legacy public-truncate integration suite. Real-lock regressions
prove revocation during create/install/bind, expiry after row-lock waits and live
allowBrowser changes inside all three authority steps, not merely pure guards.

Native platform owners must verify peer transport, UI disposal and host code
publication. Physical-device/OS permission checks and the Windows native bridge
remain separate manual gates; backend/compiler tests do not certify those paths.
