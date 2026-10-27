# Sync auth onboarding

Import `sync-service-onboarding-create.json` in the development auth `/service` builder. For public auth, use `sync-service-onboarding-production-create.json` instead. Approval is intentionally external to this repository and returns that environment's confidential `sync-api` client secret once.

The request creates `member`; central auth owns `visitor` and managed `superadmin`. Sync rejects `visitor` and accepts only `member` or `superadmin`. It does not seed accounts, permissions, clients, or credentials.

The development callback is `http://localhost:3053/api/session/oidc/callback`; the production callback is `https://sync.lafamila.xyz/api/session/oidc/callback`. Development and public auth registrations and secrets are independent. If a service already exists in the target auth environment, use its onboarding update workflow. Do not edit the auth database or reuse another service's client. Production approval and deployment are performed by the user. Its one-time secret belongs in backend `SYNC_OIDC_CLIENT_SECRET`; the optional private staging file is `deploy/.state/nas.env`.
