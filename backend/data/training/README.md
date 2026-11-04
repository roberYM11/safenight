# 임시 모델의 학습 자료

`environment_proxy.csv`는 기존 SafeNight의 컬럼 대응을 복원한 관측 자료와 같은 프로젝트의 `predictions.csv`를 `sensor_id,time`으로 일대일 연결한 snapshot입니다. 3,230개 관측, 652개 센서, 2025-10-12의 5개 측정 시각을 포함합니다.

입력은 현재 API에서 가져올 수 있는 조도 평균(lux)과 소음 평균(dB) 두 개입니다. `safety_index`는 `predictions.csv`의 `rule_index`이며 실제 범죄·사고 정답이 아닙니다. `restored_observations.csv`의 `old_target`은 과거 컬럼 대응 오류의 영향을 받은 값이므로 학습하지 않습니다.

원천은 `/Users/yumin/Documents/Codex/2026-10-30/https-drive-google-com-drive-folders/outputs/SafeNight/data/processed/`의 `restored_observations.csv`와 `predictions.csv`입니다. 각 파일과 이 snapshot의 SHA-256은 학습 결과 `manifest.json`에 기록합니다. 기존 점수식은 같은 프로젝트의 `src/safenight/scoring/index.py`에 있습니다. CCTV·가로등·보안등·소음 변동 등을 사용한 원래 10개 입력의 설계 점수를 두 입력으로 근사하므로 누락 변수에 따른 한계가 있습니다.

학습 명령은 `backend/`에서 `uv run scripts/train_random_forest.py`입니다. 전달된 snapshot과 옆의 `environment_proxy.provenance.json`을 읽으므로 기존 프로젝트의 절대 경로가 없어도 재현할 수 있습니다. 원본 두 CSV로 다시 연결하려면 `uv run scripts/train_random_forest.py <기존 corrected data/processed 폴더>`를 실행합니다. API 시작이나 신규 자료 수집은 이 명령을 실행하지 않습니다.

RandomForestRegressor는 114개 트리, 깊이 최대 18, leaf 최소 관측 3개, seed 42를 사용합니다. 센서 ID를 기준으로 20% holdout을 먼저 평가하고, 최종 모델은 전체 snapshot에 적합합니다. 동일 센서가 평가 학습과 평가 테스트에 동시에 들어가지 않습니다.

서빙은 같은 센서 ID, 학습 좌표에서 250m 이내, 학습 입력 범위(조도 0–467 lux, 소음 35–74 dB)에서만 허용합니다. 실제 모델은 실행 가능한 pickle이 아닌 수치 배열 JSON으로 저장하며 로딩 시 digest와 트리 구조를 확인합니다. sklearn과 JSON 추론의 수치 일치 여부를 테스트합니다.
