# TURN 실행

API의 `.env.example`을 기준으로 `.env`를 준비한다. `SYNC_TURN_SECRET`은 API와 coturn만 공유하는 무작위 32자 이상 문자열이다. 앱에는 API가 발급하는 짧은 credentials만 전달한다.

```sh
node deploy/prepare-turn.mjs .env --check
node deploy/prepare-turn.mjs .env
docker compose --env-file .env -f deploy/turn.compose.yml up -d
docker logs --tail 30 sync-turn-dev
```

`deploy/.state`는 비밀 설정이므로 커밋·공유하지 않는다. 로그나 compose command에 shared secret을 출력하지 않는다. `SYNC_TURN_IMAGE`에 검증된 이미지 digest를 지정해 운영 버전을 고정한다.

기본 compose는 localhost 전용 UDP/TCP 개발 중계다. `SYNC_TURN_EXTERNAL_IP`는 클라이언트에서 도달할 relay 주소이며 다른 기기 테스트에서는 실제 LAN 주소를 사용한다. `SYNC_TURN_BIND_ADDRESS=0.0.0.0`은 외부 수신을 허용하므로 필요한 경우에만 설정한다. 테스트 전용 `SYNC_TURN_ALLOW_LOOPBACK=true`는 운영에서 사용하지 않는다.

## 인터넷 배포

공인 주소에서 listening port(기본 UDP/TCP 3478)와 relay UDP 범위(기본 49160–49200)를 열고 port mapping, 방화벽, `external-ip`가 같은 실제 경로를 가리키게 한다. API의 `SYNC_TURN_URLS`에는 외부 클라이언트가 접근하는 주소를 넣는다. 기존 NAS HTTPS 리버스 프록시는 TURN UDP/TCP를 대신하지 않는다.

UDP가 차단된 네트워크에는 TURN/TLS listener와 유효한 인증서가 필요하다. `.env`에 `SYNC_TURN_ENABLE_TLS=true`, `SYNC_TURN_TLS_PORT=5349`, `SYNC_TURN_TLS_BIND_PORT=443`, 실제 인증서와 private key의 절대 경로 `SYNC_TURN_CERT_PATH`, `SYNC_TURN_KEY_PATH`를 지정한다. 443을 쓰려면 기존 웹 HTTPS와 충돌하지 않는 공인 IP 또는 L4 라우팅이 필요하다. 인증서/포트 준비 후 `turns:turn.example.com:443?transport=tcp` 등을 `SYNC_TURN_URLS`에 추가한다.

```sh
node deploy/prepare-turn.mjs .env
docker compose --env-file .env -f deploy/turn.compose.yml -f deploy/turn.tls.compose.yml up -d
```

기본 compose만 실행하면 TLS 인증서를 mount하지 않는다. TLS 모드는 반드시 override 파일까지 포함하고 준비 단계에서 인증서 파일 검증을 통과해야 한다.

앱/WebRTC 설정을 relay-only로 바꾼 실제 테스트와 셀룰러 연결 증거가 있어야 외부 중계 검증 완료로 표시한다. API 로그인과 기기 허가를 생략해 테스트하지 않는다.
