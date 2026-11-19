---
status: COMPLETED
summary: "웹 원격 화면 viewport 맞춤, edge-reveal 패널/키 도구와 직접 키보드 입력"
---

# Sync Web Viewport And Input

## Scope
- 사용자 사용 중인 Mac 프로세스·앱·빌드물·계정·연결·DB·운영 서버를 중지하거나 교체하지 않는다.
- web source/test/docs만 수정. 실제 서비스 restart/deploy/production build/dist 교체 금지. 검증은 별도 fixture Vite/Playwright 포트와 typecheck로 수행한다.
- 원격 영상은 viewport 전체를 사용하고 기본 contain으로 비율/전체 내용을 유지한다. 정보·키·세션 도구는 overlay로 표시하며 열기/닫기가 영상 bounds/peer를 바꾸지 않는다.
- 우측 정보는 기본 접힘, 오른쪽 끝 hover/focus 때 펼침 버튼. 하단 키 도구는 하단 hover/focus로 표시. 상단 세션 도구도 영상 영역을 차지하지 않는 edge overlay로 유지한다.
- desktop web은 자동 keyboard capture. 일반 키/단축키/IME는 기존 검증된 text/key 경로 사용. 로컬 form/select/button 입력과 view/expired/blur/hidden 입력은 전송하지 않는다. modifier 버튼과 선택형 text entry 유지.
- native/mobile 앱 수정 없음. 웹 터치/IME/zoom/권한/lifetime/recovery/peer 소유권 유지. 새 dependency/공통 wire 변경 없음.

## Verification
- 실제 fixture RTC 입력(일반 문자/Enter/Tab/Backspace/조합/physical+virtual modifiers/keyup), 지역 form/select 제외, blur/hidden/expiry/view-only 차단.
- 1280/작은 desktop/mobile viewport에서 페이지 scroll 없음, 영상 fit/좌표/비공백, panel/dock overlay 및 bounds/peer 안정성.
- hover/keyboard 접근/실수 remote click 방지, textarea/IME focus, 패널 사용 중 접힘 방지.
- typecheck/브라우저 전체 회귀/스크린샷 및 visual verdict. production/native 빌드물은 변경하지 않는다.
- 독립 검토·문서·기능별 commit, 서버 repo main push(운영 배포 아님). 실제 실행 중 Mac/운영 연결을 테스트에 사용하지 않는다.

## Completion

2026-11-19: 구현·격리 검증 완료. 웹 브라우저 단일 전체 실행78/78,0fail/skip/flaky/retry(118.4초), web/typecheck 및 엄격한 테스트 소스 typecheck, diff 검사 통과. 실제 fixture RTC에서 viewport/portrait/overlay, 직접 입력/한글/조합 취소/단축키, 로컬·shadow editor 격리와 기존 lifetime/recovery/display/late row 회귀를 확인했다. 수정 전 실패 기록을 보존하고 독립 검토의 포커스/늦은 IME 경계도 보강했다.

Desktop1280/800 및 mobile390 실제 합성 영상 픽셀/스크린샷을 확인했다. UI visual94/pass. 문서: web/README.md, 증거: ignored web/artifacts/immersive-final/full-78-results.json 및 동일 폴더 스크린샷.

프로덕션/native 빌드·dist 교체·DB/기기 권한 변경·서비스 재시작·실제 사용자 연결 테스트는 수행하지 않았다. 사용 중 Mac PID82724/시작 시각/실행 파일 SHA256이 작업 전후 동일함을 확인했다. 검증용4179/24678 포트와 fixture 브라우저는 정리했다. 운영 반영은 사용자 추후 빌드/배포 후이며 새 환경변수·공통 계약·모바일 앱 업데이트는 없다.
