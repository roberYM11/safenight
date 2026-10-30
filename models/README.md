# 학습 모델

`uv run src/train.py`를 실행하면 전체3,230행으로 학습한 `random_forest.joblib`이 생성됩니다. 약6MB 바이너리는 Git 저장소에서 제외하고 코드와 고정 입력으로 재생성합니다. 로컬 최종 ZIP에는 생성한 모델을 함께 담았습니다.

모델 입력순서는 `src/scoring.py`의 FEATURES입니다. 학습모델을 불러올 때는 같은 scikit-learn·numpy 버전을 사용하고 자신이 생성한 파일만 읽으세요. 지도 사이트에는 좌표분리 OOF 예측값을 별도로 저장했습니다.
