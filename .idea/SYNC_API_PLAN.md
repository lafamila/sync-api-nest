---
status: IN_PROGRESS
summary: Sync OIDC BFF, device proof, mode/PIN and WebRTC signaling with web control
---

# API 실행 계획

Canonical: `../../.idea/SYNC_REMOTE_ACCESS_PLAN.md`. 공통 계약을 반드시 먼저 읽는다.
전체 목표와 정책은 canonical 및 technical design에 있다. 타 레포 계약 변경은 orchestrator에게 보고한다.

API/auth/device/PIN/session/Redis/PostgreSQL/signaling와 React 웹을 구현한다. visitor/다른 소유자/PIN 실패/회수/재사용 ticket/콜백 가로채기 거부 테스트가 필요하다. unit 및 실제 DB/Redis integration, typecheck, browser WebRTC tests, build, README/env/Dockerfile/HEALTHCHECK를 검토한다. auth seed 금지, onboarding JSON 준비.

## 구현 검증 기록

2026-10-28 후속 검증: 네이티브 입력 규격에 맞춰 웹 스크롤 범위와 조합키를 수정하고 브라우저 9개 통과. LAN용 정확한 Origin·callback 및 브라우저 authorization endpoint 분리를 추가했다. 기존 auth issuer/DB는 변경하지 않고 공개 OAuth/OIDC 경로만 전달하는 LAN 프록시를 검증했다(admin 비노출). Unit17·전용 DB/Redis9·proxy4·실제 HTTP/OIDC fixture/직접·LAN TURN 강제 중계 통합 검증 통과. 실제 auth의 LAN callback 변경 승인과 새 client secret은 사용자 담당이며 승인 전 테스트 계정이나 우회 경로로 대체하지 않는다.

API/웹 구현 및 빌드·타입·unit14·DB/Redis9·브라우저7·실제 HTTP/OIDC fixture/WebRTC 직접 및 relay·서버 재시작 복구 검증 통과. Native 완료는 verifier+callback-only 60초 handoffCode를 요구하고 웹/앱 세션은 발급 platform에 바인딩한다. 커밋 5123a77, abcdf65, c3ac720. 운영 배포/공개 auth는 사용자가 수행한다. Root 계획의 실제 Mac/iPhone OS 검증 전까지 IN_PROGRESS로 유지한다.
