# Sync auth onboarding

Import `sync-service-onboarding-create.json` in the central auth `/service` builder or submit it unchanged to `POST /api/service-onboarding-requests`. Approval is intentionally external to this repository and returns the confidential `sync-api` client secret once.

The request creates `member`; central auth owns `visitor` and managed `superadmin`. Sync rejects `visitor` and accepts only `member` or `superadmin`. It does not seed accounts, permissions, clients, or credentials.

The confirmed production callback is `https://sync.lafamila.xyz/api/session/oidc/callback`, and it is included alongside the local callback in the import-ready JSON. If the local-only request was already approved, submit this artifact through the onboarding update workflow before production deployment. Do not edit the auth database or reuse another service's client. Put the one-time production-approved secret only in `SYNC_OIDC_CLIENT_SECRET` on the backend.
