# SafeNight - Sites 클라우드 실행본

SafeNight의 지도 서버입니다. Sites에서 장소를 검색하고 D1의 센서 관측을 읽어 점수를 계산합니다. 원본 파일은 R2에 보관합니다.

## 공개 조회 API

| 경로 | 역할 |
|---|---|
| `GET /api/places?q=잠실역` | Photon / OpenStreetMap 실제 장소 검색. 제출 시에만 요청 |
| `GET /api/map` | DB에 게시된 센서 관측과 각 센서의 기존 모델 추론 |
| `GET /api/assessments/location?lat=…&lon=…` | 선택 좌표 주변 센서 가중 참고값과 반경 1km 시설 정보 |
| `GET /api/assessments/:sensor_id` | 센서 단위 추론 |
| `GET /api/population?lat=…&lon=…` | 공식 구역의 추정 인구 범위·혼잡도·관측 시각 |

사용자가 검색을 제출하면 Photon에 요청합니다. 역명은 철도역을 먼저 찾고, 같은 검색의 동시 요청은 하나로 합쳐 결과를 최대 24시간 캐시합니다. `SAFENIGHT_PLACE_SEARCH_URL`로 Photon 호환 서버를 지정할 수 있습니다. 지도에는 OpenStreetMap 출처를 표시합니다. [Photon 공개 서버 사용 조건](https://github.com/komoot/photon)

장소 점수는 반경 **1,500m** 안의 유효 센서 중 가까운 **최대 8개**를 사용합니다. 원시 가중치는 `1 / max(25, distance_m)^2`이며, 합이 1이 되도록 정규화해 센서별 점수·조도·소음을 합칩니다. 선택 좌표는 바꾸지 않습니다. 30시간을 넘긴 관측, 결측, 모델 지원 밖의 센서는 제외하고 근거가 없으면 점수는 `null`입니다.

랜덤 포레스트는 평균 조도(`lux`)와 평균 소음(`noise_db`)을 사용합니다. 시설 설치 기록과 구역 인구는 응답에 `score_included:false`로 표시합니다. [입출력 규격](SERVING.md) · [모델 교체 절차](../docs/model-replacement.md)

## 저장과 게시

- **S-DoT:** 원문 R2 보존 → 형식·시간·페이지 검증 → D1 staging → 전체 완료 후 현재값·checkpoint 원자적 게시. 한 요청은 최대 200행이며 durable cursor로 재개합니다.
- **시설:** 송파구 조명·서초구 보안등·양 구 CCTV 네 원천의 원문·조회 이력·스냅샷을 보존합니다. 네 원천이 모두 유효한 작업만 현재 스냅샷을 교체하고, 무변경 여부와 확인 시각을 따로 기록합니다.
- **인구:** R2 원문 보존 → 구역·시각·범위 검증 → D1 불변 관측 이력·현재 캐시 저장 → 응답. 새 관측 저장에 실패하면 그 숫자를 현재 자료로 게시하지 않습니다.
- 모든 원천에서 관측 시각·기준일·조회 시각을 구분합니다. 데이터가 추가돼도 자동 재학습하지 않습니다.

시설은 송파구·서초구의 공개 설치 기록을 검색 지점 반경 1km에서 집계합니다. CCTV는 설치 기록 수와 `카메라대수` 합계를 따로 표시합니다. 기록이 없는 곳은 `null`을 반환합니다.

## 원천과 앱의 갱신 주기

| 자료 | 원천 기준 | 앱 처리 |
|---|---|---|
| S-DoT | 1시간 단위 집계, 지연·보정 가능 | 기존 매일 03:00 Asia/Seoul 일정: 전날·누락 구간·최근 7일 정정 |
| 시설 네 원천 | 수시 갱신, 정확한 게시 시각 미공개 | 매일 03:15 KST GitHub Actions 공개 원천 수집 → 04:00 KST Sites 검증·DB 반영, 두 일정 등록 완료 |
| 구역 인구 | 공식 약 5분 단위 추정 | 새 코드: 121개 구역을 4시간마다 수집 + 조회 시 갱신, D1 10분 캐시와 이력 보존 |
| 센서 위치 | 공개 파일의 버전·배포일 | 새 코드: 매일 02:45 KST 최신 XLSX 확인, 동일 해시 생략·변경 파일 검증·중단 후 재개 |
| 구역 경계 | 공식 공개 파일 | 변경 파일 별도 검증·적재 |

시설의 앱 확인 주기는 일일이며, 원천 파일의 실제 기준일을 현재 날짜로 바꾸지 않습니다. 2026-11-04의 수집·반영과 당시 등록한 일정은 [검증 기록](../backend/VALIDATION.md)의 과거 실행 근거입니다. 새 코드의 인구 정기 수집은 121개 구역을 요청당 최대 3개씩 순회합니다. 4시간 정기 확인과 조회 시 갱신을 병행하며, 30분을 넘은 인구 관측은 계속 지난 자료로 표시합니다. 새 일정의 운영 배포·활성화는 아래 조건을 따릅니다.

인구의 포함 관계는 공식 폴리곤으로 판별합니다. 구역 밖이면 실제 경계까지 최대 250m인 구역만 `NEARBY_AREA`와 거리를 표시하고, 해당 지점의 실제 인구처럼 설명하지 않습니다. 원천 시각이 30분을 넘기거나 대체 자료, 갱신 실패 후 과거 DB 자료이면 `STALE`입니다. 유효한 0은 유지하고 미확보를 0으로 대체하지 않습니다. source의 5분 집계와 앱의 10분 캐시를 구분합니다.

[데이터 출처·기준일·라이선스와 범위](../docs/data-sources.md)를 함께 확인하세요.

## 시설 수집 실행 위치와 검증

Sites Worker에서 정부 파일 호스트로 직접 요청하면 시간 초과가 발생해 수집 실행 위치를 분리했습니다. GitHub Actions가 공식 네 원천을 내려받아 검증하고 `roberYM11/safenight`의 `safenight-facility-data` 브랜치에 공개 자료만 게시합니다. 이 공개 원천 수집 단계에는 Site 운영 토큰이나 서울시 API 키가 필요하지 않습니다. 새 코드의 선택적 D1 callback은 별도로 Secrets를 사용합니다. 기존 직접 수집 `step` 경로는 남아 있지만 운영 미러 경로는 `mirror_step`입니다.

Sites가 읽는 경로는 `https://raw.githubusercontent.com/roberYM11/safenight/safenight-facility-data/`로 고정되어 있습니다. 한 작업에서 첫 manifest를 R2에 고정하고, 네 단계 모두 같은 manifest를 사용합니다. 문서별 공식 URL·다운로드 연결·SHA-256·크기·형식을 재검증합니다. manifest 수집 시각은 작업일과 같은 한국 날짜여야 하며 36시간 최대 경과·5분 미래 오차 한도도 별도로 검사합니다. 수집 지연이나 실패로 전날 파일만 남으면 당일 성공으로 처리하지 않습니다.

CSV와 다운로드 응답 JSON은 원문입니다. 포털 메타데이터와 다운로드 페이지는 필요한 필드만 추출한 문서이며, manifest의 `representation`·`original_sha256`·`sha256`으로 구분합니다. Worker가 검증하는 SHA는 전달받은 문서의 해시이고, 추출 문서의 `original_sha256`은 수집기가 기록한 원문 해시입니다. 추출본을 원래 전체 HTML로 취급하지 않습니다.

네 원천의 검증·저장이 모두 끝나야 현재 스냅샷을 교체합니다. 실패하면 이전 정상 자료를 유지하며, 내용이 같으면 스냅샷을 중복 생성하지 않고 `checked_at`만 갱신합니다. 같은 한국 날짜의 성공 작업은 다시 실행하지 않습니다. 원천 기준일·포털 수정일·수집 시각·검증 완료 시각은 서로 구분합니다.

## 운영자 쓰기 경로와 인증

`/api/internal/collection`은 S-DoT `due → step` 작업을, `/api/internal/context`는 시설 `due → mirror_step` 작업을 처리합니다. 시설 한 단계는 하나의 공개 원천을 처리하고, 네 원천을 완료한 뒤 게시합니다. 자세한 인증·재개 절차는 [S-DoT 운영 안내](public/CLOUD_OPERATIONS.md)와 [시설 운영 안내](public/CONTEXT_OPERATIONS.md)에 있습니다.

`SAFENIGHT_SDOT_API_KEY`는 S-DoT와 서울시 인구 API의 서버 요청에 사용하고, `SAFENIGHT_COLLECT_AUTH_TOKEN`은 내부 쓰기 API에 필요합니다. Site 접근 권한 외에 별도 운영 토큰을 확인합니다. 키·토큰은 Sites 비밀 설정으로만 두며, 브라우저·저장소·호스팅 manifest·일정 프롬프트에 넣지 않습니다.

## 개발·검증

```sh
npm ci
npx tsc --noEmit
node --test tests/*.test.mjs
npm run build
```

Drizzle migration은 DDL만 담으며 기존 적용본을 고치지 않고 새 migration으로 확장합니다. 운영 배포 전에 추가 테이블을 적용해야 합니다. 원문과 관측 이전은 인증된 운영자 import 경로로 처리합니다. 로컬 D1 미리보기는 Sites starter 지침에 따라 migration을 적용합니다.

2026-11-04 클라우드 시험 179개·타입 검사·Worker 빌드, 원격 cloud·frontend CI가 통과했습니다. [GitHub 시설 수집 실행 41836099458](https://github.com/roberYM11/safenight/actions/runs/41836099458)과 운영 DB 네 단계 반영도 확인했습니다. 기존 Python CI의 DB 드라이버·시간대 의존 시험도 수정해 원격 시험 77개를 통과했습니다. [당시 실행 기록](../backend/VALIDATION.md)

## 공개 후 계산·고정 학습·모델 전환 코드 (2026-11-05)

새 파이프라인은 `0004_pipeline_lineage.sql` 이후 사용합니다. 관측 공개와 후속 작업을 같은 batch로 기록하고, 작업자는 20행씩 피처·예측 결과를 저장합니다. bootstrap 이후 지도·센서 조회는 활성 모델 버전의 결과를 재사용하며, 최신성은 매 요청 다시 검사합니다. 지점 보간에는 실제 예측 ID와 가중치가 남습니다.

`/api/internal/pipeline`은 기존 수집 토큰으로 보호됩니다. 외부 정답 등록 → 해시로 고정한 데이터셋 → Python 학습 → Worker의 센서·시간·격자 평가 → 명시적 승인·generation 전환 경로를 제공합니다. 정답이 없으면 학습을 보류합니다. 기준 모델보다 나쁘거나 검증이 부족한 후보를 승인하지 않습니다. 시설·인구는 현재 모델 입력에 포함하지 않습니다.

GitHub Actions의 S-DoT 정기 실행, 시설 게시 직후 D1 callback, 주간 후보 학습을 추가했습니다. 새 callback 단계에서만 운영 토큰을 GitHub Secrets로 전달하며, 공개 원천 파일 수집에는 서울시 API 키가 필요하지 않습니다. **마이그레이션·사이트 배포·Secrets 설정 후 `SAFENIGHT_PIPELINE_ENABLED=true`를 설정해야 새 일정이 실행됩니다.**

상세 관계·제약·적용 순서·검증 범위는 [DB와 파이프라인 보정 문서](../docs/database-structure.md), [전체 컬럼](../docs/database-columns.csv), [외래키](../docs/database-foreign-keys.csv)에 있습니다.

추가된 정기 수집 연결은 다음 명령으로 수동 실행할 수도 있습니다. 위치 정규화에는 `backend`의 잠금 의존성이 필요합니다. 운영 토큰은 환경 변수로 전달하며 명령 인자·로그에 기록하지 않습니다.

```sh
node scripts/sync-locations.mjs
node scripts/pipeline-client.mjs population
```

위치는 서울시 공식 목록의 최신 파일명·수정일·다운로드 식별자를 확인하고, 검증한 같은 SHA의 성공 작업은 재적재하지 않습니다. 이전 파일의 중간 작업과 다른 파일을 섞지 않으며 새 Worker의 `sync_locations` 계약이 없는 배포 대상에는 적재를 시작하지 않습니다. 인구 실행기는 전체 구역·순서를 확인하고 하나라도 실패한 경우 성공으로 보고하지 않습니다. [위치 검증](../docs/evidence/location-qa.txt) · [인구 검증](../docs/evidence/population-qa.txt)

2026-11-05 추가 코드의 로컬 검증은 Cloud 217개·백엔드 81개 시험과 타입·정적 검사·빌드를 통과했습니다. [이번 실행 기록](../docs/evidence/final-checks.txt)은 앞의 11월 4일 운영 기록과 구분합니다.
