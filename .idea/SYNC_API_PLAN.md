---
status: IN_PROGRESS
summary: Sync OIDC BFF, device proof, mode/PIN and WebRTC signaling with web control
---

# API 실행 계획

Canonical: `../../.idea/SYNC_REMOTE_ACCESS_PLAN.md`. 공통 계약을 반드시 먼저 읽는다.
전체 목표와 정책은 canonical 및 technical design에 있다. 타 레포 계약 변경은 orchestrator에게 보고한다.

API/auth/device/PIN/session/Redis/PostgreSQL/signaling와 React 웹을 구현한다. visitor/다른 소유자/PIN 실패/회수/재사용 ticket/콜백 가로채기 거부 테스트가 필요하다. unit 및 실제 DB/Redis integration, typecheck, browser WebRTC tests, build, README/env/Dockerfile/HEALTHCHECK를 검토한다. auth seed 금지, onboarding JSON 준비.
