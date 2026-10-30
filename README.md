# Sync server

NestJS 11 backend and production SPA host for account-owned device trust, temporary remote-access modes, WebRTC signaling, and a confidential central-OIDC BFF. PostgreSQL stores durable devices, grants, auth sessions, remote-session history, and audit metadata. Redis is authoritative for one-use login/device challenges, PIN state and limits, signaling tickets, and device presence.

## Local setup

Requirements: Node 22+, PostgreSQL, Redis, and central auth. Create only the dedicated `sync_dev` and `sync_test` databases; this service never shares another application's schema.

```bash
cp .env.example .env
openssl rand -base64 32 # SYNC_SESSION_ENCRYPTION_KEY
openssl rand -base64 32 # SYNC_PIN_PEPPER
npm ci
npm run db:migrate
npm run start:dev
```

As an optional local shortcut, run the main-owned `node scripts/setup-local.mjs` instead of manually copying and filling `.env`. It preserves an existing file and generates strong session, PIN, and TURN secrets. It intentionally does not create or seed `SYNC_OIDC_CLIENT_SECRET`; central-auth onboarding approval is still required.

Use `postgresql://postgres:postgres@127.0.0.1:5432/sync_dev`, `redis://127.0.0.1:6379`, and `SYNC_REDIS_KEY_PREFIX=sync:dev` locally. Redis keys are namespaced and the application never calls `FLUSHDB` or `FLUSHALL`.

The developer `.env.example` allows the `127.0.0.1:3053` API alias and Vite on `localhost:5179` or `127.0.0.1:5179`; the canonical `SYNC_PUBLIC_URL` origin is always included automatically. Production must replace `SYNC_ALLOWED_ORIGINS` with only the exact deployed web origins and must not retain local development origins.

Central auth is deliberately fail-closed. Until `docs/onboarding/sync-service-onboarding-create.json` is approved and its one-time confidential client secret is configured, `/api/config` reports `authConfigured: false` and login endpoints return `503`; there is no local user, test token, admin key, or auth-disabled fallback.

The confirmed production URL is `https://sync.lafamila.xyz`, with the exact confidential-client callback `https://sync.lafamila.xyz/api/session/oidc/callback`. Production auth remains unconfigured until that onboarding update is approved and its separately issued secret is installed on the NAS.

### Two-device LAN testing

Use one stable LAN address for the controller browser, callback, and TURN. HTTP LAN testing is for a trusted development network only; production requires HTTPS/WSS.

- Set `SYNC_PUBLIC_URL=http://<LAN_IP>:3053`, add that exact origin to `SYNC_ALLOWED_ORIGINS`, and set `SYNC_OIDC_REDIRECT_URI=http://<LAN_IP>:3053/api/session/oidc/callback`.
- Approve the exact callback through an auth onboarding update. `docs/onboarding/sync-service-onboarding-lan-update.json` contains the current development address; edit it when the address changes. Approval rotates the confidential client secret: update `SYNC_OIDC_CLIENT_SECRET` with the newly issued value.
- Keep `SYNC_AUTH_ISSUER_URL` and `SYNC_AUTH_JWKS_URL` on the existing loopback auth. Set `SYNC_OIDC_AUTHORIZATION_URL=http://<LAN_IP>:3032/oauth/authorize` for the browser-facing endpoint only. Token exchange and issuer validation do not move to the LAN alias.
- Run `node --env-file=.env scripts/dev-auth-lan.mjs`. It binds only the configured private LAN address and proxies public OAuth/OIDC paths to the existing loopback auth. `/admin`, `/service`, and admin APIs remain unavailable on this listener. Manage auth through `http://localhost:3032`.
- Set `SYNC_TURN_URLS`, `SYNC_TURN_EXTERNAL_IP`, and `SYNC_TURN_BIND_ADDRESS` to the LAN address, then run `node deploy/prepare-turn.mjs` and `docker compose -p sync-turn-dev --env-file .env -f deploy/turn.compose.yml up -d --no-build --pull never` for the Sync-owned coturn instance.
- Restart the local API and open `http://<LAN_IP>:3053` on the other device. The Mac app can keep its existing loopback API address; both reach the same Sync instance. No other service's auth issuer or client is changed.

`npm run test:dev-proxy` checks the proxy route/Host restrictions with test-only HTTP servers. Leave `SYNC_OIDC_AUTHORIZATION_URL` empty in ordinary local or production setup to use the configured issuer's authorization endpoint.

## Commands

```bash
npm run typecheck
npm test
npm run test:integration # dedicated sync_test DB and sync:test:<fixture> Redis prefix
npm run test:system      # compiled API + fixture OIDC + production SPA + Chrome WebRTC/TURN
npm run build
npm run build:web
npm run build:all
npm run contracts:check # all four sibling Sync repos must be present
npm run test:contracts
```

