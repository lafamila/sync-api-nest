---
status: COMPLETED
completed_at: 2026-11-06
summary: "신뢰 기기 코드 조회의 공통 계약, native-only authorization, migration6"
---

# Repo Responsibility

전체 계획은 [root plan](../../../.idea/completed/SYNC_TRUSTED_ACCESS_CODE_PLAN.md)을 따른다.

## Work Items

- 공통 access-code capability, purpose, strict WireAccessCodeFrame/fixtures/전체 generated outputs.
- data-only 접속에 native proof, same owner, desktop, permanent control grant, allowBrowser/mode, current host endpoint를 강제한다. CLI/chat 권한은 섞지 않는다.
- DB create/install/bind와 signaling resume까지 snapshot/철회 방어. migration6은 이전 데이터 보존 및 일반 세션 단일성/코드 세션 공존.
- 기존 전용 sync_test 고유 schema/Redis-prefix 방식 integration. 실제 dev/prod migration/restart/deploy 금지.
- 계약/배포/호환성 문서 및 테스트. 새 secret/env 불필요.

## Acceptance Criteria

Root Review Pass Criteria에 따른 contract/unit/typecheck/build/격리 DB 회귀. 운영 미적용을 명시한다.

## Report Back To Orchestrator

변경 파일, exact contract/hash, 실행한 검증 결과, 미검증 gate/타 repo 영향. 사용자 주요 결정은 중단 후 보고. generated 외 다른 repo 코드는 수정하지 않는다.

## API Completion Evidence

- Source frozen on 2026-11-06; implementation and owned generated outputs complete.
- Contract SHA-256: `2951454e5a7a6babf4b6f82d3c4a35073430e66600db1b3981f097484ddfbc09`.
- All10 generated outputs deterministic; full compiler/fixture suite21 passed, zero skips (Swift/C#/Kotlin included). Native compiler slot released.
- API unit242 passed after the HTTP compatibility projection fix (18 new regressions). Default test run intentionally skips integration; dedicated isolated access-code + CLI/chat suites59 passed separately before the projection-only patch. SQL was not changed or rerun for that patch.
- Actual PostgreSQL row-lock contention covers create/install/bind revocation, post-lock expiry and in-lock live allowBrowser checks. Populated v5 screen/CLI/chat migration6 preservation/idempotence, index coexistence, consistency constraints and persistence/audit negatives passed.
- API lint/typecheck/build and web typecheck/production build passed; prior artifacts protected by workspace retention helper. Diff whitespace checks passed.
- No dependency/account/GUI/device/emulator/deploy/restart/commit/push changes. No dev/public migration or truncate. Production migration and native physical/OS/peer gates remain leader/user-owned.
- Detailed handoff: root `.omx/access-code-api-handoff.md`; API contract/operations: `docs/access-code.md`.
- Exact `X-Sync-Extensions: access-code` opt-in on new native requests controls only HTTP config/device/session-list projections. Default legacy7 capability and purpose2 domains, merged Vary/no-store, genuine frozen pre-feature catalog tests, and browser-forged-header403 all pass. No protocol3, auth-session metadata, schema/hash/generator/native changes were made in the compatibility fix.
