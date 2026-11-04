import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, LocateFixed, MapPinned, Moon, RefreshCw, ShieldCheck, Sun, X } from "lucide-react";
import { z } from "zod";
import { SensorMap } from "../components/SensorMap";
import type { MapFocus } from "../components/SensorMap";
import { SafetyObservation, SafetySensorList } from "../components/SafetyDetails";
import type { MapData, Sensor } from "../utils/api";
import { formatTime, scoreTone, statusText } from "../utils/format";
import { useSafetyData } from "../utils/useSafetyData";
import { PlaceSearch } from "../components/PlaceSearch";
import { PlaceObservation, placeStatus } from "../components/PlaceObservation";
import { LocationContext } from "../components/LocationContext";
import { usePlaceAssessment } from "../utils/usePlaceAssessment";
import type { PlaceTarget } from "../utils/place-api";

type SheetTab = "observation" | "sensors" | "context";
const THEMES = z.enum(["dark", "light"]);
const EMPTY_SENSORS: readonly Sensor[] = [];

export function SafetyMap() {
  const { state, refresh } = useSafetyData();
  const [place, setPlace] = useState<PlaceTarget | null>(null);
  const [selectedId, setSelectedId] = useState<Sensor["sensor_id"] | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [tab, setTab] = useState<SheetTab>("observation");
  const [expanded, setExpanded] = useState(true);
  const [locationMessage, setLocationMessage] = useState("");
  const [theme, setTheme] = useState(() => THEMES.safeParse(localStorage.getItem("app_theme")).data ?? "dark");

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    localStorage.setItem("app_theme", theme);
  }, [theme]);

  const data = state.kind === "ready" ? state.data : null;
  const sensors = data?.map.sensors ?? EMPTY_SENSORS;
  const selected = sensors.find(sensor => sensor.sensor_id === selectedId)
    ?? sensors.find(sensor => sensor.score !== null) ?? sensors[0] ?? null;
  const placeAssessment = usePlaceAssessment(place, data?.map.generated_at);
  const score = place ? (placeAssessment.kind === "ready" ? placeAssessment.data.score : null) : selected?.score ?? null;
  const contextPoint = place ?? (selected ? { id: selected.sensor_id, name: selected.neighborhood || selected.district || "관측 지점", address: "", lat: selected.lat, lon: selected.lon } : null);

  const selectSensor = useCallback((sensor: Sensor) => {
    setSelectedId(sensor.sensor_id);
    setPlace(null);
    setFocus({ lat: sensor.lat, lon: sensor.lon, key: Date.now() });
    setTab("observation");
    setExpanded(true);
  }, []);

  const selectPlace = useCallback((target: PlaceTarget) => {
    setPlace(target);
    setFocus({ lat: target.lat, lon: target.lon, key: Date.now() });
    setTab("observation"); setExpanded(true);
  }, []);

  const selectPoint = useCallback((point: { readonly lat: number; readonly lon: number }) => {
    selectPlace({ ...point, id: `coordinate:${point.lat}:${point.lon}`, name: "선택한 위치", address: `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}` });
  }, [selectPlace]);

  function locate() {
    if (!navigator.geolocation) { setLocationMessage("이 브라우저는 위치 조회를 지원하지 않습니다."); return; }
    setLocationMessage("기기 위치를 확인하고 있습니다.");
    navigator.geolocation.getCurrentPosition(position => {
      selectPlace({ id: "device-location", name: "내 위치", address: "현재 기기 위치의 주변 관측", lat: position.coords.latitude, lon: position.coords.longitude });
      setLocationMessage("현재 위치로 이동하고 주변 관측을 확인합니다.");
    }, () => setLocationMessage("위치를 확인할 수 없습니다. 지도나 센서 목록에서 선택해 주세요."), { timeout: 10000, maximumAge: 60000 });
  }

  function panel() {
    if (tab === "context") return <LocationContext key={contextPoint ? `${contextPoint.lat}:${contextPoint.lon}` : "none"} point={contextPoint} onSelectPlace={selectPlace} revision={data?.map.generated_at} />;
    if (place && tab === "observation") return <PlaceObservation place={place} state={placeAssessment} onContext={() => setTab("context")} revision={data?.map.generated_at} />;
    switch (state.kind) {
      case "loading": return <p className="empty-state" role="status">관측 정보를 불러오고 있습니다.</p>;
      case "error": return <div className="empty-state" role="alert"><h2>데이터를 불러오지 못했습니다</h2><p>{state.message}</p><button className="text-button" onClick={refresh}>다시 연결</button></div>;
      case "ready":
        switch (tab) {
          case "observation": return <SafetyObservation sensor={selected} />;
          case "sensors": return <SafetySensorList sensors={sensors} selectedId={place ? null : selected?.sensor_id ?? null} onSelect={selectSensor} />;
          default: return unreachable(tab);
        }
      default: return unreachable(state);
    }
  }

  return <main className="safety-app" data-theme={theme}>
    <a className="skip-link" href="#observation-panel">관측 정보로 이동</a>
    <SensorMap sensors={sensors} selectedId={place ? null : selected?.sensor_id ?? null} focus={focus} target={place} onPointSelect={selectPoint} onSelect={selectSensor} theme={theme} />
    <header className="app-header">
      <h1 className="brand"><ShieldCheck aria-hidden="true" /><span>SafeNight</span></h1>
      <div className="header-actions">
        <button className="icon-button" onClick={() => setTheme(value => value === "dark" ? "light" : "dark")} aria-label={theme === "dark" ? "밝은 화면으로 변경" : "어두운 화면으로 변경"} title="화면 테마 변경">{theme === "dark" ? <Sun /> : <Moon />}</button>
      </div>
      <PlaceSearch sensors={sensors} selectedId={place ? null : selected?.sensor_id ?? null} onSelect={selectPlace} onSelectSensor={selectSensor} />
    </header>
    <aside className="map-controls" aria-label="선택 지점 점수와 지도 제어">
      <div className="score-panel" aria-live="polite"><p>실험용 환경 안전도</p><div className="score-value" data-tone={scoreTone(score)}>{score === null ? <span className="score-missing">산출 불가</span> : <><strong>{score.toFixed(1)}</strong><span>점</span></>}</div><span className="score-state">{place ? placeStatus(placeAssessment) : state.kind === "loading" ? "데이터 조회 중" : state.kind === "error" ? "서버 연결 확인 필요" : selected ? statusText(selected.status) : "관측 지점 없음"}</span></div>
      <button className="icon-button" onClick={locate} aria-label="내 위치로 지도 이동" title="내 위치로 이동"><LocateFixed /></button>
      <button className="icon-button" onClick={() => { setFocus(null); setTab("sensors"); setExpanded(true); }} aria-label="관측 지점 목록 보기" title="관측 지점 목록 보기"><MapPinned /></button>
    </aside>
    {locationMessage && <div className="location-message" role="status"><span>{locationMessage}</span><button className="icon-button" aria-label="위치 안내 닫기" onClick={() => setLocationMessage("")}><X size={18} /></button></div>}
    <section className={`bottom-sheet ${expanded ? "is-expanded" : "is-collapsed"}`} aria-label="관측 지점 상세 정보">
      <div className="sheet-inner">
        <div className="sheet-toolbar">
          <div className="sheet-tabs" role="group" aria-label="상세 정보 종류">
            <button aria-pressed={tab === "observation"} onClick={() => { setTab("observation"); setExpanded(true); }}>관측값</button>
            <button aria-pressed={tab === "sensors"} onClick={() => { setTab("sensors"); setExpanded(true); }}>관측 지점</button>
            <button aria-pressed={tab === "context"} onClick={() => { setTab("context"); setExpanded(true); }}>주변 시설</button>
          </div>
          <div className="sheet-actions"><button className="icon-button" onClick={refresh} disabled={state.kind === "loading"} aria-label="저장된 데이터 새로고침" title="저장된 데이터 새로고침"><RefreshCw size={19} /></button><button className="icon-button" onClick={() => setExpanded(value => !value)} aria-label={expanded ? "상세 정보 접기" : "상세 정보 펼치기"}>{expanded ? <ChevronDown size={20} /> : <ChevronUp size={20} />}</button></div>
        </div>
        {expanded && <div id="observation-panel" className="sheet-content" tabIndex={-1}>{panel()}</div>}
        <footer className="sheet-footer"><p>관측 지점의 참고값이며, 실제 범죄·사고 확률이 아닙니다.</p>{data?.map.data_status && <span>{data.map.data_status==='cloud'&&!data.map.captured_at?'클라우드 DB 자료':dataStatusLabel(data.map.data_status)}{data.map.captured_at && <> · <time dateTime={data.map.captured_at}>{formatTime(data.map.captured_at)} KST</time></>}</span>}</footer>
      </div>
    </section>
  </main>;
}

function dataStatusLabel(status: NonNullable<MapData["data_status"]>): string {
  switch (status) {
    case "snapshot": return "저장 관측자료";
    case "cloud": return "클라우드 수집 확인";
    default: return unreachable(status);
  }
}

function unreachable(value: never): never {
  throw new TypeError(`Unexpected view state: ${String(value)}`);
}
