# sync-api-nest

Sync 인증·기기·WebRTC signaling API와 웹 원격 제어 SPA.

- **Lifecycle**: DEPLOY
- **Status**: draft
- **Port**: 3053
- **Auth**: serviceKey `sync`

`../CLAUDE.md` 대원칙을 따른다. OIDC만 사용하며 local password/admin key fallback 금지. visitor 접근 거부, member/superadmin 허용이지만 host 소유권은 모든 계정에 적용한다. OIDC confidential client sync-api, S256 PKCE, scopes openid/profile/email/service.permission. Local callback은 `http://localhost:3053/api/session/oidc/callback`, prod는 env SYNC_PUBLIC_URL에서 구성. Native app return `sync://auth`는 provider callback과 별개다. Native 완료 시 app verifier 필수. 토큰/secret은 서버에만, browser는 HttpOnly cookie, app은 opaque session.

Root canonical plan: `../.idea/SYNC_REMOTE_ACCESS_PLAN.md`. 세부 계약 변경은 orchestrator에게 먼저 보고한다. 타 repo 영향/공통 변경이 있으면 보고하거나 `../.idea/` handoff를 작성한다. 사용자 주요 결정은 임의 처리하지 않고 orchestrator에게 전달한다. Conventional Commit, co-author 제외, 계획→구현→검토, repo-local Dockerfile/HEALTHCHECK/env.example 필요. Root compose 앱 추가 금지. 로컬 테스트 우선. 실제 계정/서비스 권한 seed 금지.

## 검토 기준

CLI1 확장은 `docs/cli-sessions.md`와 root `.docs/SYNC_CLI_PROTOCOL.md`를 따른다. 기존 protocol2/7 capabilities는 유지하고 schema/generator/모든 언어 출력을 함께 갱신한다. live native proof+same-owner control grant+Mac mode만 허용하며 PIN/browser/view는 금지한다. CLI 본문은 DataChannel 전용이고 HTTP/WSS/DB/log로 보내지 않는다. migration4는 additive이며 실제 운영 적용은 사용자 배포 절차를 따른다. queued는 처리 완료가 아니고 unknown은 자동 재발송하지 않는다.

API typecheck/unit/integration/security tests, web build/e2e, env 비밀 검증 및 README 운영 명령. 로그에 PIN/토큰/키보드 입력을 저장하지 않는다. auth onboarding 승인 전 상태는 unconfigured로 표시하며 인증을 우회하지 않는다.

웹 입력은 Swift 계약과 함께 검토한다. 스크롤 dx/dy는 -100...100이며, Command/Control/Option/Shift는 지원되는 key 이벤트의 modifiers로 전달한다. 네이티브가 모르는 MetaLeft 등의 독립 key 이벤트나 조합키 대신 일반 text를 보내지 않는다. `web/tests/sync.spec.ts`에 실제 채널 회귀 검증이 있다.

Native 완료는 initiating app verifier와 callback에만 전달되는 60초 일회용 handoffCode를 모두 요구한다. 웹/앱 세션 전송 방식은 DB의 발급 platform으로 검증하며 caller header만으로 바꾸지 않는다. 운영 배포/공개 auth 등록은 사용자가 직접 수행한다.

LAN 개발 테스트의 브라우저 인증 주소는 선택적 `SYNC_OIDC_AUTHORIZATION_URL`로 분리한다. 토큰 교환·JWT issuer/JWKS 검증은 기존 `SYNC_AUTH_*`를 유지한다. `scripts/dev-auth-lan.mjs`는 지정된 사설 IPv4에서 기존 loopback auth의 공개 OAuth/OIDC 경로만 전달하며 admin/service 경로를 노출하지 않는다. Origin은 정확한 주소만 추가하고 CSRF 검사를 유지한다. LAN callback도 사용자 onboarding 변경 승인이 필요하고 승인 시 새 secret을 서버 `.env`에 반영한다. 운영에는 이 개발용 HTTP 프록시를 사용하지 않는다.

TURN의 base/TLS Compose는 Synology `docker-compose` v1 호환을 위해 양쪽 모두 file format3.3을 유지한다. 최상위 `name:`을 추가하지 않고 v1/v2 명령에 `-p sync-turn-dev`를 지정한다. 변경 시 가짜 env만 사용하는 base·TLS `config --quiet`를 구버전/최신 파서로 검증하며, 다른 서비스·실제 TURN·DB를 시작/재시작하지 않는다.

Docker의 backend/web/runtime `npm ci`는 유한한 fetch 재시도로 일시적 네트워크 오류를 보완하며 lockfile·TLS·실패 전파는 유지한다. NAS의 지속적인 `ETIMEDOUT`은 해당 Docker 네트워크의 registry 연결을 별도 확인하며, registry/TLS 우회나 기존 서비스 종료로 해결하지 않는다. Workspace 배포 스크립트의 변경은 API checkout과 별도로 NAS에 반영한다.

고정 coturn4.18 설정은 `cli=0`·`dtls=0`과 기본 TLS최소1.2를 유지하고 제거된 구형 옵션을 생성하지 않는다. TURN은 UID/GID0:0 + cap_dropALL이므로 전용 인증서/키 복사본의 root 소유·mode600을 유지한다. TLS 실패에서 파일 존재와 실제 프로세스의 읽기 가능 여부를 구분하며, chmod644/777·capability 추가·인증서 검증 해제로 우회하지 않는다. 생성기 수정 후 기존 conf 재생성과 TURN 재생성이 별도로 필요하다.
