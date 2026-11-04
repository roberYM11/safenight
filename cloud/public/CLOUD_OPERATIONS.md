# SafeNight 클라우드 정기 수집

사이트가 닫혀 있고 사용자의 컴퓨터가 꺼져 있어도 실행하는 업데이트 절차다. S-DoT 원천과 D1·R2만 사용하며 로컬 서버, Docker, CCTV를 사용하지 않는다. 모델을 다시 학습하지 않는다.

1. 연결된 Sites 도구에서 현재 Site의 get_site를 호출한다. 반환된 current_live_url 또는 expected_url이 현재 SafeNight 주소인지 확인하고, 반환된 siwc_bypass_bearer_token을 세션 메모리에서만 사용한다. 토큰이 없으면 새 토큰을 만들지 말고 접근 불가를 보고한다.
2. 같은 Site에만 요청한다. OAI-Sites-Authorization: Bearer <반환된 토큰> 및 X-SafeNight-Collection-Token: <같은 토큰> 헤더를 사용한다. 값은 파일·명령 인자·로그·알림에 남기지 않는다. redirect는 따라가지 않는다.
3. POST /api/internal/collection 에 JSON {"action":"due"}를 보낸다. 응답은 {plan,job}다. plan.status가 archive_backfill_required면 누락 구간을 건너뛰지 말고 실패를 보고한다. retry_deferred는 retry_at까지 유예된 상태다.
4. job이 있으면 POST 같은 경로에 {"action":"step","job_id":"반환된 id"}를 반복한다. 한 요청이 최대 200행 한 페이지를 처리한다. status가 succeeded면 due를 다시 호출해 남은 날짜를 처리한다. failed면 error_code를 기록하고 숫자 점수나 자료를 만들지 않는다. 중간 종료 시 다음 실행이 같은 durable cursor에서 재개한다.
5. job이 null이고 plan.days 및 pending_job_ids가 비었으면 GET /api/internal/collection 과 GET /api/map 으로 checkpoint·마지막 성공·관측 시각을 다시 확인한다. 성공했다는 이유로 재배포하지 않는다.

수집은 완료된 전날부터 누락 구간을 메우고 최근 7일의 정정 여부를 재검사한다. 원문을 R2에 먼저 보존하고, 전체 페이지 검증이 끝난 뒤에만 D1 현재값과 완료 지점을 원자적으로 변경한다. 29일을 넘는 미수집 구간은 보관 자료를 이용한 별도 복구가 필요하다.

매일 03:00 Asia/Seoul에 시작하도록 연결된 클라우드 일정을 사용한다. 반복 실행의 정상·무변경 상태는 별도 알림 없이 종료하고, 수집 실패·접근 오류·복구가 필요한 구간만 알린다. 실행 시간이 부족하면 진행 중 작업 ID와 다음 페이지를 보존하고 미완료로 보고하며, 완료로 표시하지 않는다.

## 새 공개 후 계산 경로 (2026-11-05 코드)

`0004_pipeline_lineage.sql`과 새 사이트 코드가 배포된 환경에서는 `node cloud/scripts/pipeline-client.mjs collect`가 기존 due/step 완료 후 후속 계산까지 수행한다. 운영자 토큰은 `SAFENIGHT_COLLECT_AUTH_TOKEN`, 별도 사이트 접근 토큰은 필요시 `SAFENIGHT_SITE_BYPASS_TOKEN` 환경변수로 전달한다. 명령 인자나 로그에 토큰을 넣지 않는다.

최초에는 보호된 `/api/internal/pipeline`의 `bootstrap`이 기존 번들·현재 관측을 등록한다. `step`을 idle까지 호출해 피처·결과를 채운다. 동일한 과정은 runner의 derive 모드로 재개할 수 있다. 자동 학습은 이 수집 작업과 분리되어 있으며 외부 정답이 없으면 진행하지 않는다. 코드 배포 후 GitHub 변수 `SAFENIGHT_PIPELINE_ENABLED=true`로 새 정기 실행을 활성화한다. 자세한 적용 순서와 한계는 저장소의 `docs/database-structure.md`를 따른다.
