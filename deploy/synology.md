# Synology 배포

프로젝트 위치는 `/volume1/www/_System/sync-api-nest`다. 운영 앱은 독립 컨테이너로 실행하고 루트 infrastructure Compose에 추가하지 않는다. Dockerfile은 React SPA와 NestJS 서버를 함께 빌드한다.

## 환경과 인증

`.env.example` 기준으로 서버의 `.env`를 준비한다. `NODE_ENV=production`, `PORT=3053`, 실제 HTTPS `SYNC_PUBLIC_URL`, 공개 `SYNC_AUTH_ISSUER_URL`, callback `SYNC_OIDC_REDIRECT_URI`를 지정한다. 신규 서비스나 callback 변경은 auth onboarding 신청·승인이 필요하다. 개발용 localhost callback만 승인한 상태를 운영 등록으로 간주하지 않는다.

운영 DB는 기존 PostgreSQL 인스턴스 안에 Sync 전용 DB/role을 만들고 `DATABASE_URL`에 지정한다. Redis는 별도 namespace를 사용한다. 앱 시작 시 repo schema migration이 실행되며 다른 서비스의 DB/테이블/볼륨을 지우지 않는다. 세션 암호화 키와 PIN pepper는 개발 환경 값을 재사용하지 않고 안전한 난수로 준비한다.

## 실행

NAS에 repo source와 workspace `.scripts/deploy-sync-prod.sh`를 반영한 다음 실행한다.

스크립트는 `git pull --ff-only` 후 이미지를 빌드하며, pull/build/환경 검증이 실패하면 기존 Sync 컨테이너를 중지하지 않는다. Git checkout과 `.env`가 먼저 준비되어 있어야 한다. `--dry-run`은 pull 명령까지 출력만 하고 실행하지 않는다. `.scripts/deploy-sync-prod.sh`는 API 레포 밖의 workspace 파일이므로 API의 `git pull`만으로 갱신되지 않으며 NAS의 같은 경로에 따로 반영해야 한다.

```sh
cd /volume1/www/_System
bash .scripts/deploy-sync-prod.sh --dry-run
bash .scripts/deploy-sync-prod.sh
docker logs --tail 40 sync-api
curl -fsS http://127.0.0.1:3053/api/health
```

스크립트는 Sync 앱 컨테이너만 교체한다. 기본 공개 포트는 localhost3053이며 HTTPS 역방향 프록시를 통해 노출한다. PostgreSQL/Redis/TURN은 별도로 준비한다. 런타임 env의 비밀 값은 빌드 인자/로그에 출력하지 않는다.

## npm 다운로드 타임아웃

Dockerfile의 세 `npm ci`는 공식 레지스트리 요청에 재시도5회를 적용한다. lockfile/integrity/TLS 검증은 유지하고, 최종 설치 실패를 무시하지 않는다. 이는 일시적인 연결 오류에 대한 재시도이며 NAS의 DNS·라우팅·프록시 문제를 해결했다는 뜻은 아니다.

`ETIMEDOUT`이 반복되면 NAS의 기본 Docker 네트워크에서 다음 연결 검사부터 실행한다. 실제 `.env`나 자격증명을 마운트하지 않으며 기존 서비스를 변경하지 않는다.

```sh
docker run --rm node:22-alpine npm ping --fetch-retries=0 --fetch-timeout=20000
```

이 검사가 실패하면 Docker 외부 HTTPS/DNS 경로를 먼저 확인한다. 통과하면 동일 빌드를 다시 실행해 성공한 Docker 레이어 캐시를 재사용한다. 무조건적인 `--no-cache`, lockfile 삭제, 비공식 mirror, `strict-ssl=false`로 우회하지 않는다. 배포용 앱 `.env`의 DB/Redis 주소는 이 빌드 단계의 npm 다운로드와 별개다.

## HTTPS 및 WebSocket

선택한 공개 Sync 도메인의 HTTPS를 `127.0.0.1:3053`으로 연결한다. `/api/signaling`에 WebSocket `Upgrade`/`Connection` 헤더 전달과 충분한 연결 timeout이 필요하다. `SYNC_ALLOWED_ORIGINS`에는 실제 웹 origin만 등록하고 wildcard를 쓰지 않는다.

DSM7에서는 **제어판 → 로그인 포털 → 고급 → 역방향 프록시**에서 `sync.lafamila.xyz` 규칙을 편집한다. 대상은 HTTP `127.0.0.1:3053`으로 유지하고 **사용자 지정 헤더 → 생성 드롭다운 → WebSocket**으로 표준 Upgrade/Connection 헤더를 추가한다. 고급 설정의 대상 Proxy HTTP 버전은 HTTP/1.1을 사용한다. 소스 HTTPS/인증서를 TURN 포트로 변경하지 않는다.

REST 로그인·기기 등록·신뢰 승인 성공은 WebSocket 성공을 뜻하지 않는다. 기기의 원격 mode는 활성인데 presence가 없고, NAS 내부 `/api/signaling`은 HTTP101인데 공개 WSS는404라면 reverse proxy의 업그레이드 전달을 확인한다. 무효한 진단 티켓으로101 뒤1008 `ticket invalid`를 받는 것은 업그레이드 경로만 통과한 것이며, 실제 인증/기기 온라인 성공은 별도로 확인한다. 로그에 실제 티켓을 출력하지 않는다.

설정 저장 후 필요하면 Mac의 Turn Off/Turn On으로 새 host 연결을 만들고 iPhone 목록을 새로고침한다. 이미 열어둔 Connect 시트는 닫고 다시 연다. mode 활성 표시는 실제 online/presence 상태와 구분하며, 프록시 문제를 기기 재등록·신뢰 재설정·DB 초기화로 우회하지 않는다.

iPhone 초기 로그인에서 사용하는 auth 주소와 callback도 iPhone에서 접근 가능해야 한다. localhost3032 기반 개발 auth는 iPhone이나 다른 컴퓨터에서 그 Mac을 가리키지 않는다. 외부 사용은 공개 HTTPS auth와 승인된 해당 환경 client/callback, 실제 API URL을 앱 설정에 반영한 뒤 검증한다.

## TURN

[TURN 실행 문서](README.md)에 따라 공인 주소 및 UDP/TCP/TLS를 준비한다. API HTTPS reverse proxy만으로 TURN을 대신할 수 없다. API의 `SYNC_TURN_URLS`와 실제 coturn의 external address/certificate/port mapping이 일치해야 한다.

배포 검증은 실제 계정 로그인, PIN 전후 접근 거부, 기기 소유권 및 회수, 서로 다른 네트워크의 영상/입력, 강제 relay와 TURN/TLS, 원격 모드 종료까지 수행한다. 이 검증을 하기 전에는 외부 운영 완료로 표시하지 않는다.
