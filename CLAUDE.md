# sync-api-nest

Sync 인증·기기·WebRTC signaling API와 웹 원격 제어 SPA.

- **Lifecycle**: DEPLOY
- **Status**: draft
- **Port**: 3053
- **Auth**: serviceKey `sync`

`../CLAUDE.md` 대원칙을 따른다. OIDC만 사용하며 local password/admin key fallback 금지. visitor 접근 거부, member/superadmin 허용이지만 host 소유권은 모든 계정에 적용한다. OIDC confidential client sync-api, S256 PKCE, scopes openid/profile/email/service.permission. Local callback은 `http://localhost:3053/api/session/oidc/callback`, prod는 env SYNC_PUBLIC_URL에서 구성. Native app return `sync://auth`는 provider callback과 별개다. Native 완료 시 app verifier 필수. 토큰/secret은 서버에만, browser는 HttpOnly cookie, app은 opaque session.

Root canonical plan: `../.idea/SYNC_REMOTE_ACCESS_PLAN.md`. 세부 계약 변경은 orchestrator에게 먼저 보고한다. 타 repo 영향/공통 변경이 있으면 보고하거나 `../.idea/` handoff를 작성한다. 사용자 주요 결정은 임의 처리하지 않고 orchestrator에게 전달한다. Conventional Commit, co-author 제외, 계획→구현→검토, repo-local Dockerfile/HEALTHCHECK/env.example 필요. Root compose 앱 추가 금지. 로컬 테스트 우선. 실제 계정/서비스 권한 seed 금지.

## 검토 기준

API typecheck/unit/integration/security tests, web build/e2e, env 비밀 검증 및 README 운영 명령. 로그에 PIN/토큰/키보드 입력을 저장하지 않는다. auth onboarding 승인 전 상태는 unconfigured로 표시하며 인증을 우회하지 않는다.

Native 완료는 initiating app verifier와 callback에만 전달되는 60초 일회용 handoffCode를 모두 요구한다. 웹/앱 세션 전송 방식은 DB의 발급 platform으로 검증하며 caller header만으로 바꾸지 않는다. 운영 배포/공개 auth 등록은 사용자가 직접 수행한다.
