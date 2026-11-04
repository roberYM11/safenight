import { Sun, Volume2 } from "lucide-react";
import type { PlaceTarget, PlaceAssessmentState } from "../utils/place-api";
import { formatDistance, formatTime } from "../utils/format";
import { LocationContext } from "./LocationContext";

export function placeStatus(state: PlaceAssessmentState): string {
  switch (state.kind) {
    case "idle": return "장소를 선택해 주세요";
    case "loading": return "주변 관측 확인 중";
    case "error": return "주변 데이터 연결 실패";
    case "ready":
      switch (state.data.status) {
        case "SCORED": return `주변 센서 ${state.data.coverage.sensor_count}곳 기준`;
        case "NO_NEARBY_OBSERVATIONS": return "주변 관측 센서 없음";
        case "NO_USABLE_OBSERVATIONS": return "유효한 주변 관측 부족";
        case "OUTSIDE_SERVICE_AREA": return "서울 서비스 범위 밖";
        default: return unreachable(state.data.status);
      }
    default: return unreachable(state);
  }
}

export function PlaceObservation({ place, state, onContext, revision }: { readonly place: PlaceTarget; readonly state: PlaceAssessmentState; readonly onContext: () => void; readonly revision?: string }) {
  const assessment = state.kind === "ready" ? state.data : null;
  return <div className="observation-content">
    <div className="observation-heading"><div><h2>{place.name}</h2><p className="muted">{place.address || `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`}</p></div>{assessment?.observed_until && <time dateTime={assessment.observed_until}>주변 관측 {formatTime(assessment.observed_until)} KST</time>}</div>
    <p className="place-method" role="status">{placeStatus(state)}{assessment?.coverage.nearest_sensor_m !== null && assessment?.coverage.nearest_sensor_m !== undefined && ` · 가장 가까운 센서 ${formatDistance(assessment.coverage.nearest_sensor_m)}`}</p>
    <dl className="measurement-grid"><div><dt><Sun size={22} />주변 조도</dt><dd>{assessment?.lux === null || assessment?.lux === undefined ? "미확인" : <>{assessment.lux.toLocaleString("ko-KR", { maximumFractionDigits: 1 })} <small>lux</small></>}</dd></div><div><dt><Volume2 size={22} />주변 소음</dt><dd>{assessment?.noise_db === null || assessment?.noise_db === undefined ? "미확인" : <>{assessment.noise_db.toLocaleString("ko-KR", { maximumFractionDigits: 1 })} <small>dB</small></>}</dd></div></dl>
    <p className="detail-footnote">반경 1.5km 안의 유효 관측 최대 8곳을 사용합니다. 가까운 센서일수록 크게 반영한 실험용 추정치입니다.</p>
    <LocationContext key={`${place.lat}:${place.lon}`} point={place} compact revision={revision} />
    <button className="text-button context-link" onClick={onContext}>주변 안전시설·데이터 보기</button>
    {assessment && assessment.sensors.length > 0 && <details><summary>계산에 사용한 관측 {assessment.sensors.length}곳</summary><ul className="source-list">{assessment.sensors.map(sensor => <li key={sensor.sensor_id}><div><span className="mono">{sensor.sensor_id}</span><span>{formatDistance(sensor.distance_m)} · {(sensor.weight * 100).toFixed(1)}% 반영</span></div><time dateTime={sensor.observed_at}>{formatTime(sensor.observed_at)} KST</time></li>)}</ul></details>}
  </div>;
}
function unreachable(value: never): never { throw new TypeError(`Unexpected place status: ${String(value)}`); }
