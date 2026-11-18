---
status: IN_PROGRESS
summary: "Android의 explicit control mode/grant/version 및 migration7"
---

# Repo Responsibility
전체 계약은 [root plan](../../.idea/SYNC_ANDROID_REMOTE_CONTROL_PLAN.md).
## Work Items
- Root lock에 따른 DTO/fixtures/all10. Version은 ticket/connect/live device/session만, feature/mode/key 확장.
- Android host proof+explicit scope control; 기존 view 유지. mode/endpoint/owner/grant/native/protocol lock과 downgrade revoke, iOS/browser/PIN 거부.
- migration7 nullable snapshot 보존, 고유 sync_test/Redis 격리 회귀.
- 기존 HTTP projection/CLI/chat/code 유지, docs/CLAUDE/README.
## Acceptance Criteria
Root 기준, compiler/contract/old-config/unit/isolatedDB/build/lint/check10.
## Report Back To Orchestrator
파일/계약/hash/검증/수동 gate. 주요 결정은 중단 보고. 타repo는 generated만 수정.
