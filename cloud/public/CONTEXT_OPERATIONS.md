# SafeNight 시설자료 일일 갱신

사용자의 컴퓨터가 꺼져 있고 사이트를 열지 않아도 실행하는 클라우드 작업이다. CCTV는 설치 대수 자료만 사용하며 영상은 조회하지 않는다. 시설 변화 여부를 매일 확인하고, 모델은 자동 학습하지 않는다.

공개 원천 수집은 roberYM11/safenight의 collect-facilities.yml GitHub Actions가 매일 03:15 Asia/Seoul에 담당한다. Sites에서 정부 파일 호스트로 직접 요청할 때 시간 초과가 발생해 수집 실행 위치를 분리했다. 공개 CSV 원문과 내려받기 응답, 필요한 항목만 추출한 메타데이터를 safenight-facility-data 브랜치에 보존한다. 추출본과 원문은 manifest에서 구분하고 각각의 해시를 기록한다. GitHub에 정부 API 키나 Sites 접속 토큰을 저장하지 않는다.

1. 연결된 Sites 도구에서 현재 Site의 get_site를 호출한다. 반환된 current_live_url 또는 expected_url이 SafeNight 주소인지 확인한다. 기존 siwc_bypass_bearer_token을 세션 메모리에서만 사용한다. 없으면 새 토큰을 만들지 말고 접근 실패를 보고한다.
2. 같은 Site origin에만 요청한다. OAI-Sites-Authorization: Bearer <기존 토큰>과 X-SafeNight-Collection-Token: <같은 토큰>을 사용한다. 값은 파일·명령 인자·로그·알림에 남기지 않는다. redirect는 따라가지 않는다.
3. POST /api/internal/context 에 JSON {"action":"due"}를 보낸다. 반환값은 작업 객체 자체다. succeeded면 같은 한국 날짜에 이미 완료한 작업을 재사용한 것이므로 다시 다운로드하지 않는다.
4. running이면 POST 같은 경로에 {"action":"mirror_step","job_id":"반환된 id"}를 반복한다. 한 요청이 공식 출처 하나를 처리한다. 고정된 GitHub 공개 경로만 사용하며, 첫 요청에서 고정한 manifest로 네 단계를 수행한다. 한국 날짜가 작업 날짜와 같은 수집본만 허용한다. 송파 조명·서초 보안등·송파 CCTV·서초 CCTV의 문서 해시·크기·공식 URL·내려받기 연결·CSV를 모두 재검증해야 게시된다. 409 context_job_busy면 다른 실행이 소유한 상태이므로 GET /api/internal/context?job_id=<id>로 진행을 확인하고 제한적으로 재시도한다. failed는 실패로 보고하며 숫자나 성공 기록을 만들지 않는다. 이전 날짜의 미러이거나 미러가 없으면 GitHub Actions 실행 실패·지연 여부를 확인하고 알린다. 정부 호스트 직접 수집인 step으로 자동 전환해 성공 처리하지 않는다.
5. succeeded 뒤 GET /api/internal/context 로 current.id·checked_at·facility_count와 작업 결과를 다시 확인한다. 이력은 DB에, 원문과 버전별 전체 자료는 R2에 남는다. 원문 해시와 시설 내용이 같으면 기존 버전 ID를 유지하고 확인 시각만 갱신한다. 새 자료를 받았다는 이유로 사이트를 재배포하지 않는다.

매일 04:00 Asia/Seoul에 실행한다. GitHub 예약 실행은 지연될 수 있으므로 03:15가 정확한 완료 시각을 보장하지는 않는다. 정상·변경 없음은 별도 알림 없이 종료하고, 수집 실패·접근 오류·검증 오류·미완료 작업만 알린다. 실행 시간이 부족하면 작업 ID와 진행 단계를 남기고 다음 실행에서 재개한다. 실패하면 기존 정상 자료를 유지한다. 원천의 포털 수정일·자료 기준일·이번 확인 시각은 서로 다른 정보다.

## GitHub 게시 직후 callback (2026-11-05 코드)

새 배포에서는 `SAFENIGHT_PIPELINE_ENABLED=true`일 때 기존 시설 워크플로의 마지막 단계가 `pipeline-client.mjs context`를 실행한다. callback은 게시 파일의 manifest 해시를 각 mirror_step에 전달해 원천 처리 전에 확인하고, 완료 후 다시 current 포인터와 pinned manifest를 확인한다. CDN의 이전 파일, 같은 날 다른 manifest로 완료된 작업, 불완전한 원천은 성공으로 간주하지 않는다.

이 callback만 운영자 토큰을 GitHub Secrets로 사용한다. 앞의 수집 단계는 공개 원천을 계속 별도로 수집한다. 기존 Sites 일정과 병행하면 기존 작업 임대·한국 날짜별 성공 제약으로 작업을 조정하며, 배포·Secrets 설정 전에는 새 callback을 활성화하지 않는다.
