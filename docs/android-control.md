# Android Remote Control1

Android control is an optional extension of base protocol2, not a ninth capability.
`GET /api/config` advertises optional `features.androidControl: true`. A client must
use a fresh config and omit the new request fields when this flag is absent/false;
an old server is view-only for Android and must not be retried with PIN control.
The existing exact `X-Sync-Extensions: access-code` response projection is unchanged.

## Declarations

- Only signed device-ticket and connect requests accept optional
  `androidControlProtocolVersion: 1`. Registration and capability-update requests
  reject it. Null, strings and other versions are invalid.
- An Android host ticket advertises version1 only with `input-host`. The host
  advertises only while accessibility is connected and local Remote input is ON.
  A controller declares version1 on connect; it need not have `input-host` itself.
- `WireDevice` reports the Android version only from its live input-capable endpoint,
  never persistent device metadata. The immutable `WireRemoteSession` reports it
  only on a newly authorized Android control session, never view/desktop/CLI/code.
- `WireMode.allowControl` defaults false, including old Redis mode objects without
  the property. Set-mode accepts optional `allowControl`; true is Android-only.
  `allowBrowser` remains desktop-only. Android mode and first ticket can precede
  capture or a live host socket; connect requires the live original endpoint.

## Authorization

Control requires native-issued auth transport, same owner, nonself controller key
proof, a live directional **control** grant, current mode epoch + allowControl,
base2 + AndroidControl1 on both peers, and the live original `input-host` endpoint.
No browser/PIN fallback is allowed, including when `code` is merely present. Missing
protocol support returns426 `android-control-update-required`. iOS stays view-only.
CLI/chat fields are stripped from Android screen-control snapshots; Android cannot
host CLI or access-code sessions.

Grant approval accepts optional `scope: view|control`. Android omitted scope means
view; only explicit control upgrades it. iOS control is rejected. Desktop omitted
scope remains control. Both approval responses and grant lists expose scope.
Changing/reinstating a grant ends existing pair sessions in the same grant-locking
transaction and emits session-ended after commit. No existing view grant is
automatically upgraded. Mode reissue/off ends inbound host sessions without ending
that device's independent outbound viewers.

Creation, controller installation and host binding hold auth/device/grant/session
locks and recheck current mode/endpoint authority. Snapshot version, grant, scope,
capabilities and original endpoint cannot be upgraded or rebound. Signaling also
checks mode/endpoint before and after installation, on traffic and maintenance.

## Peer Input

AndroidControl1 uses **externally negotiated DataChannels locally created by both
peers**, not received DCEP channel metadata. Shared generated limits reserve
`androidControlReliableChannelId=4` and `androidControlMotionChannelId=6`:

- Reliable input: negotiated=true, id4, ordered=true, maxRetransmits=-1 and
  maxPacketLifeTime=-1 (unlimited/default reliable).
- Motion input: negotiated=true, id6, ordered=false, maxRetransmits=0 and
  maxPacketLifeTime=-1 (no retransmission or lifetime policy).

Only fresh negotiated AndroidControl1/control screen sessions use these exact
local configurations. An incoming DCEP channel cannot establish control authority.
Both peers must create the known channels; received-channel reliability getters
are not required or trusted. Existing desktop/view/CLI/code channels are unchanged.
This is the pre-release extensionv1 contract; base2/eight capabilities stay fixed.

`WireInput` adds `AndroidBack`, `AndroidHome`, `AndroidRecents` to its key allowlist.
Clients may emit/dispatch them only for negotiated AndroidControl1/control snapshots;
never map them into desktop key events. All actual input is encrypted peer data,
not HTTP/WSS/log/DB data. Native Android additionally requires a current full-display
capture matching physical coordinates, accessibility, local opt-in, fresh input
epoch/sequence/lease, and safe focused editable fields. Server declarations are not
OS attestation and cannot replace these final local dispatch checks.

## Migration And Verification

Migration7 adds nullable `android_control_protocol_version` and a consistency check
only. Existing accounts/grants/session history stay unchanged with null extension.
Back up the service database before the separately authorized deployment migration;
coding/test work never migrates sync_dev or production.

After the leader grants the dedicated DB slot:

```bash
SYNC_ANDROID_CONTROL_DB_SLOT=approved npm run test:integration
npm run typecheck
npm test
npm run build
npm run lint
npm run contracts:check
npm run test:contracts
node --test scripts/test-android-control-isolated.test.mjs scripts/test-cli-chat-isolated.test.mjs
```

The full integration runner enables all four suites in serial, confines each to a
fresh UUID `sync_test` schema and Redis prefix, overrides URL search_path, and
cleans only its own resources. The old public-schema truncation path has been
removed. Neither public/dev data nor actual accounts/devices are used. Tests cover
additive migration7, scope upgrade/downgrade pair termination, real grant-lock
revocation races across create/install/bind, mode/endpoint changes under lock,
legacy view snapshots, missing declarations, expiry and independent outbound view.

Native compiler slots are coordinated separately. While held by another lane,
`SYNC_CONTRACT_SKIP_NATIVE_COMPILERS=1 npm run test:contracts` runs JS/TS/generator
checks only and explicitly skips the three native compiler tests. A skipped suite
does not count as native validation.
