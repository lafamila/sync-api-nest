# TURN 실행

API의 `.env.example`을 기준으로 `.env`를 준비한다. `SYNC_TURN_SECRET`은 API와 coturn만 공유하는 무작위 32자 이상 문자열이다. 앱에는 API가 발급하는 짧은 credentials만 전달한다.

```sh
node deploy/prepare-turn.mjs .env --check
node deploy/prepare-turn.mjs .env
docker compose -p sync-turn-dev --env-file .env -f deploy/turn.compose.yml up -d
docker logs --tail 30 sync-turn-dev
```

`deploy/.state`는 비밀 설정이므로 커밋·공유하지 않는다. 로그나 compose command에 shared secret을 출력하지 않는다. `SYNC_TURN_IMAGE`에 검증된 이미지 digest를 지정해 운영 버전을 고정한다.

## Synology의 구버전 Compose

두 Compose 파일은 `version: '3.3'`을 명시해 기존 `docker-compose` v1도 읽을 수 있다. 최상위 `name:`은 구버전에서 오류가 나므로 사용하지 않고, v1/v2 모두 `-p sync-turn-dev`로 프로젝트 이름을 고정한다. 최신 Compose가 version을 obsolete로 경고하는 것은 호환용 선언에 대한 경고이며 설정 실패와 구분한다.

NAS에서 `docker compose` 대신 `docker-compose`를 사용하는 경우, TLS 설정은 다음과 같이 검증하고 실행한다. 이 명령은 TURN 프로젝트만 대상으로 하며 Todo/LiveKit/DB를 재시작하지 않는다.

```sh
cd /volume1/www/_System/sync-api-nest
docker-compose -p sync-turn-dev --env-file .env \
  -f deploy/turn.compose.yml -f deploy/turn.tls.compose.yml config --quiet
docker-compose -p sync-turn-dev --env-file .env \
  -f deploy/turn.compose.yml -f deploy/turn.tls.compose.yml up -d
docker logs --tail 30 sync-turn-dev
```

`config --quiet`은 Compose 형식과 변수 구성을 검사할 뿐 인증서 내용·포트 개방·실제 중계 성공을 증명하지 않는다. 실행 전 `prepare-turn.mjs`로 생성한 설정과 인증서 파일이 있어야 한다.

기본 compose는 localhost 전용 UDP/TCP 개발 중계다. `SYNC_TURN_EXTERNAL_IP`는 클라이언트에서 도달할 relay 주소이며 다른 기기 테스트에서는 실제 LAN 주소를 사용한다. `SYNC_TURN_BIND_ADDRESS=0.0.0.0`은 외부 수신을 허용하므로 필요한 경우에만 설정한다. 테스트 전용 `SYNC_TURN_ALLOW_LOOPBACK=true`는 운영에서 사용하지 않는다.

## 인터넷 배포

공인 주소에서 listening port(기본 UDP/TCP 3478)와 relay UDP 범위(기본 49160–49200)를 열고 port mapping, 방화벽, `external-ip`가 같은 실제 경로를 가리키게 한다. API의 `SYNC_TURN_URLS`에는 외부 클라이언트가 접근하는 주소를 넣는다. 기존 NAS HTTPS 리버스 프록시는 TURN UDP/TCP를 대신하지 않는다.

UDP가 차단된 네트워크에는 TURN/TLS listener와 유효한 인증서가 필요하다. 기존 웹 HTTPS가443을 쓰는 NAS에서는 `.env`에 `SYNC_TURN_ENABLE_TLS=true`, `SYNC_TURN_TLS_PORT=5349`, `SYNC_TURN_TLS_BIND_PORT=5349`, 실제 인증서와 private key의 절대 경로 `SYNC_TURN_CERT_PATH`, `SYNC_TURN_KEY_PATH`를 지정한다. 공유기의5349/TCP를 NAS의5349/TCP로 전달하고 `turns:turn.example.com:5349?transport=tcp`를 `SYNC_TURN_URLS`에 추가한다. 중계 UDP 범위의 포워딩도 유지해야 한다.

5349도 차단하는 네트워크를 위해443을 쓰려면 기존 웹 HTTPS와 충돌하지 않는 공인 IP 또는 별도 L4 라우팅이 필요하다. 기존443 포워딩을 TURN으로 바꾸지 않는다. 인증서 파일을 별도 복사해 사용하면 DSM 갱신만으로 복사본은 갱신되지 않으므로, 새 파일 반영 후 같은 Compose 명령에 `--force-recreate`를 추가해 TURN만 재생성한다.

```sh
node deploy/prepare-turn.mjs .env
docker compose -p sync-turn-dev --env-file .env -f deploy/turn.compose.yml -f deploy/turn.tls.compose.yml up -d
```

기본 compose만 실행하면 TLS 인증서를 mount하지 않는다. TLS 모드는 반드시 override 파일까지 포함하고 준비 단계에서 인증서 파일 검증을 통과해야 한다.

앱/WebRTC 설정을 relay-only로 바꾼 실제 테스트와 셀룰러 연결 증거가 있어야 외부 중계 검증 완료로 표시한다. API 로그인과 기기 허가를 생략해 테스트하지 않는다.