`npm run test:system` requires an existing `dist/main.js`, `web/dist`, local Chrome, the dedicated `sync_test` database, Redis, and healthy coturn settings in the untracked `.env`. It starts the compiled production entry without DI overrides, but replaces every OIDC endpoint/client value in the child environment with a generated RS256 fixture. It uses a unique account and Redis prefix, deletes only those rows/keys, and never reads real auth accounts or writes the auth database. It also crashes an active API, verifies bounded stale-session recovery and browser reconnection, then verifies graceful SIGTERM session closure and immediate restart. Screenshots and redacted metadata are written to ignored `test/system/artifacts/`.

`npm run build:web` is the server-owned integration hook and invokes `npm --prefix web run build`. The API serves `web/dist` at `/` in production and reserves `/api/*` for same-origin REST and WebSocket traffic.

## HTTP contract

All routes use `/api`. Browser auth uses the HttpOnly `sync_session` cookie and a strict `sync_csrf` double-submit cookie on mutations. Native clients send only their opaque value in `X-Sync-Session`. Device-changing native operations additionally require a one-use P-256 proof.

- `GET /api/health`, `GET /api/config`
- `POST|GET /api/session/oidc/start`, `GET /api/session/oidc/callback`, `POST /api/session/oidc/complete`
- `GET /api/session/me`, `POST /api/session/logout`
- `POST /api/devices/challenge`, `POST|GET /api/devices`, `DELETE /api/devices/:id`
- `POST /api/devices/:id/mode`, `GET|POST|DELETE /api/devices/:id/grants[/grantId]`
- `POST /api/devices/:id/connect`
- `POST /api/devices/:id/capabilities` (same-device signed update)
- `GET|DELETE /api/sessions[/sessionId]`
- `POST /api/sessions/:id/activity`, `POST /api/sessions/:id/recover` (browser authority)
- `POST /api/signaling/tickets`, `GET /api/ice`

Native login uses provider PKCE plus the app's `challenge=base64url(SHA256(verifier))`. Successful callbacks return `sync://auth?transactionId=...&handoffCode=...`. Completion requires both the initiating app verifier and this callback-only one-use code, which expires after 60 seconds by default. Start responses never disclose the callback code. Browser cookies and native header sessions are bound to their issued platform in storage. Login initiation has per-client and global rate limits configured by `SYNC_LOGIN_RATE_PER_IP` and `SYNC_LOGIN_RATE_GLOBAL`.

The session list contains only unended, unexpired owned connections. Ended history remains in PostgreSQL, not in the active list. Repeating an owned session termination succeeds without changing its original termination reason; ownership/proof checks still apply.

Web text input keeps its textarea under the browser keyboard's control. With composition events it waits for commit; without them it mirrors grapheme-level edits using existing Backspace/text messages, supporting iOS Korean in-place replacements without clearing the IME buffer. The ephemeral buffer is cleared on focus/context changes and connection loss, never logged or persisted. Regressions cover real Chromium composition and the no-composition-event input pattern, deletion, joined emoji and wire chunk limits. The WebKit Korean event behavior is documented in https://bugs.webkit.org/show_bug.cgi?id=274700.

Device public keys are base64 P-256 SPKI DER. Signatures are base64 ASN.1 DER ECDSA-SHA256 over exactly:

```text
sync:register:<challengeId>:<nonce>
sync:device:<deviceId>:<challengeId>:<nonce>
```

Device deletion separates actor from target: any active device owned by the session account may sign the deletion request, and the target is independently checked against that same owner. This permits removing a lost device without its private key. A revoked actor and a cross-account target are rejected. Permanent grant approval remains stricter and always requires the target host's own proof.

Enabling or reissuing mode creates a new UUID epoch and six-digit PIN. PIN HMACs, account+host+epoch failures, IP failures, and lockout are updated atomically in Redis. Five account failures invalidate the mode. `allowBrowser` gates every untrusted temporary connection, not a client-supplied platform label: browsers also require allowed Origin and CSRF, while proof-bearing but unapproved controllers remain untrusted and still need the current PIN. Only macOS/Windows hosts with `allowBrowser=true` accept temporary PIN connections. A trusted native connection requires an existing host-approved grant and controller proof. PIN-based connections are always temporary: `rememberDevice` is rejected and can never create trust. A host explicitly approves a registered controller with `POST /api/devices/:hostId/grants` using the host private-key proof. iOS/Android hosts are view-only and require an existing grant. A partial PostgreSQL unique index enforces one active controller per host; one controller may connect to multiple distinct hosts. Connection creation rechecks the mode epoch after persistence; a concurrent mode change ends the row before any ticket is issued.

Protocol2 is additive: native registration/tickets declare active capabilities, while omitted native version/capabilities retain protocol1/empty defaults. Session features are immutable snapshots; changing device metadata cannot upgrade an existing connection. Browser connect/recovery must declare version2, even when the negotiated media remains1. Missing browser declarations return HTTP426 `reload-required`. Flat `/api/config` publishes mode duration bounds, web idle policy and feature flags. Canonical types, validators and fixtures live in `contracts/`; run the shared generator rather than editing generated outputs. See `../.docs/SYNC_PROTOCOL_V2.md` and `../.docs/SYNC_CI.md`.

