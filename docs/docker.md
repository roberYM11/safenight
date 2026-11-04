# Docker로 SafeNight 실행

저장소 최상위의 `Dockerfile`과 `compose.yaml`을 사용합니다. Node 빌드 단계에서 사이트를 만들고, Python 빌드 단계에서 저장된 `backend/data/training/environment_proxy.csv`로 RandomForest JSON 모델을 재생성합니다. 실행 이미지에는 사이트와 모델이 모두 포함됩니다. API가 같은 주소에서 화면과 `/api`를 제공하며 PostgreSQL은 별도 컨테이너에 저장됩니다.

## 시작

Docker Engine과 Docker Compose 2.24 이상이 필요합니다. macOS에서는 Docker Desktop 또는 Colima를 사용할 수 있습니다. Apple Silicon에서 Homebrew를 쓰는 경우의 설치 예시는 아래와 같습니다. 이 문서의 명령은 자동으로 실행되지 않습니다.

```sh
brew install colima docker docker-compose
colima start --vm-type=vz --cpu 4 --memory 6
docker compose version
```

Homebrew의 Compose가 플러그인으로 검색되지 않아도 실행 도우미는 `docker-compose` 명령을 자동으로 사용합니다. 직접 `docker compose`를 사용하려면 `brew info docker-compose`가 안내하는 `cliPluginsExtraDirs`를 기존 Docker 설정과 병합합니다. 기존 `~/.docker/config.json`을 덮어쓰지 마세요.

저장소 최상위에서 다음 명령을 실행합니다.

```sh
sh scripts/docker-local.sh
```

사이트: http://localhost:8001

기본 명령은 `up --build -d --wait api`입니다. API와 DB만 시작하며, 기존 로컬 8000 포트의 서버와 분리됩니다. 다른 포트를 쓰려면 `SAFENIGHT_HTTP_PORT=8002 sh scripts/docker-local.sh`를 실행합니다. 최초 빌드는 베이스 이미지와 잠금 파일에 지정된 npm/Python 패키지를 다운로드하므로 인터넷 연결이 필요합니다.

실행 도우미가 임의의 DB 비밀번호를 `backend/var/docker/compose.env`에 생성합니다. 이 파일은 권한을 제한하고 Git 및 Docker 빌드에서 제외합니다. DB 볼륨을 사용하는 동안 이 파일을 보관하세요. 비밀번호를 다시 생성하면 기존 볼륨의 인증 정보와 달라집니다. 직접 Compose를 실행할 경우 URL에 안전한 영문·숫자 비밀번호를 `SAFENIGHT_DB_PASSWORD`로 설정해야 합니다.

기존 `backend/.env`가 있으면 서버 환경 변수로 읽지만 이미지에 복사하지 않습니다. 호스트 전용 DB 주소와 모델·화면 경로는 Compose의 컨테이너 경로로 덮어씁니다. API 키는 브라우저 빌드 인자에 전달하지 않습니다.

## 데이터 수집과 상태 확인

Docker DB는 새로운 별도 저장소입니다. 호스트에서 실행 중인 DB의 관측 자료를 자동으로 복사하지 않습니다. 모델이 등록되어도 센서 관측이 없으면 지도에 실제 안전도를 표시할 수 없습니다. 유효한 API 키를 서버 환경에 설정하고 필요한 자료를 수집해야 합니다.

```sh
sh scripts/docker-local.sh exec api safenight download-locations
sh scripts/docker-local.sh exec api safenight collect sdot --day 2026-11-03
sh scripts/docker-local.sh exec api safenight collect cctv --day 2026-11-03 --full-snapshot
sh scripts/docker-local.sh ps
curl --fail http://localhost:8001/health/ready
```

위 날짜는 예시이며 S-DoT 제공 기간 안의 날짜로 바꿉니다. 수집 원본이 응답하지 않는 경우 가짜 관측값으로 대체하지 않습니다. 모델의 출력은 기존 `safety_index`를 학습한 **실험용 환경 안전도**이며 실제 범죄 위험의 검증된 예측이 아닙니다.

매일 정해진 시간의 수집을 켤 때만 다음을 실행합니다. 이 스케줄러는 영상 분석을 예약 실행하지 않습니다.

```sh
sh scripts/docker-local.sh --profile collection up -d scheduler
sh scripts/docker-local.sh stop scheduler
```

영상 조회는 앱의 사용자 요청으로 실행합니다. CCTV 설치 정보 API만으로 영상 스트림이 제공되는 것은 아니며, 공개 영상 제공처와 이용 가능한 키를 별도로 설정해야 합니다. 이 이미지는 영상 조회·재생용이며 OpenCV/PyTorch 검출 모델은 설치하거나 다운로드하지 않습니다.

## 재시작과 종료

이미지가 만들어진 뒤 캐시된 이미지만 사용하려면:

```sh
sh scripts/docker-local.sh up -d --no-build --pull never --wait api
sh scripts/docker-local.sh logs --tail 100 api
sh scripts/docker-local.sh down
```

`down`은 DB와 런타임 자료 볼륨을 보존합니다. `down -v`는 데이터를 삭제하므로 보존하려는 DB에는 사용하지 마세요. 코드를 바꾼 뒤에는 기본 시작 명령으로 다시 빌드합니다. 이 빌드는 요청마다 학습하지 않습니다.

## 모델 파일만 교체하기

같은 RF 번들 형식이면 API·화면을 수정하거나 이미지를 다시 빌드하지 않고 파일과 실행 설정만 교체할 수 있습니다. 먼저 별도로 검증한 `model.json`과 `manifest.json`이 있는 `backend/var/models/candidate` 폴더를 준비합니다. 다음 명령은 그 폴더를 컨테이너의 영속 런타임 볼륨에 복사합니다.

```sh
sh scripts/docker-local.sh exec -T api mkdir -p /app/var/models
sh scripts/docker-local.sh cp backend/var/models/candidate api:/app/var/models/
SAFENIGHT_CONTAINER_MODEL_DIR=/app/var/models/candidate sh scripts/docker-local.sh up -d --no-build --force-recreate --wait api
```

같은 이름의 폴더를 덮어쓰기보다는 새 버전 폴더를 사용합니다. 모델 경로를 바꿔 실행한 뒤에는 후속 Compose 명령에도 같은 `SAFENIGHT_CONTAINER_MODEL_DIR`를 지정해야 합니다. 이 설정을 생략하고 컨테이너를 새로 생성하면 이미지의 기본 모델로 돌아갑니다. 기본 모델로 명시적으로 되돌리려면:

```sh
SAFENIGHT_CONTAINER_MODEL_DIR=/app/models/random_forest sh scripts/docker-local.sh up -d --no-build --force-recreate --wait api
```

이 명령은 DB 볼륨을 삭제하거나 관측을 다시 수집하지 않습니다. 새 알고리즘의 라이브러리·어댑터·모델 생성 단계 변경은 [모델 교체 안내](model-replacement.md)를 따릅니다.

공식 문서: [Docker 다단계 빌드](https://docs.docker.com/build/building/multi-stage/), [Compose 프로필](https://docs.docker.com/compose/how-tos/profiles/), [Colima 설치와 시작](https://github.com/abiosoft/colima).
