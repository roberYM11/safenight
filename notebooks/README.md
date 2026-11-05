# 분석 노트북 재현

두 노트북은 입력 파일과 실행 결과를 함께 보존했다. 노트북 폴더 또는 저장소 루트에서 열고 위에서 아래로 실행한다. Python 3.11 이상이 필요하며, 검증한 패키지는 [requirements.txt](requirements.txt)에 고정했다.

```sh
uv venv --python 3.11
uv pip install -r notebooks/requirements.txt
```

Jupyter에서 해당 환경을 선택한다. 노트북은 패키지를 자동 설치하거나 외부 API를 호출하지 않는다. `data/`의 고정 CSV를 읽고 `docs/notebook-results/`에 결과를 저장한다.

| 노트북 | 입력과 단위 | 확인한 결과 |
|---|---|---|
| [데이터 병합](safenight-data-integration.ipynb) | 2026-11-03 관측 24,715행, 2026-03-10 위치 1,170개, 과거 CCTV 기록 | 야간 관측 3,834행·947센서. 관측 키·다대일 결합·미확보 시설의 결측 유지 확인 |
| [RF·블록 PDP](safenight-pdp-score-research.ipynb) | 2025-10-12 연구 입력 3,713행·671좌표, 기존 규칙식 목표 | 학습·보정·평가 좌표 분리. 시설 곡선은 학습 자료에서만 적합. MAE 0.6654→0.4025점 |

병합 입력은 기존 공개 CSV에서 필요한 열만 추출했다. CCTV는 원본의 완전히 같은 10행을 제거한 뒤 원본 행 번호를 보존했다. [원본·추출본 해시](data/merge/manifest.json)를 확인할 수 있다. 연구 입력의 실행 환경·검증 결과는 [노트북 실행 기록](../docs/evidence/notebook-qa.json)에 있다.

두 자료의 날짜와 표본은 다르다. 연구 자료는 원래 분석을 재현하기 위해 입력·표적 중복 583행과 위경도 반전 11행을 유지했다. 실제 지리적 일반화나 현실 안전도를 검증하지 않았다. 가로등이 있는 보정 좌표가 없어 해당 계수는 1로 고정했다. 시설 수 진단 격자는 전체 자료의 고유값을 사용하지만 곡선 적합·계수 추정에는 평가 행을 사용하지 않는다.

2026-11-05 Jupyter MCP에서 Python 3.11.15로 두 공개용 노트북의 모든 코드 셀을 순서대로 실행했다. 기존 커널을 재시작하지 않았고, 공개용 복사본은 개인 PC 경로를 상대 경로로 바꾸어 같은 입력으로 다시 실행했다. [결과](../docs/notebook-results/results.csv) · [병합 품질](../docs/notebook-results/merge-quality.json)