Browser activity uses a memory-only token bound to its account, auth session and remote session. Only explicit user activity renews `SYNC_WEB_IDLE_TIMEOUT_SECONDS` (default900); focus, visibility and heartbeat do not. One-use recovery rotates authority and creates a new row without extending absolute/idle deadlines or reusing the PIN. Terminal expiry, explicit revocation and logout cannot be recovered. Native sessions are not subject to browser inactivity. Hidden browser pages close local media/input and defer recovery until visible.

Schema migrations2/3 preserve existing devices, credentials and history. Schema3 adds nullable authorization-grant, connection-deadline and connected-at fields. Creation and controller installation hold compatible auth/device/grant locks so revocation cannot pass between authorization and persistence. New reservations must attach before the ticket deadline; a one-second sweep ends abandoned reservations and releases the host. Already-connected sessions do not use the reservation deadline. Back up the dedicated service DB before applying `npm run db:migrate`; never reset it as an upgrade shortcut.

## Signaling

Connect to `ws(s)://<host>/api/signaling?ticket=<opaque-one-use-ticket>`. Tickets expire after 60 seconds by default and are atomically consumed. Browser controller tickets require an allowed Origin. Device tickets bind one registered device; replacing that device socket uses a connection identity so the stale socket's close event cannot mark the replacement offline.

Base messages are `ready`, `session-start`, `offer`, `answer`, `ice`, `session-ended`, `ping`, and `pong`. Negotiated desktop display selection adds `get-displays`, `displays`, `select-display`, and `display-error`; unsupported signals are never sent to legacy endpoints. A display change blocks input, releases held state and rotates a separate `inputEpoch` without changing the authorization epoch. Controller sessions may send offers, hosts may send answers, both may send ICE, and every route is checked against the active PostgreSQL session plus current Redis mode epoch. Mode changes, device/grant/session revocation, logout, expiry, or real socket loss end the durable session and notify peers. Server WebSocket ping/pong uses a 15-second deadline; presence is renewed only for a pong-responsive socket whose issuing auth session still validates. If a PostgreSQL, Redis, or authorization check is uncertain, signaling fails closed by sending `session-ended` to locally connected peers and closing controller and device sockets, even when the durable end write cannot complete.

Clients additionally send JSON ping every5 seconds and enforce their own15-second valid-pong deadline plus a non-extending session expiry. Healthy RTP/DataChannels cannot keep authorization alive when signaling is stalled. Active honest hosts advertise `bounded-lifetime`; production defaults require it (`SYNC_REQUIRE_BOUNDED_HOSTS`, default true in production and false in development/test). Old hosts receive426 `host-update-required`; an updated host may still serve legacy protocol1 controllers. This compatibility declaration is not attestation or permission. Disabling the production requirement removes this safety bound for old software.

Sync intentionally runs one active API instance per `SYNC_REDIS_KEY_PREFIX`. A renewable Redis lease (15 seconds by default, configured by `SYNC_INSTANCE_LEASE_TTL_SECONDS`) prevents a second live instance from claiming the same signaling namespace. Remote-session rows record namespace and instance UUID. After an ungraceful process loss, the next lease owner ends only stale rows from that namespace as `server_restarted` before accepting traffic, so reconnect is not blocked by the active-host unique index. Lease loss makes the old process fail closed and terminate; this is explicit single-instance recovery, not an HA claim.

While a controller socket is active, the backend performs a provider refresh check every `SYNC_AUTH_RECHECK_SECONDS` (20 seconds by default), even when the current access JWT has not expired. Refresh-token rotation is serialized per session both in process and with a PostgreSQL row lock. With the default five-second auth HTTP timeout and one-second signaling sweep, provider-side revocation is detected within approximately 26 seconds in the timeout case; direct local revocations still close connected peers immediately.

## TURN

`SYNC_STUN_URLS` and `SYNC_TURN_URLS` are comma-separated. When both `SYNC_TURN_URLS` and backend-only `SYNC_TURN_SECRET` are set, `/api/ice` returns coturn REST-style HMAC-SHA1 credentials lasting `SYNC_TURN_TTL_SECONDS`. The remaining `SYNC_TURN_*` variables in `.env.example` belong to the main-owned coturn deployment tooling and are intentionally ignored by this process.

Never log PINs, opaque sessions, provider tokens, device signatures, TURN credentials, or input payloads. Auth refresh/access tokens are AES-256-GCM encrypted at rest with `SYNC_SESSION_ENCRYPTION_KEY`; loss or rotation of that key invalidates existing sessions by design.

Synology production deployment and graceful container replacement are documented in `deploy/synology.md`. The application enables Nest shutdown hooks so `SIGTERM` closes signaling sockets and drains Redis/PostgreSQL providers before exit.

TURN manifests retain file format `3.3` for older Synology `docker-compose` v1. Use `-p sync-turn-dev` with either CLI to preserve project identity; see [TURN deployment](deploy/README.md#synology의-구버전-compose) for validation and TLS startup commands. No Docker/Compose upgrade is required for these manifests.
