# Native CLI Session Control

CLI1 is an optional extension to protocol2. The schema is `contracts/sync-contract.json`; generated consumers must be updated together. No new auth service/client, port, environment key, container or dependency is required.

## Rollout

1. Back up the dedicated Sync PostgreSQL database using the existing deployment procedure.
2. Deploy the updated API, embedded web assets and exact public signed profile baseline. Startup applies additive migrations4/5: existing sessions remain `screen`, CLI/chat versions are nullable, and host-wide controller uniqueness is preserved. Migration5 adds only `cli_chat_protocol_version` and its consistency constraint; existing row contents and credentials are not rewritten.
3. Update the Mac app and iPhone/Android controller. Reconnect host mode so the current device ticket/socket declares CLI1. Previously created screen sessions are not upgraded in place.
4. Use the same account, register both devices, approve a permanent **control** grant from the Mac, and enable Mac **Turn On**. Open **CLI** from the mobile Mac device entry, or from an already negotiated screen/control connection.

Production deployment, database migration and real-account tests were not run by this implementation task. Existing secrets, auth onboarding and TURN settings are unchanged.

## Authority

- `GET /api/config` adds optional `features.cliSessions`; missing means false.
- Current native device tickets/connect requests can declare `cliProtocolVersion: 1`. Connect can request `purpose: "cli"`; omitted purpose remains `screen`.
- Both live endpoints must support base2/CLI1. CLI requires native-issued authentication, registered controller proof, same owner, active control grant, Mac host, current host mode/epoch and control scope.
- Browser/PIN/view-only/untrusted/cross-owner access cannot obtain CLI, regardless of declared platform/version. Unsupported authorized CLI requests return426 `cli-update-required`, never screen fallback.
- Session feature snapshots are immutable. A replaced socket cannot upgrade an existing session. Revocation/liveness/expiry fences further dispatch, but cannot retract provider-accepted work.

CLI-only creates no video/capture/display/input lease. Opening CLI on the controller's actual negotiated screen peer reuses that peer/session. Closing its panel preserves the screen; explicit CLI-only Disconnect ends that connection.

## Data And Delivery

CLI frames use ordered `sync-control`, not HTTP/signaling or keyboard input. The server stores session purpose/version and ordinary audit metadata, not CLI titles, projects, messages, transcripts or provider credentials.

- Message limit16KiB UTF8; serialized frame32KiB; list pages50; pending requests4; channel buffer64KiB.
- Host sequence reservation and bounded in-memory receipts prevent replay within the current admission. Missing/uncertain acknowledgement remains **unknown**, never automatic resend or exactly-once persistence.
- **Queued** displays **Sent / Provider accepted** and is terminal acceptance, not model processing/completion. `received` is still pending; rejected/unknown retain their existing meanings and never auto-retry. Claude hold/refuse and local tool approvals remain authoritative.
- Codex entries are loaded top-level **Daemon** conversations, not proof of a currently attached terminal. Saved/unloaded conversations are not resumed.

## CLI Chat1 And Profiles

`GET /api/config` adds optional `features.cliChat:true`. Only native signaling
ticket/connect DTOs accept optional `cliChatProtocolVersion:1`; registration,
capability updates and browser recovery reject it as an unknown field. Clients
omit it on an old API unless base2 and both `cliSessions`/`cliChat` are advertised.
Both actual endpoints must declare CLI1 and Chat1; no stored device metadata can
manufacture live support. Missing support returns426 `cli-chat-update-required`
for an explicit chat request, without falling back to a screen session.

Chat requires native-issued authentication, current controller proof, same-owner
Mac host, permanent control grant, distinct registered controller, control scope,
current endpoint/Turn On epoch and lifetime. A chat request with any PIN field is
rejected. Screen/control connections may negotiate chat, but previously established
screen or CLI1 snapshots are never upgraded in place. Repository installation and
host binding compare nullable chat snapshots and mode epochs exactly and recheck
auth/device/grant locks. Host replacement, stale support, expiry and revocation
remain fail-closed. No message/history tables, journal, HTTP history or WSS chat
route are introduced. Logs/audits contain ordinary numeric/identity metadata only.

