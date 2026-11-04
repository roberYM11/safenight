# 모델 교체 안내

모델 구현을 화면·수집·DB와 분리했다. 같은 입력·출력 계약을 유지하는 모델은 해당 어댑터와 모델 파일을 교체해 사용할 수 있다. 새 변수나 다른 예측 대상이 필요하면 원천 수집과 feature 정의도 함께 바꿔야 한다.

현재 점수는 기존 `safety_index`를 재현하는 **실험용 환경 안전도**다. 알고리즘을 교체하는 일만으로 실제 범죄·사고 위험의 타당성이나 성능이 보장되지는 않는다. 새 관측이 DB에 들어와도 자동 재학습하지 않는다.

## Sites 배포본

| 경로 | 역할 |
|---|---|
| `cloud/app/server/data/model.json` | 실행 코드가 없는 RF 숫자 트리 |
| `cloud/app/server/data/manifest.json` | SHA-256·버전·입력·지원 범위·검증 정보 |
| `cloud/app/server/forest.ts` | 모델 로딩·검증·지원 범위·추론 어댑터 |
| `cloud/app/server/serving.ts` | D1 관측·유효 위치를 읽고 지도·개별 평가에 연결 |
| `cloud/tests/serving.test.mjs` | Python 일치와 지원 범위·만료·변조 시험 |

같은 RF 파일 형식과 로더의 검증 계약을 유지할 때는 `model.json`과 `manifest.json`을 한 묶음으로 교체한다. 파일 해시·구조·버전·학습 위치와 범위가 일치해야 로딩된다. 트리 수 등 기존 manifest의 검증 조건을 바꾸면 어댑터의 해당 검증 규칙도 함께 갱신한다. 새 모델의 독립 평가 결과와 fixture를 확인한 다음 Sites의 새 버전을 배포한다. HTTP 요청이나 브라우저에서 모델 코드·파일을 업로드하는 경로는 열지 않았다.

다른 알고리즘으로 바꾸면 `forest.ts`의 어댑터와 필요한 서버 의존성을 변경한다. 지도·API 응답·수집·D1/R2 계약을 유지하면 해당 부분은 그대로 사용할 수 있다. 현재 Workers 런타임과 메모리·실행 제한 안에서 동작하는지도 확인해야 한다. Python 전용 라이브러리를 그대로 사용할 수 있다고 가정하지 않는다.

```sh
cd cloud
npm ci
npx tsc --noEmit
node --test tests/*.test.mjs
npm run build
```

검증한 소스를 Sites의 소스 동기화·패키징·버전 배포 절차로 발행한다. 빌드만 성공한 결과를 운영 배포 완료로 표시하지 않는다. 상세 경계는 [클라우드 서빙 안내](../cloud/SERVING.md)에 있다.

## 로컬 Python 서버

| 경로 | 역할 |
|---|---|
| `backend/src/safenight_backend/model_runtime.py` | 일반 서버가 사용하는 `load_model()` |
| `backend/src/safenight_backend/serving/runtime.py` | 공통 `RuntimeAdapter`와 `ServiceRuntime` |
| `backend/src/safenight_backend/serving/contracts.py` | 입력·출력·정책 계약 |
| `backend/src/safenight_backend/serving/service.py` | 결측·신선도·지원 범위·출력 범위 검사 |
| `backend/src/safenight_backend/rf/runtime.py` | 현재 RF의 위치·관측 지원 범위 |
| `backend/src/safenight_backend/rf/artifact.py` | RF JSON과 해시 검증 |

같은 RF 형식이면 두 모델 파일을 담은 디렉터리를 `SAFENIGHT_MODEL_BUNDLE_DIR`에 지정한다. 기존 스냅샷에서 후보 파일을 내보내는 예시는 다음과 같다.

```sh
cd backend
uv sync --locked
uv run scripts/train_random_forest.py --output var/models/candidate
SAFENIGHT_MODEL_BUNDLE_DIR=var/models/candidate uv run safenight serve
```

이 명령은 기존 학습 자료를 명시적으로 다시 학습하는 작업이다. 새 DB 관측을 자동으로 학습하는 명령이 아니다. 이전 모델 폴더를 보존하고 별도로 평가한 후보만 선택한다. 모델은 시작 시 고정되므로 설정이나 파일을 바꾼 뒤 API 프로세스를 재시작한다.

