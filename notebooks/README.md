# 분석 노트북 실행 방법

저장소 루트에서 아래 명령을 실행한 뒤 Jupyter에서 같은 Python 환경을 선택한다. 두 노트북은 `notebooks/data/`의 CSV를 읽고 결과를 `docs/notebook-results/`에 저장한다.

```sh
uv venv --python 3.11
uv pip install -r notebooks/requirements.txt
```

## 데이터 병합

2026년 11월 3일의 센서 관측을 위치 목록과 연결했다. CCTV 설치 기록은 완전히 같은 10행을 지우고 원본 행 번호를 남겼다. 어느 단계에서 관측이 빠졌는지는 병합 결과의 `filter_rows`에서 볼 수 있다. [병합 노트북](safenight-data-integration.ipynb) · [입력 파일과 해시](data/merge/manifest.json) · [병합 결과](../docs/notebook-results/merge-quality.json)

## RF·PDP 점수 비교

이 실험은 2025년 10월 12일의 기존 분석 자료를 사용했다. 원래 결과를 재현하려고 입력과 목표 점수가 같은 중복 583행, 위도와 경도가 뒤바뀐 11행도 남겼다. 학습·보정·평가에 같은 좌표가 들어가지 않게 나눴다. 시설 곡선은 학습 좌표에서 구했고, 보정 좌표에는 가로등이 기록된 곳이 없어 가로등 계수를 1로 고정했다. [RF·PDP 노트북](safenight-pdp-score-research.ipynb) · [모델별 오차](../docs/notebook-results/results.csv) · [실행 환경과 입력 해시](../docs/evidence/notebook-qa.json)
