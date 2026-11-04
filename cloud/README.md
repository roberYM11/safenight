# SafeNight — Sites 클라우드 실행본

서울시 S-DoT의 조도·소음과 센서 위치를 지도에서 확인한다. 수집 서버·DB·모델 추론은 Sites의 Cloudflare Workers·D1·R2에서 실행하며 로컬 서버나 Docker가 필요하지 않다. CCTV 조회·영상·인원 검출 기능은 제거했다.

## 데이터와 실행

- D1: 불변 관측 revision, 현재/최신 선택값, 수집 작업·페이지·lease·checkpoint
- R2: SHA-256으로 구분한 원문 응답과 기존 PostgreSQL 전체 백업
- 원문 보존 → 형식·시간·페이지 검증 → staging → 전체 완료 후 원자적 게시
- 한 요청은 최대 200행 한 페이지를 처리하고 중단 시 저장된 cursor에서 재개
- 새 관측은 재학습을 실행하지 않으며, 검증한 모델로 요청 시 추론
- 30시간을 넘긴 관측·입력 부족·지원 범위 밖에서는 점수 null

화면은 클라우드 DB의 게시된 관측만 조회한다. 초기 자료를 코드의 고정 점수로 대신하지 않는다. 마지막 수집 확인 시각과 실제 관측 시각을 구분한다. 센서 위치는 기존 공식 파일에서 이전한 자료이며, 위치 파일 새 버전 자동 탐지는 별도 확장 항목이다.

## 개발·검증

```sh
npm ci
npx tsc --noEmit
node --test tests/*.test.mjs
npm run build
```

Drizzle migration은 스키마 변경만 담는다. 원문과 관측 이전은 인증된 운영자 import 경로로 처리한다. 로컬 D1 미리보기는 Sites starter 지침에 따라 migration을 적용한다. 모델의 입력·출력과 Python 일치 검증은 [SERVING.md](SERVING.md), 클라우드 정기 작업은 [운영 절차](public/CLOUD_OPERATIONS.md)를 참고한다.

`SAFENIGHT_SDOT_API_KEY`, `SAFENIGHT_COLLECT_AUTH_TOKEN`은 Sites 비밀 설정으로만 저장한다. 내부 쓰기 API는 Site 접근 권한 외에 별도 운영 토큰도 요구한다. 토큰을 브라우저 코드·저장소·호스팅 manifest·일정 프롬프트에 넣지 않는다.