새 알고리즘은 `Predictor.version`, `Predictor.feature_version`, `predict(FeatureVector) -> float`를 구현하고 `AssessmentService`로 감쌀 수 있다. 검증한 필수 입력·지원 센서·관측 유효 시간을 `ServingPolicy`에 명시하고, `load_model()`이 해당 어댑터를 반환하도록 바꾼다. 필요한 의존성은 `pyproject.toml`과 `uv.lock`에 함께 반영한다.

## 공통 입력·출력

현재 입력 버전은 `environment-v1`이다. 활성 RF 입력은 조도와 소음이며, 센서 ID와 좌표는 지원 범위 확인에 사용한다.

| 필드 | 의미 |
|---|---|
| `sensor_id` | 관측 센서 식별자 |
| `observed_at` | 시간대가 있는 원본 관측 시각 |
| `lat`, `lon` | 유효한 센서 위치 또는 결측 |
| `lux` | 조도 lx 또는 결측 |
| `noise_db` | 소음 dB 또는 결측 |
| `feature_version`, 입력 revision | 계약 버전과 원천·위치 계보 |

결측을 임의의 0으로 채우지 않는다. 현재 RF는 학습 센서와 학습 위치 250m 이내, 학습 관측 범위 안에서만 점수를 낸다. 관측 유효 기간은 30시간이다. 과거 자료 호환 필드가 남아 있더라도 시설 개수나 CCTV 데이터를 현재 모델 입력으로 사용하지 않는다.

출력은 유한한 0~100 점수 또는 `null`, 상태, 관측·평가 시각과 모델·입력·정책 계보를 포함한다. 높은 점수가 높은 환경 안전도를 뜻한다는 화면 의미를 유지한다. 위험도나 확률을 반환하는 새 모델은 의미와 변환을 명시해야 한다.

`MODEL_UNAVAILABLE`, `DATA_UNAVAILABLE`, `STALE`, `SCHEMA_MISMATCH`, `UNSUPPORTED`, `MODEL_ERROR`에서는 점수를 만들지 않는다. 정상 점수 상태는 `SCORED`다. Python의 예상 가능한 추론 실패는 `PredictionError`로 보고하고, 프로그래밍 오류를 임의 점수로 숨기지 않는다.

## 교체 전 확인

```sh
cd backend
uv run ruff check .
uv run basedpyright
uv run pytest -q tests/test_model_runtime.py tests/test_serving.py tests/test_random_forest.py
# 별도 시험 PostgreSQL 주소를 SAFENIGHT_TEST_DATABASE_URL에 지정한 뒤
uv run pytest -q
```

DB 주소를 지정하지 않아 건너뛴 시험을 실제 DB 통합 검증 완료로 간주하지 않는다. 모델이 바뀌면 기존 fixture 통과와 별도로 새 학습 자료·편향·일반화·출력 의미를 평가한다. 가로등 등 새로운 입력이 필요하면 수집원·시간/공간 결합·버전·결측 처리·검증 자료를 함께 변경한다.

## 시설·구역 인구를 추가하는 다음 모델

현재는 시설 스냅샷과 인구 관측 이력을 먼저 보존한다. 시설은 매일 확인하지만 실제 기준일은 2021·2024·2026년으로 서로 다르고, 송파·서초의 부분 자료다. 인구는 요청한 구역만 누적하므로 조회하지 않은 구역·시각의 관측이 있다고 가정하지 않는다. 시설 확인 시각을 설치 시각으로, 인근 구역 인구를 선택 좌표의 인구로 결합하지 않는다.

새 학습에서는 시점별로 당시 이용 가능했던 스냅샷·인구 관측을 연결하고 결측·부분 커버리지를 명시한다. 목표값을 정한 뒤 시간·지역이 분리된 평가 자료로 기존 후보와 비교한다. 새 feature 버전·필수 입력·유효 시간·지원 지역을 선언하고, 자료가 부족한 위치는 점수 생성 대상에서 제외한다. 독립 평가를 통과한 후보만 어댑터와 manifest를 함께 교체하며, 일일 수집 작업에 반복 학습을 넣지 않는다.