`WireCliChatFrame` is a separate strict `type:cli-chat,version:1` family on ordered
encrypted `sync-control`. Initial/older pages are20 logical visible messages,
chronological, with independent opaque older/tail cursors. Results include stable
snapshot IDs, explicit reset/progress and bounded oversized/malformed warnings;
warnings preserve traversal without inventing an assistant row. Text is segmented
at8KiB, not silently truncated. Tail polling runs no faster than1 second and only
while visible; unsubscribe cancels pending reads without ending a shared screen.
Limits/strict field enums live in the [generated contract](../contracts/README.md).

Public artifacts are exactly `/api/cli-profiles/v1/manifest.json`, `manifest.sig`,
`claude-native-v1.json`, `codex-native-v1.json`, sourced from
`assets/cli-profiles/v1/` and copied by the Dockerfile. GET/HEAD provide exact bytes,
SHA256 ETags,304 and a five-minute revalidation cache; no authentication/cookies,
arbitrary path, redirects, decompression or signing are used. JSON files are
bounded at65536 bytes each and the raw Ed25519 signature is exactly64 bytes.
Missing/incomplete/oversized/symlinked bundles return sanitized503; unknown paths
return404. API does not parse/activate profiles or verify release policy. Native
clients pin the public root and verify exact-byte Ed25519 signature, SHA256/size,
schema, sequence, expiry, security floor and revocations before parse/activation.
The private release signer stays in a dedicated development Mac Keychain item and
must never enter API assets, environment, NAS, Git or client builds.

Installed release baseline: sequence1/securityFloor1, keyID `release-v1`,30-day
signed lifetime. Its profile data is public, not proof of arbitrary future vendor
compatibility. Native policy/operations/ceilings remain authoritative. Refresh the
signed manifest before expiry through the Mac release workflow; never recreate a
missing release key or silently lower the security floor.

## Verification

2026-10-31: API193 cases (116 default unit tests plus77 separately enabled integration cases) passed, including isolated `sync_test` schema migration/auth/revocation/endpoint races; lint/typecheck/build passed. Default `npm test` skips the integration suite. Contract17 tests and all10 generated-output drift checks passed. Existing web49 tests/build passed. A forced-relay test passed video/input plus exact typed CLI-frame transport; that transport fixture does not authorize browser CLI or claim native/vendor end-to-end WAN verification.

Commands: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build:all`, `npm run test:contracts`, `npm run contracts:check`. Integration must use only the dedicated test database and a unique Redis prefix. No production auth/DB/real CLI messages belong in automated fixtures.

2026-11-02 chat verification uses `test/cli-chat.integration.spec.ts` only, with a
fresh UUID schema/search_path and Redis prefix in local `sync_test`; setup and
teardown never truncate `public` or touch `sync_dev`. After coordinator DB-slot
approval run:

```sh
SYNC_CLI_CHAT_DB_SLOT=approved node --env-file-if-exists=.env scripts/test-cli-chat-isolated.mjs
```

The runner disables the legacy integration
flag and invokes only this isolated suite. The installed public baseline is
signature/digest-checked in catalog tests using only the pinned public key.
No production deploy/restart, private-key read, real account, transcript/model
message, physical-device or vendor/WAN acceptance is inferred from these tests.

API unit175/175 and isolated chat DB25/25 passed, as did20 contract tests including
offline TS/Swift/Kotlin/C# compilers, all10 output drift checks, lint/typecheck and
backend/web builds. The installed signed baseline passed exact-byte public-key
signature verification and profile SHA256/byte-count checks in catalog HTTP tests.
Existing Chromium browser/WebRTC/input/IME regressions passed49/49. Test-only
listeners/Chrome and local test-DB connections required sandbox escalation; no
running API, TURN, auth or production process was restarted.
