# 검증 방법과 결과

검증 대상은 입력 관측, 좌표별 평가 분할, 저장된 예측값입니다. 실험 조건은 [METHOD.md](METHOD.md), 입력 범위는 [DATA.md](DATA.md)에 정리했습니다.

## 코드와 데이터

- `uv run src/prepare.py data/intermediate/restored_candidates.csv`는 복원 후보에서 좌표 범위를 검사하고 같은 센서·시각의 반복을 정리합니다. 제외된 센서 2개의 11개 행은 `data/processed/excluded_coordinates.csv`에 남아 있습니다.
- 최종 표본은 3,230개 관측 행, 652개 좌표입니다.
- `uv run src/train.py`는 처리된 입력에서 OOF 예측, 비교 수치, 모델 파일, 화면용 데이터를 생성합니다.

좌표 단위 GroupKFold 5개 폴드에서 Random Forest의 결과는 RMSE 0.8849, MAE 0.3505, R² 0.9912입니다. [저장된 OOF 예측](../data/processed/predictions.csv)으로 세 지표를 다시 계산하면 [benchmark.json](../results/benchmark.json)의 값과 소수점 여섯 자리 이내에서 일치합니다. 모든 좌표는 한 평가 폴드에만 속하며, 입력 파일의 SHA-256도 결과 파일의 기록과 일치합니다. 이 값은 실제 범죄 확률의 정확도가 아니라, 프로젝트가 정의한 규칙 지수를 모델이 얼마나 재현하는지를 나타냅니다.

## 화면 기록

기존 화면 점검의 캡처는 [screenshots/](screenshots/)에 보관했습니다. 화면 캡처와 모델 수치 검증은 서로 다른 증거이며, 캡처만으로 검색·위치 권한·지도 통신의 모든 동작을 확인할 수는 없습니다.

## 해석 범위

현재 화면은 2025년 10월 12일의 저장된 관측 표본을 탐색합니다. 서울시 API의 실시간 재연결은 별도 작업이며, 현재 결과를 실제 위험 발생 확률이나 경로 추천으로 해석하지 않습니다.
