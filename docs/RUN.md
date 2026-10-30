# 실행과 재현

## 바로 사이트 열기

저장소를 받은 뒤 최상위 SafeNight 폴더에서 실행한다.

```bash
python3 -m http.server 8765 --bind 127.0.0.1 --directory site
```

Windows는 `py -m http.server 8765 --bind 127.0.0.1 --directory site`. 브라우저주소는 http://127.0.0.1:8765. 기본 포트가 사용 중이면8766으로 변경한다. 서버를 종료하려면 해당 터미널에서 Ctrl+C. 새로 실행할 때도 같은 명령을 쓴다.

API 키 없이 저장된 3,230개 관측과 5-fold OOF 예측을 읽는다. 배경지도는 OSM에서 네트워크로 가져오고 화면에 출처를 표시한다. 타일 연결이 실패하면 안내가 나오며 관측 원과 지점 선택은 로컬 파일로 계속 작동한다.

## 분석 재생성

Python 3.12 이상과 uv를 사용한다. 첫 실행 때 패키지를 내려받는다.

```bash
uv run src/prepare.py data/intermediate/restored_candidates.csv
uv run src/train.py
uv run --with pytest pytest -q
```

스크립트별 PEP 723에 numpy 2.3.5와 scikit-learn 1.9.0을 명시했고 pyproject.toml과 uv.lock도 포함했다. 준비 스크립트는 좌표 제외 CSV와 중복을 정리한 입력을 만든다. 학습 스크립트는 4개 모델을 5개 폴드에서 평가하고 사이트 CSV·JS·최종 joblib을 함께 갱신한다. 재생성 후 브라우저를 새로고침해 파일을 다시 읽는다.

## API를 다시 연결할 때

`API_RECOVERY.md`의 공식 발급 페이지·필드 대응·중복 규칙을 먼저 확인한다. 인증키는 .env나 서버 환경변수로 관리한다. 클라이언트 HTML·JS나 공개 GitHub 파일에는 넣지 않는다. 새 API 응답의 관측 시각과 위치·입력 범위를 확인한 뒤 수집·캐시·결측 상태를 연결한다. 사이트의 관측 날짜 표시도 새로운 자료에 맞춰 갱신한다.
