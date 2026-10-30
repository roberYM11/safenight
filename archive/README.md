# 원본 기록과 원시 데이터 재대조

노트북 기록은 사용자가 제공한 원본 사본이다. `original_model.ipynb`는 기존 열 이동과 기존 목표값에 기반한 기록을 보존한다. 최신 실행 진입점은 `../src/train.py`다. 개인 보관 링크와 파일 ID는 공개 저장소에 적지 않았다.

`deep_audit.py`는 원시 센서·위치·기존 중간CSV를 대조해 6열 이동과 복원 후보를 재구성한다. 해당 스크립트 옆 `sources/` 폴더를 만들고 원본 Drive에서 아래 이름으로 파일을 준비한다. sources는 대용량 원본이며 Git에는 포함하지 않는다.

| 로컬 파일명 | 원본 보관 위치 |
| --- | --- |
| raw_sdot.csv | 개인 보관 원본 |
| raw_locations.xlsx | 개인 보관 원본 |
| SDot_and_Loc.csv | 개인 보관 원본 |
| test_SDOT_ALL.csv | 개인 보관 원본 |
| securitylights.csv | 개인 보관 원본 |
| streetlights.csv | 개인 보관 원본 |

```bash
uv run archive/deep_audit.py
uv run archive/model_diagnostics.py
uv run archive/facility_audit.py
```

`deep-audit/`는 스크립트가 생성한다. 기존 단일 시드6개 진단과3,240행 결과는 역사적 비교이며 새3,230행·5-fold 실험과 구분한다. 재복원한 `archive/deep-audit/corrected_inputs.csv`를 `src/prepare.py`에 넣어 최종 입력을 만들 수 있다. 원본 다운로드·권한과 이용 조건은 사용자 계정과 배포 페이지를 따른다.
