---
status: IN_PROGRESS
summary: Sync OIDC BFF, device proof, mode/PIN and WebRTC signaling with web control
---

# API 실행 계획

Canonical: `../../.idea/SYNC_REMOTE_ACCESS_PLAN.md`. 공통 계약을 반드시 먼저 읽는다.
전체 목표와 정책은 canonical 및 technical design에 있다. 타 레포 계약 변경은 orchestrator에게 보고한다.

API/auth/device/PIN/session/Redis/PostgreSQL/signaling와 React 웹을 구현한다. visitor/다른 소유자/PIN 실패/회수/재사용 ticket/콜백 가로채기 거부 테스트가 필요하다. unit 및 실제 DB/Redis integration, typecheck, browser WebRTC tests, build, README/env/Dockerfile/HEALTHCHECK를 검토한다. auth seed 금지, onboarding JSON 준비.

## 구현 검증 기록

API/웹 구현 및 빌드·타입·unit14·DB/Redis9·브라우저7·실제 HTTP/OIDC fixture/WebRTC 직접 및 relay·서버 재시작 복구 검증 통과. Native 완료는 verifier+callback-only 60초 handoffCode를 요구하고 웹/앱 세션은 발급 platform에 바인딩한다. 커밋 5123a77, abcdf65, c3ac720. 운영 배포/공개 auth는 사용자가 수행한다. Root 계획의 실제 Mac/iPhone OS 검증 전까지 IN_PROGRESS로 유지한다.
