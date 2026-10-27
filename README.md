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

## Commands

```bash
npm run typecheck
npm test
npm run test:integration # dedicated sync_test DB and sync:test:<fixture> Redis prefix
npm run test:system      # compiled API + fixture OIDC + production SPA + Chrome WebRTC/TURN
npm run build
npm run build:web
npm run build:all
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
- `GET|DELETE /api/sessions[/sessionId]`
- `POST /api/signaling/tickets`, `GET /api/ice`

Native login has two independent S256 bindings: provider PKCE between Sync and auth, plus the app's `challenge=base64url(SHA256(verifier))`. The provider callback returns only `sync://auth?transactionId=...`; the initiating app must present the verifier once at `/api/session/oidc/complete` to receive its opaque session.

Device public keys are base64 P-256 SPKI DER. Signatures are base64 ASN.1 DER ECDSA-SHA256 over exactly:

```text
sync:register:<challengeId>:<nonce>
sync:device:<deviceId>:<challengeId>:<nonce>
```

Device deletion separates actor from target: any active device owned by the session account may sign the deletion request, and the target is independently checked against that same owner. This permits removing a lost device without its private key. A revoked actor and a cross-account target are rejected. Permanent grant approval remains stricter and always requires the target host's own proof.

Enabling or reissuing mode creates a new UUID epoch and six-digit PIN. PIN HMACs, account+host+epoch failures, IP failures, and lockout are updated atomically in Redis. Five account failures invalidate the mode. `allowBrowser` gates every untrusted temporary connection, not a client-supplied platform label: browsers also require allowed Origin and CSRF, while proof-bearing but unapproved controllers remain untrusted and still need the current PIN. Only macOS hosts with `allowBrowser=true` accept temporary PIN connections. A trusted native connection requires an existing host-approved grant and controller proof. PIN-based connections are always temporary: `rememberDevice` is rejected and can never create trust. A host explicitly approves a registered controller with `POST /api/devices/:hostId/grants` using the host private-key proof. iOS hosts are view-only and require an existing grant. A partial PostgreSQL unique index enforces one active controller per host. Connection creation rechecks the mode epoch after persistence; a concurrent mode change ends the row before any ticket is issued.

## Signaling

Connect to `ws(s)://<host>/api/signaling?ticket=<opaque-one-use-ticket>`. Tickets expire after 60 seconds by default and are atomically consumed. Browser controller tickets require an allowed Origin. Device tickets bind one registered device; replacing that device socket uses a connection identity so the stale socket's close event cannot mark the replacement offline.

Messages are `ready`, `session-start`, `offer`, `answer`, `ice`, `session-ended`, `ping`, and `pong` as defined by the shared Sync v1 contract. Controller sessions may send offers, hosts may send answers, both may send ICE, and every route is checked against the active PostgreSQL session plus current Redis mode epoch. Mode changes, device/grant/session revocation, logout, expiry, or real socket loss end the durable session and notify peers. Server WebSocket ping/pong uses a 15-second deadline; presence is renewed only for a pong-responsive socket whose issuing auth session still validates. If a PostgreSQL, Redis, or authorization check is uncertain, signaling fails closed by sending `session-ended` to locally connected peers and closing controller and device sockets, even when the durable end write cannot complete.

Sync intentionally runs one active API instance per `SYNC_REDIS_KEY_PREFIX`. A renewable Redis lease (15 seconds by default, configured by `SYNC_INSTANCE_LEASE_TTL_SECONDS`) prevents a second live instance from claiming the same signaling namespace. Remote-session rows record namespace and instance UUID. After an ungraceful process loss, the next lease owner ends only stale rows from that namespace as `server_restarted` before accepting traffic, so reconnect is not blocked by the active-host unique index. Lease loss makes the old process fail closed and terminate; this is explicit single-instance recovery, not an HA claim.

While a controller socket is active, the backend performs a provider refresh check every `SYNC_AUTH_RECHECK_SECONDS` (20 seconds by default), even when the current access JWT has not expired. Refresh-token rotation is serialized per session both in process and with a PostgreSQL row lock. With the default five-second auth HTTP timeout and one-second signaling sweep, provider-side revocation is detected within approximately 26 seconds in the timeout case; direct local revocations still close connected peers immediately.

## TURN

`SYNC_STUN_URLS` and `SYNC_TURN_URLS` are comma-separated. When both `SYNC_TURN_URLS` and backend-only `SYNC_TURN_SECRET` are set, `/api/ice` returns coturn REST-style HMAC-SHA1 credentials lasting `SYNC_TURN_TTL_SECONDS`. The remaining `SYNC_TURN_*` variables in `.env.example` belong to the main-owned coturn deployment tooling and are intentionally ignored by this process.

Never log PINs, opaque sessions, provider tokens, device signatures, TURN credentials, or input payloads. Auth refresh/access tokens are AES-256-GCM encrypted at rest with `SYNC_SESSION_ENCRYPTION_KEY`; loss or rotation of that key invalidates existing sessions by design.

Synology production deployment and graceful container replacement are documented in `deploy/synology.md`. The application enables Nest shutdown hooks so `SIGTERM` closes signaling sockets and drains Redis/PostgreSQL providers before exit.
