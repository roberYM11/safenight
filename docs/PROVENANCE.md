# 자료와 실험의 계보

원본 프로젝트는 밤길에 대한 불안에서 출발해 조도·소음과 주변 시설을 함께 살펴보려 했다. [마인드맵](../archive/original_design.drawio)에는 공간·시간·이유에 관한 질문과 환경정보·시설 자료를 연결한 흔적이 있다. 비상벨 등 초기 아이디어가 모두 현재 입력에 포함된 것은 아니다.

원본 노트북에는 환경·시설 자료 결합, 직접 정의한 안전도 지수, Random Forest와 Optuna 실험이 남아 있다. 현재 Python 코드는 그 목표식과 나무 설정을 유지한다. 개인 보관 링크가 담긴 원본 노트북은 별도 보관 자료이며, 공개 실행 안내는 [src/train.py](../src/train.py)를 기준으로 한다.

## 입력을 확인한 과정

원시 센서 자료와 기존 가공본의 열 대응을 대조해 조도·소음 입력을 복원했다. 이어 좌표 범위와 동일 센서·시각의 반복 관측을 검사했다. 현재 입력은 [restored_observations.csv](../data/processed/restored_observations.csv)이며, 제외한 좌표 행은 [excluded_coordinates.csv](../data/processed/excluded_coordinates.csv)에 남겼다.

[PROJECT_EVIDENCE.md](PROJECT_EVIDENCE.md)는 원시 자료 대조와 기존 실험 진단을 기록한다. 그 문서의 3,240행 단일 분할 결과와 현재 3,230행·좌표별 5-fold 비교는 서로 다른 실험이다. 현재 비교의 조건과 결과는 [METHOD.md](METHOD.md), [benchmark.json](../results/benchmark.json)에서 확인할 수 있다.

## 설명의 근거

README는 마인드맵의 문제의식, 원본 코드의 계산 방식, 현재 비교 실험을 연결해 설명한다. 작성 당시의 생각 순서나 개인 경험을 확인할 자료는 없으므로 이를 경험담으로 서술하지 않는다. 소음을 사람 활동의 단서로 삼은 가정과 점수의 가중치는 실제 유동인구·범죄·체감 안전 자료로 검증된 관계와 구분한다.
