# Native CLI Session Control

CLI1 is an optional extension to protocol2. The schema is `contracts/sync-contract.json`; generated consumers must be updated together. No new auth service/client, port, environment key, container or dependency is required.

## Rollout

1. Back up the dedicated Sync PostgreSQL database using the existing deployment procedure.
2. Deploy the updated API and embedded web assets. Startup applies additive migration4: existing sessions remain `screen`, CLI version is nullable, and host-wide controller uniqueness is preserved.
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
- **Queued** means provider acceptance, not model processing/completion. Claude hold/refuse and local tool approvals remain authoritative.
- Codex entries are loaded top-level **Daemon** conversations, not proof of a currently attached terminal. Saved/unloaded conversations are not resumed.

## Verification

2026-10-31: API193 cases (116 default unit tests plus77 separately enabled integration cases) passed, including isolated `sync_test` schema migration/auth/revocation/endpoint races; lint/typecheck/build passed. Default `npm test` skips the integration suite. Contract17 tests and all10 generated-output drift checks passed. Existing web49 tests/build passed. A forced-relay test passed video/input plus exact typed CLI-frame transport; that transport fixture does not authorize browser CLI or claim native/vendor end-to-end WAN verification.

Commands: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build:all`, `npm run test:contracts`, `npm run contracts:check`. Integration must use only the dedicated test database and a unique Redis prefix. No production auth/DB/real CLI messages belong in automated fixtures.
