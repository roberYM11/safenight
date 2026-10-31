# 원본 기록과 원시 데이터 재대조

원본 노트북은 기존 입력과 목표값에 기반한 실험 기록이다. 개인 보관 링크가 담겨 있어 별도 보관 자료로 취급한다. 공개된 현재 실험의 실행 진입점은 [src/train.py](../src/train.py)다. [original_design.drawio](original_design.drawio)는 문제의식과 자료 선택을 정리한 마인드맵이다.

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

`deep-audit/`는 스크립트가 생성한다. 기존 단일 시드 6개 진단과 3,240행 결과는 현재 3,230행·5-fold 실험과 구분한다. `src/prepare.py`는 입력 경로가 필요하다. 프로젝트 루트에서 다음과 같이 실행한다.

```bash
uv run src/prepare.py archive/deep-audit/corrected_inputs.csv
```

공개 저장소의 복원 후보를 사용하려면 입력 경로를 `data/intermediate/restored_candidates.csv`로 지정한다. 원본 자료의 접근 권한과 이용 조건은 보관 계정과 배포 페이지를 따른다.
