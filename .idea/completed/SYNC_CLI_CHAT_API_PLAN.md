---
status: COMPLETED
summary: CLI 채팅 하위 확장 계약·협상·서명 프로필 공개 배포와 구버전 호환
---

# CLI Chat - API / Contracts

Canonical: [root](../../../.idea/completed/SYNC_CLI_CHAT_ADAPTER_PLAN.md). Read its complete security, limits and acceptance contracts before implementation. No unresolved user decision.

Completed2026-11-02:175 units,25 isolated DB,20 cross-language contracts,49 browser regressions and lint/typecheck/build/check10 pass. No real DB migration/restart/deploy. See `docs/cli-sessions.md`.

## Repo Responsibility

Existing DEPLOY/:3053/auth sync remains. Own schema/generator/all10 generated outputs/goldens, optional chat endpoint/session negotiation, additive metadata migration and public signed-profile serving. No message/history DB or private signing key on server.

## Work Items

- Publish exact `cliChatProtocolVersion:1` and `WireCliChatFrame`/message DTOs + page/content/tail request/result shapes early. Keep base2/CLI1/capabilities7/receipt enum unchanged; omit request additions on old APIs, session snapshot intersection only.
- Latest20 text messages, older-page cursor, live tail/revisions, content continuation and reset/error/progress flags must be representable and bounded. Respect numeric ceilings in root plan; source-backed rows only.
- Add nullable negotiated chat snapshot metadata in next migration, preserve rows/host uniqueness and native/control/grant/expiry fences. Browser/PIN/view may never negotiate chat.
- Serve bounded public versioned signed profile/catalog artifacts from existing Sync domain; no credentials or user data in assets. Native profile lane supplies public baseline/signature; API never holds private signer.
- Keep legacy CLI send/web/Windows consumers working; signed catalog has separate strict data schema. No production seed/restart/deploy.

## Acceptance Criteria

Generator deterministic/check10/all language fixture compiles; unit/typecheck/lint/build; isolated sync_test/unique Redis migration preservation and auth/race/old-new fixtures; catalog path/byte/HTTP behavior without secret access; old browser regressions remain passing. No hardware/WAN claim from mocks.

## Report Back To Orchestrator

Publish DTO/hash/facade before consumers; report cross-repo fields/migration/artifact paths and required deploy order. User-major changes stop for orchestrator. Scope commit only after integration; root/per-repo COMPLETED and `.idea/completed/` move only after implemented/executed verification.
