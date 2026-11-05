# 파이프라인과 DB 구조

원본 파일은 R2에 보관하고, 어느 파일에서 어떤 관측과 점수가 나왔는지 D1에 기록했다. D1은 33개 테이블과 238개 컬럼으로 구성했다. [스키마](../cloud/db/schema.ts) · [마이그레이션](../cloud/drizzle/0004_pipeline_lineage.sql) · [전체 컬럼](database-columns.csv) · [외래키](database-foreign-keys.csv)

## 수집에서 학습까지

[![수집·조회 파이프라인](assets/pipeline-collection.png)](assets/pipeline-collection.png)

수집 단계에서는 관측값이 정정되기 전의 기록, 시설 자료의 버전, 구역별 인구의 관측 시각을 보존한다. [수집·조회 ERD](#수집조회-erd)

[![학습·모델 교체 파이프라인](assets/pipeline-training.png)](assets/pipeline-training.png)

Python 학습 작업은 고정한 자료를 읽고 후보 모델을 만든다. Worker는 평가를 통과하고 운영 승인을 받은 버전으로 센서 점수를 다시 계산한다. [학습·예측 ERD](#학습예측-erd) · [실행 API](../cloud/app/server/pipeline/http.ts) · [센서 점수 재계산](../cloud/app/server/pipeline/derive.ts)

## 테이블 관계

`PK`는 기본키, `FK`는 D1 외래키다. 실선은 부모 키가 자식 기본키에도 속하는 관계다. R2 파일은 D1의 `object_key`로 찾고 해시로 검증한다.

### 수집·조회 ERD

수집 그림의 세 저장소 박스에 대응한다. 관측과 위치는 `observation_revisions.source`로 구분하고, 같은 센서의 특정 측정시각마다 사용할 수정본을 선택한다.

```mermaid
erDiagram
    raw_objects ||..o{ observation_revisions : raw_sha
    observation_revisions ||..o{ current_observations : revision_id
    observation_revisions ||..o{ feature_snapshots : "관측과 위치 수정본"
    context_snapshots ||..o{ context_current : snapshot_id
    population_raw_objects ||..o{ population_observations : raw_sha256
    population_observations ||..o{ population_cache : observation_id
    raw_objects {
        text sha256 PK
        text object_key
    }
    observation_revisions {
        text id PK
        text source
        text entity_id
        text observed_at
        text raw_sha FK
        text payload_json
    }
    current_observations {
        text source PK
        text entity_id PK
        text observed_at PK
        text revision_id FK
    }
    context_snapshots {
        text id PK
        text object_key
        text artifact_sha256
    }
    context_current {
        text scope PK
        text snapshot_id FK
    }
    population_raw_objects {
        text sha256 PK
        text object_key
    }
    population_observations {
        text id PK
        text area_code
        text observed_at
        text raw_sha256 FK
    }
    population_cache {
        text area_code PK
        text observation_id FK
        text expires_at
    }
```

원문 응답은 R2에, 원문의 해시·주소는 D1의 `raw_objects`·`population_raw_objects`에 저장한다. 시설 실제 데이터도 `context_snapshots.object_key`의 R2 파일에 있다. `feature_snapshots`는 아래 ERD에서 관측 수정본과 위치 수정본을 각각 참조한다. 시설·인구에서 현재 피처로 직접 연결되는 FK는 없다.

### 학습·예측 ERD

학습 그림의 고정 데이터 → Python 학습 → 모델·활성 버전 → 재계산 결과에 대응한다. 이름이 같은 `feature_snapshots`가 앞의 수집 ERD와 연결점이다.

```mermaid
erDiagram
    data_releases ||..o{ feature_snapshots : data_release_id
    data_releases ||..o{ dataset_snapshots : data_release_id
    feature_snapshots ||..o{ target_values : feature_snapshot_id
    target_definitions ||..o{ target_values : target_version
    target_definitions ||..o{ dataset_snapshots : target_version
    dataset_snapshots ||..o{ training_runs : "데이터와 버전 고정"
    training_runs |o..o{ model_artifacts : "학습 모델 산출"
    model_artifacts ||..o{ model_activations : model_version
    model_activations ||..o| active_models : "활성 이름과 세대"
    feature_snapshots ||..o{ prediction_results : "입력과 버전"
    model_artifacts ||..o{ prediction_results : "모델과 입력 버전"
    data_releases ||..o{ point_assessments : data_release_id
    point_assessments ||--o{ point_contributors : assessment_id
    prediction_results ||--o{ point_contributors : prediction_id
    data_releases {
        text id PK
        text manifest_object_key
        text manifest_sha256
        text available_cutoff
    }
    feature_snapshots {
        text id PK
        text entity_id
        text as_of
        text data_release_id FK
        text observation_revision_id FK
        text location_revision_id FK
        text feature_version
    }
    target_definitions {
        text version PK
        text kind
        text definition_object_key
    }
    target_values {
        text id PK
        text feature_snapshot_id FK
        text target_version FK
        real value
        text available_at
    }
    dataset_snapshots {
        text id PK
        text data_release_id FK
        text target_version FK
        text feature_version
        text object_key
        text sha256
    }
    training_runs {
        text id PK
        text dataset_id FK
        text feature_version FK
        text target_version FK
        text metrics_json
    }
    model_artifacts {
        text version PK
        text training_run_id FK
        text feature_version FK
        text target_version FK
        text object_key
        text digest
    }
    model_activations {
        text name PK
        integer generation PK
        text model_version FK
        text previous_version FK
    }
    active_models {
        text name PK, FK
        integer generation FK
        text model_version FK
    }
    prediction_results {
        text id PK
        text feature_snapshot_id FK
        text feature_version FK
        text model_version FK
        real score
    }
    point_assessments {
        text id PK
        text data_release_id FK
        real lat
        real lon
        real score
    }
    point_contributors {
        text assessment_id PK, FK
        text prediction_id PK, FK
        real distance_m
        real weight
    }
```

`training_runs → dataset_snapshots`는 ID와 입력·목표 버전을 함께 묶은 **복합 FK**다. 모델의 학습 실행, 예측의 피처·모델, 활성 모델의 이름·세대·모델도 복합 FK로 맞춘다. 기존 번들 모델은 학습 실행이 없어 `training_run_id`가 NULL일 수 있다. 전환 이력의 `previous_version`도 같은 모델 테이블을 참조하지만 최초 전환에는 NULL을 허용한다. 지점 보간 결과는 `point_contributors`에 실제 센서 예측 ID·거리·가중치를 남긴다.

데이터셋에 포함한 피처·정답 목록과 지점별 시설 스냅샷은 R2 파일에서 참조한다. D1은 고정한 JSON의 주소와 해시를 저장한다. [외래키 목록](database-foreign-keys.csv) · [컬럼 목록](database-columns.csv)

기존 17개는 수집 9개(`collection_jobs`, `raw_objects`, `observation_revisions`, `current_observations`, `latest_observations`, `job_revisions`, `job_pages`, `source_checkpoints`, `operation_guards`), 시설 5개(`context_snapshots`, `context_current`, `context_refresh_jobs`, `context_raw_documents`, `context_staged_sources`), 인구 3개(`population_raw_objects`, `population_observations`, `population_cache`)다.

| 추가 테이블 | 한 행의 단위와 핵심 관계 |
|---|---|
| `observation_publications` | 공개 배치. 증가하는 sequence, 실제 공개 단계의 시각, 수집 작업 FK. 업그레이드 baseline은 별도 origin |
| `observation_selections` | 배치 × 원천 × 센서 × 측정시각. 그때 선택된 수정본 FK |
| `derivation_jobs` | 종류 × 입력 버전 UNIQUE. 공개 배치 또는 모델 FK, 임대·시도 횟수·오류·재개 커서 |
| `data_releases` | 봉인한 R2 manifest 주소·해시와 사용 가능 cutoff |
| `feature_snapshots` | 관측/위치 수정본 쌍 + 피처 버전으로 만든 ID. 관측과 위치를 각각 FK로 보존 |
| `target_definitions` | 목표의 종류·설명·규칙 버전·출처 이름으로 고정한 목표 정의 |
| `target_values` | 피처 수정본 × 목표 버전 UNIQUE. 정답값·목표시각·시스템 등록시각·고정 파일 참조 |
| `dataset_snapshots` | 정확한 학습 행과 정답을 담은 R2 JSON의 주소·해시·분리 정책·표본 수 |
| `training_runs` | 학습 실행. dataset/입력/목표 버전 복합 FK, code SHA·seed·설정·평가 결과·상태 |
| `model_artifacts` | 모델 버전·숫자 트리 파일·해시·학습 실행·승인 기록. 기존 배포 번들은 origin=bundled 예외로 구분 |
| `model_activations` | 모델 이름 × generation PK. 이전 모델·사유·담당자·시각을 남기는 전환 이력 |
| `active_models` | 모델 이름별 활성 generation. 전환 이력의 이름/세대/모델 복합 FK |
| `prediction_results` | feature × model × policy UNIQUE. 피처와 모델의 입력 버전도 복합 FK로 일치시킴 |
| `point_assessments` | 지점·평가시각·정책·release별 보간 결과 |
| `point_contributors` | 지점 결과 × 실제 센서 예측 결과 PK. 거리와 정규화 가중치 |
| `population_request_leases` | 구역별 외부 요청 임대와 다음 허용 시각. 여러 isolate가 공유 |

## 공개 시점과 정정 처리

시간은 UTC `YYYY-MM-DDTHH:mm:ss.sssZ`로 정규화한다.

| 시각 | 의미 |
|---|---|
| `observed_at` | 측정 또는 위치 적용 시각 |
| `published_at` | 원천 발표·정정 시각 |
| `ingested_at` | 시스템에 수집한 시각 |
| `observation_publications.available_at` | 페이지 검증을 마치고 공개 batch에 진입한 시스템 시각 |
| 피처 `as_of` | 피처의 관측 기준시각 |
| `available_cutoff` | 입력 선택에 허용한 공개시각 상한 |
| 정답 `available_at` | 외부 정답을 시스템에 등록한 시각. 과거 시각으로 소급하지 않음 |

수집 완료에서는 임대 검사 → current/latest 선택 → 공개 기록·선택 이력 → 후속 계산 작업 → checkpoint·성공 상태가 같은 D1 batch에 들어간다. 후속 작업 저장에 실패해도 공개 포인터가 함께 롤백된다. 요청을 재전송해도 같은 성공 작업의 공개·후속 작업은 하나다. 수집 시작 전에 잡은 시각을 공개시각으로 재사용하지 않도록 실제 수집 API에 별도 공개 clock을 연결했다.

`readSensorsAt()`은 cutoff까지 공개된 선택 이력만 읽는다. 동일 밀리초의 공개는 sequence로 구분한다. 정정 전 cutoff에는 정정 전 관측과 위치가 선택된다. 공개 이력을 기록하기 전의 실제 과거 공개시각은 추정하지 않는다.

업그레이드 시 보호된 `bootstrap`이 **그 시점의** current 포인터를 baseline으로 한 번 기록한다. 기존 자료는 그 baseline부터 재현할 수 있다. 이전 수집시각을 이용해 과거의 공개 완료를 소급 증명하지 않는다. 운영 조회는 기존 current/latest 포인터를 계속 사용한다.

## 후속 계산과 조회

후속 작업은 120초 임대와 조건부 batch로 소유권을 확인하고, **20행씩** 저장한다. DB에 원천 키 커서·처리 행 수가 남는다. 작업자가 중단되면 임대 만료 후 이어 가며, 실제 실패를 관찰하면 임대를 풀고 오류 코드를 남긴다.

S-DoT 공개는 해당 관측 키를 계산한다. 위치 정정은 같은 센서의 영향을 받는 관측을 공개 sequence 기준으로 다시 연결한다. 먼저 페이지 키를 제한한 뒤 인덱스로 관측·위치 수정본을 선택하므로 매 행마다 전체 이력의 순위를 다시 계산하지 않는다. 미위치 관측은 release에 남지만 점수를 만들지 않는다.

피처 ID는 기존 API의 `feature_revision`과 같은 관측 ID·위치 ID·피처 버전 해시다. 같은 입력을 재확인해도 피처와 결과가 중복되지 않는다. 점수는 모델의 정적 지원 조건에 대한 결과로 저장하고, 응답 시에는 현재 시각에 대한 30시간 만료를 다시 검사한다. 저장된 점수가 있다는 이유로 오래된 관측을 현재 값처럼 반환하지 않는다. 새 피처의 계산이 아직 끝나지 않았으면 `DATA_UNAVAILABLE`과 null을 반환한다.

bootstrap 이후 지도·센서 조회는 활성 모델의 저장 결과를 읽는다. 센서 단건 API는 해당 센서만 조회한다. 지점 보간에서는 실제 사용한 예측 ID·거리·가중치를 저장한다. 아직 bootstrap하지 않은 전환 기간에만 기존 번들 직접 계산을 유지한다. 활성 포인터가 있는데 파일이 없거나 해시 검증이 실패한 경우에는 번들로 조용히 돌아가지 않는다.

## 정답과 고정 학습 데이터

학습하려면 피처마다 목표 점수가 필요하다. 현재 파이프라인은 외부에서 계산한 규칙 점수를 등록해 사용한다. [목표 점수의 산식](scoring-and-serving.md)

운영자는 보호된 `labels` 명령으로 피처 ID, 점수, 목표 시각과 정의를 등록한다. 목표 시각은 관측 시각과 일치해야 한다. 정정할 때는 새 목표 버전을 등록한다. 제공자는 원본의 출처와 해시를 기재하고, API는 등록받은 정의와 값을 JSON으로 저장해 해시를 검사한다.

데이터셋 생성은 공개 이력상 선택된 정확한 관측·위치 쌍과 등록 정답만 연결한다. 최신 정정본의 정답이 없으면 이전 정답으로 대체하지 않는다. 파일에는 각 피처·정답 ID, 입력값, 원천 release, 목표 버전·값·시각, 입력·정답 사용 가능 시각이 들어간다. 파일 내용의 SHA-256이 dataset ID다. 같은 내용·코드의 완료 학습을 반복 예약하지 않으며, 정답이 없으면 `labels_unavailable`로 종료한다.

데이터셋은 최대 10,000행까지 내보낸다. 한도를 넘으면 오류를 반환한다.

## 학습·검증·승인·전환

`train-pipeline.mjs`가 인증된 API에서 고정 파일을 내려받아 해시를 확인한 뒤, 잠금된 Python 프로젝트 환경에서 `train_pipeline.py`를 호출한다. Python은 DB나 인증 토큰을 읽을 필요가 없으며, 현재 RF 설정을 유지해 최종 모델과 분리 평가용 모델들을 내보낸다. Worker는 전달된 점수를 신뢰하지 않고 평가 모델을 고정 정답에 적용해 MAE·RMSE를 다시 계산한다.

`seed=42`, `sensor-time-region-v1`의 분리 규칙은 다음과 같다.

- 센서: 센서 ID의 안정된 해시 순서로 20% 센서를 평가에 배정. 센서 중복 금지.
- 시간: 마지막 UTC 관측일 평가. 이전 입력·정답이 첫 평가시점까지 실제로 사용 가능해야 학습에 포함.
- 지역: 위경도 0.02도 격자를 같은 방식으로 분리. 동일 격자의 학습/평가 중복 금지.

서버는 임의로 쉬운 행만 선택하지 못하도록 정확한 분리 소속과 평가 모델의 학습 위치·센서 목록도 확인한다. 세 평가가 모두 있어야 하고, 각 평가에서 학습 100행·5센서 이상, 평가 30행·2센서 이상이 필요하다. 후보의 MAE와 RMSE가 학습 평균·중앙값 기준의 더 좋은 값보다 모두 작아야 한다. 최종 입력 지원률은 95% 이상이며, 기존 모델과 공통 지원되는 평가 행에서는 오차가 악화되면 안 된다. 기존 모델 비교가 가능한 행 수와 각 지표도 남긴다.

정기 학습은 후보 등록에서 끝난다. 평가를 통과한 후보만 운영자가 승인해 전환할 수 있다.

`approve`는 평가 당시의 운영 모델이 아직 같은지 확인한다. `activate`는 예상 generation과 승인 상태를 batch 안에서 다시 검사하고, 전환 이력·활성 포인터·재계산 작업을 함께 기록한다. 같은 generation을 두 실행기가 교체하면 하나만 성공한다. 복귀도 새 generation을 만들며, 동일 모델로 돌아와도 이전 재계산 작업과 충돌하지 않는다. 요청은 한 번 읽은 모델 버전과 입력을 고정한다.

## 정기 실행과 시설·인구 경계

- S-DoT: [`collect-sdot.yml`](../.github/workflows/collect-sdot.yml), 매일 18:00 UTC = 다음 날 03:00 KST. 기존 due/step과 7일 정정 재확인 후 후속 작업을 소비한다.
- 시설 수집은 기존 데이터 브랜치에 게시한 뒤 callback을 호출한다. 네 단계가 끝나고 현재 스냅샷과 게시 파일의 manifest 해시가 일치하면 완료한다. 같은 날 다른 manifest가 이미 적용됐다면 불일치 오류를 반환한다.
- 학습: [`train-model.yml`](../.github/workflows/train-model.yml), 일요일 19:30 UTC = 월요일 04:30 KST. 미처리 피처를 정리한 뒤 고정 데이터로 학습하며, 정답이 없으면 보류한다. 수동 실행의 `promote`를 선택한 경우에만 통과 후보를 승인·전환한다.
- 인구 수집 작업은 서울시 121개 구역을 4시간마다 조회하도록 구성했다. 같은 구역을 동시에 요청하면 D1 임대로 한 요청만 허용한다. 성공·실패 모두 10분 요청 제한을 둔다. [수집 일정](../.github/workflows/collect-population.yml)
- 센서 위치는 매일 02:45 KST에 공식 목록에서 최신 XLSX를 확인한다. 적용일과 해시로 변경을 판단하고, 중단된 파일은 마지막 처리 페이지부터 이어 받는다. [위치 동기화](../.github/workflows/sync-locations.yml)

새 정기 작업은 GitHub 변수 `SAFENIGHT_PIPELINE_ENABLED=true`로 활성화한다. 수집 인증에는 `SAFENIGHT_COLLECT_AUTH_TOKEN`을 쓰고, 사이트 접근 제한이 있으면 `SAFENIGHT_SITE_BYPASS_TOKEN`을 GitHub Secrets에 추가한다.

## 적용 순서와 검증

1. 운영 D1을 백업하고 기존 `0000`~`0003` 뒤에 `0004_pipeline_lineage.sql`을 적용한다. 신규 DDL이며 기존 데이터의 삭제·재작성·초기 데이터 삽입은 없다.
2. 새 서버 코드를 빌드·배포하고 토큰을 설정한다.
3. 보호된 `bootstrap`과 `step` 또는 `node cloud/scripts/pipeline-client.mjs derive`를 실행해 기존 관측의 baseline·피처·결과를 만든다.
4. 결과를 확인한 뒤 GitHub 변수 `SAFENIGHT_PIPELINE_ENABLED=true`를 설정하고 정기 작업과 시설 callback의 실행 이력을 확인한다.
5. 정답의 출처와 의미를 확인해 등록한다. 새 정답이 없다면 수집·계산·품질 확인까지만 운영한다.

R2 업로드는 D1 트랜잭션에 포함되지 않는다. 객체를 먼저 저장하고 다시 읽어 해시를 확인한 뒤 DB 참조를 공개한다. 중간 실패 후 남는 미참조 객체는 재시도 시 재사용할 수 있으며, 자동 삭제 작업은 아직 없다. 참조된 불변 객체를 임의로 덮어쓰거나 삭제하면 안 된다. D1 batch의 원자성은 [Cloudflare 공식 설명](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)을 따른다.

로컬 Worker·D1·R2와 임시 PostgreSQL에서 이틀치 합성 자료로 시험했다. 정답 등록부터 학습, 평가, 모델 전환, 센서 점수 재계산과 조회까지 확인했다. 운영 DB 적용과 새 일정 활성화는 배포 단계에 남아 있다.

운영자가 외부 정답을 정확한 수정본에 연결할 때는 인증된 `GET /api/internal/pipeline?features_after=`로 피처 ID·센서·관측시각·관측/위치 수정본을 200개씩 내보낼 수 있다. `next_cursor`를 다음 호출에 전달하고 null이면 끝이다. 정답 정의의 `rule_version`은 생성 의미의 버전이며, 파일마다 달라지는 `source_sha256`은 해당 정답 파일의 출처 기록이다. 파일 해시만 달라졌다고 동일 규칙의 목표 버전이 쪼개지지 않도록 분리했다.

2026년 11월 5일 로컬 시험에서 Cloud 217개와 Python 81개가 통과했다. [검증 기록](evidence/final-checks.txt)

정답 등록은 한 번에 최대 200행이며, 조회와 삽입은 D1 바인딩 수에 맞춰 묶는다. 동시 등록에서 같은 목표 버전·피처에 다른 값이 들어오면 DB의 고유 제약으로 전체 등록을 거부한다. 정답 파일 해시를 바꿔 기존 값을 덮어쓸 수 없다.
