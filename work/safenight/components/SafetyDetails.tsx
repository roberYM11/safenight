import { Check, Sun, Volume2 } from "lucide-react";
import type { Sensor } from "../utils/api";
import { formatTime, scoreTone, statusText } from "../utils/format";
import { OnDemandCctv } from "./OnDemandCctv";

export function SafetyObservation({ sensor }: { readonly sensor: Sensor | null }) {
  if (!sensor) return <p className="empty-state">지도나 센서 목록에서 관측 지점을 선택해 주세요.</p>;
  return <div className="observation-content">
    <div className="observation-heading">
      <h2>{sensor.neighborhood || sensor.district || "선택한 관측 지점"}</h2>
      <time dateTime={sensor.observed_at}>관측 {formatTime(sensor.observed_at)} KST</time>
    </div>
    <OnDemandCctv key={`${sensor.sensor_id}:${sensor.lat}:${sensor.lon}`} sensor={sensor} />
    <dl className="measurement-grid">
      <div><dt><Sun size={22} />조도</dt><dd>{sensor.lux === null ? "미확인" : <>{sensor.lux.toLocaleString("ko-KR")} <small>lux</small></>}</dd></div>
      <div><dt><Volume2 size={22} />소음</dt><dd>{sensor.noise_db === null ? "미확인" : <>{sensor.noise_db.toLocaleString("ko-KR")} <small>dB</small></>}</dd></div>
    </dl>
    {sensor.score === null && <p className="data-note">점수 산출 불가: {statusText(sensor.status)}</p>}
  </div>;
}

type ListProps = { readonly sensors: readonly Sensor[]; readonly selectedId: Sensor["sensor_id"] | null; readonly onSelect: (sensor: Sensor) => void };

export function SafetySensorList({ sensors, selectedId, onSelect }: ListProps) {
  if (sensors.length === 0) return <p className="empty-state">검색 조건에 맞는 관측 지점이 없습니다.</p>;
  return <ul className="sensor-list">
    {sensors.map(sensor => <li key={sensor.sensor_id}>
      <button className="sensor-row" aria-pressed={sensor.sensor_id === selectedId} onClick={() => onSelect(sensor)}>
        <span className="sensor-row-name"><strong>{sensor.neighborhood || sensor.district || "환경 센서"}</strong><span className="muted mono">{sensor.sensor_id}</span></span>
        <span className="sensor-row-score" data-tone={scoreTone(sensor.score)}>{sensor.score === null ? statusText(sensor.status) : `${sensor.score.toFixed(1)}점`}</span>
        {sensor.sensor_id === selectedId && <Check size={18} aria-label="선택됨" />}
      </button>
    </li>)}
  </ul>;
}

