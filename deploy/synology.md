# Synology 배포

프로젝트 위치는 `/volume1/www/_System/sync-api-nest`다. 운영 앱은 독립 컨테이너로 실행하고 루트 infrastructure Compose에 추가하지 않는다. Dockerfile은 React SPA와 NestJS 서버를 함께 빌드한다.

## 환경과 인증

`.env.example` 기준으로 서버의 `.env`를 준비한다. `NODE_ENV=production`, `PORT=3053`, 실제 HTTPS `SYNC_PUBLIC_URL`, 공개 `SYNC_AUTH_ISSUER_URL`, callback `SYNC_OIDC_REDIRECT_URI`를 지정한다. 신규 서비스나 callback 변경은 auth onboarding 신청·승인이 필요하다. 개발용 localhost callback만 승인한 상태를 운영 등록으로 간주하지 않는다.

운영 DB는 기존 PostgreSQL 인스턴스 안에 Sync 전용 DB/role을 만들고 `DATABASE_URL`에 지정한다. Redis는 별도 namespace를 사용한다. 앱 시작 시 repo schema migration이 실행되며 다른 서비스의 DB/테이블/볼륨을 지우지 않는다. 세션 암호화 키와 PIN pepper는 개발 환경 값을 재사용하지 않고 안전한 난수로 준비한다.

## 실행

NAS에 repo source와 workspace `.scripts/deploy-sync-prod.sh`를 반영한 다음 실행한다.

```sh
cd /volume1/www/_System
bash .scripts/deploy-sync-prod.sh --dry-run
bash .scripts/deploy-sync-prod.sh
docker logs --tail 40 sync-api
curl -fsS http://127.0.0.1:3053/api/health
```

스크립트는 Sync 앱 컨테이너만 교체한다. 기본 공개 포트는 localhost3053이며 HTTPS 역방향 프록시를 통해 노출한다. PostgreSQL/Redis/TURN은 별도로 준비한다. 런타임 env의 비밀 값은 빌드 인자/로그에 출력하지 않는다.

## HTTPS 및 WebSocket

선택한 공개 Sync 도메인의 HTTPS를 `127.0.0.1:3053`으로 연결한다. `/api/signaling`에 WebSocket `Upgrade`/`Connection` 헤더 전달과 충분한 연결 timeout이 필요하다. `SYNC_ALLOWED_ORIGINS`에는 실제 웹 origin만 등록하고 wildcard를 쓰지 않는다.

iPhone 초기 로그인에서 사용하는 auth 주소와 callback도 iPhone에서 접근 가능해야 한다. localhost3032 기반 개발 auth는 iPhone이나 다른 컴퓨터에서 그 Mac을 가리키지 않는다. 외부 사용은 공개 HTTPS auth와 승인된 해당 환경 client/callback, 실제 API URL을 앱 설정에 반영한 뒤 검증한다.

## TURN

[TURN 실행 문서](README.md)에 따라 공인 주소 및 UDP/TCP/TLS를 준비한다. API HTTPS reverse proxy만으로 TURN을 대신할 수 없다. API의 `SYNC_TURN_URLS`와 실제 coturn의 external address/certificate/port mapping이 일치해야 한다.

배포 검증은 실제 계정 로그인, PIN 전후 접근 거부, 기기 소유권 및 회수, 서로 다른 네트워크의 영상/입력, 강제 relay와 TURN/TLS, 원격 모드 종료까지 수행한다. 이 검증을 하기 전에는 외부 운영 완료로 표시하지 않는다.
