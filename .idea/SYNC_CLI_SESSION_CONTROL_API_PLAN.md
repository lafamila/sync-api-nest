---
status: PREPARED
summary: Sync CLI 확장의 계약 생성·native control 인가·live endpoint 협상·data-only session을 추가하는 조건부 API 계획
---

# CLI Session Control - API

Canonical: [전체 계획](../../.idea/SYNC_CLI_SESSION_CONTROL_PLAN.md). **BLOCKED 조건부 초안**: 설정/재시작 없는 현재 세션이라는 확정 조건에서 Claude foreground/Codex CLI provenance gate가 해결되기 전 구현하지 않는다. 사용자 결정은 끝났지만 기술 검증이 남았다. 기존 `SYNC_API_PLAN.md`의 IN_PROGRESS 및 배포 검증과 별도다.

## 책임과 입력

이 repo는 기존 :3053 API/signaling/DB를 확장한다. 새 auth client/service/env/infra는 현재 필요하지 않다. root의 보안·전송 상태·제한과 Swift provider PoC를 먼저 읽는다. CLI 본문·목록·transcript를 NAS REST/Redis/DB에 저장하는 기능은 만들지 않는다.

## 작업

1. Contracts lane은 `contracts/sync-contract.json`, fixture/generator/output manifest를 소유한다. `features.cliSessions=false` 누락 기본값, optional `cliProtocolVersion`, session `purpose` 누락 screen, bounded `WireCliFrame`/세션목록/submit/receipt를 정의한다. 기존 protocol2/7 capabilities/`WireSignal.type`/`WireInput`은 유지한다.
2. schema generation과 전 언어 출력/골든은 한 lane이 함께 처리한다. TS/Swift/Kotlin/C# consumers의 boundary validation과 unknown optional response를 검증한다. generated 수동 편집 금지. 웹/Windows 기능 UI는 추가하지 않는다.
3. `src/health.controller.ts`, `common/protocol.ts`, `devices/device.dto.ts`, `devices/device.service.ts`, `signaling/ticket.controller.ts`, `ticket.service.ts`, `signaling.service.ts`에 현재 live endpoint의 CLI 선언을 바인딩한다. stale registration/capability DB값으로 지원을 승격하지 않는다. 구 API엔 확장 필드를 보내지 않는 client probe 계약을 잠근다.
4. standalone cli connect는 Mac host + same owner + registered native proof + active control grant + scope control + current mode를 모두 요구한다. 기존 native의 PIN fallback을 CLI admission에서 제외한다. screen-only는 원래대로 처리하고 조건 충족 시에만 CLI 확장을 snapshot한다.
5. `src/sessions/remote-session.repository.ts` 등 session 생성/조회/presenter/install에 purpose 및 협상 CLI version을 고정한다. 현재 schema v3 다음 additive migration 번호를 작업 시 확인한다. default screen/null version, 값 consistency check와 기존 host당 controller unique index를 유지한다. 별도 CLI job/메시지 테이블 금지.
6. ticket/presence/install/host replacement에 endpoint-generation fencing과 authorization lock을 유지한다. revoke/mode-off/expiry/host socket 종료가 CLI authority도 종료하게 한다. 기존 SDP/ICE/session-start를 사용하고 CLI 데이터 routing을 signaling으로 추가하지 않는다.
7. source lane은 src/generated 및 모든 generated output을 제외한 src/test만 맡는다. shared contracts lane의 잠긴 DTO를 받은 뒤 병렬 작업하며 변경 요구를 먼저 orchestrator에게 보고한다.

## 검토 기준

- Unit/typecheck/lint, isolated sync_test 및 고유 Redis prefix integration. 테스트 외 DB/seed/운영 restart 금지.
- populated v3 -> 다음 schema 보존/idempotence, screen default, purpose/version consistency, 동시에 screen+cli 예약 시 하나만 성공.
- cli PIN/browser/view/untrusted/위조 platform/다른 owner 거부; grant/auth/mode/endpoint 회수와 DB snapshot 경합에서 신규 설치 금지.
- old API/config/host/mobile fixture의 화면 기능 유지. 확장 미지원 cli 요청은 명시적으로 거부; stale host 선언을 새 socket에 상속하지 않음.
- session result 및 session-start의 확장값 일치, 현재 one-use ticket/cleanup/고아 row TTL과 bounded liveness 유지.
- `node scripts/generate-contracts.mjs --check`, generator tests, API build/test, web build/browser 회귀. 최신 정확한 명령은 package.json/README를 확인한다.

## 인계 및 마무리

계약 field/limit/error shape/생성 hash/migration/실제 실행 명령과 결과를 보고한다. device proof나 기존 scope를 약화해야 한다면 중단 후 orchestrator에게 전달한다. 사용자에게 필요한 추가 env/onboarding이 생기면 명시하고 임의 등록하지 않는다. README/CLAUDE/공통 프로토콜 문서 영향은 orchestrator와 맞춘다. 사용자 데이터·기존 로컬/운영 서비스를 변경하지 않는다. root와 함께 상태를 전환하며 완료 시 `.idea/completed/`로 이동한다.
