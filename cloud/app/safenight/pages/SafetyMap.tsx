import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, LocateFixed, MapPinned, Moon, RefreshCw, Search, ShieldCheck, Sun, X } from "lucide-react";
import { z } from "zod";
import { SensorMap } from "../components/SensorMap";
import type { MapFocus } from "../components/SensorMap";
import { SafetyObservation, SafetySensorList } from "../components/SafetyDetails";
import type { MapData, Sensor } from "../utils/api";
import { formatTime, scoreTone, statusText } from "../utils/format";
import { useSafetyData } from "../utils/useSafetyData";

type SheetTab = "observation" | "sensors";
const THEMES = z.enum(["dark", "light"]);
const EMPTY_SENSORS: readonly Sensor[] = [];

export function SafetyMap() {
  const { state, refresh } = useSafetyData();
  const [query, setQuery] = useState("");
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
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return sensors.filter(sensor => `${sensor.sensor_id} ${sensor.district} ${sensor.neighborhood}`.toLocaleLowerCase().includes(term));
  }, [sensors, query]);
  const selected = sensors.find(sensor => sensor.sensor_id === selectedId)
    ?? sensors.find(sensor => sensor.score !== null) ?? sensors[0] ?? null;

  const selectSensor = useCallback((sensor: Sensor) => {
    setSelectedId(sensor.sensor_id);
    setFocus({ lat: sensor.lat, lon: sensor.lon, key: Date.now() });
    setQuery("");
    setTab("observation");
    setExpanded(true);
  }, []);

  function locate() {
    if (!navigator.geolocation) { setLocationMessage("이 브라우저는 위치 조회를 지원하지 않습니다."); return; }
    setLocationMessage("기기 위치를 확인하고 있습니다.");
    navigator.geolocation.getCurrentPosition(position => {
      setFocus({ lat: position.coords.latitude, lon: position.coords.longitude, key: Date.now() });
      setLocationMessage("현재 기기 위치로 지도를 이동했습니다. 관측 센서를 선택해 주세요.");
    }, () => setLocationMessage("위치를 확인할 수 없습니다. 지도나 센서 목록에서 선택해 주세요."), { timeout: 10000, maximumAge: 60000 });
  }

  function panel() {
    switch (state.kind) {
      case "loading": return <p className="empty-state" role="status">관측 정보를 불러오고 있습니다.</p>;
      case "error": return <div className="empty-state" role="alert"><h2>데이터를 불러오지 못했습니다</h2><p>{state.message}</p><button className="text-button" onClick={refresh}>다시 연결</button></div>;
      case "ready":
        switch (tab) {
          case "observation": return <SafetyObservation sensor={selected} />;
          case "sensors": return <SafetySensorList sensors={filtered} selectedId={selected?.sensor_id ?? null} onSelect={selectSensor} />;
          default: return unreachable(tab);
        }
      default: return unreachable(state);
    }
  }

  return <main className="safety-app" data-theme={theme}>
    <a className="skip-link" href="#observation-panel">관측 정보로 이동</a>
    <SensorMap sensors={sensors} selectedId={selected?.sensor_id ?? null} focus={focus} onSelect={selectSensor} theme={theme} />
    <header className="app-header">
      <h1 className="brand"><ShieldCheck aria-hidden="true" /><span>SafeNight</span></h1>
      <div className="header-actions">
        <button className="icon-button" onClick={() => setTheme(value => value === "dark" ? "light" : "dark")} aria-label={theme === "dark" ? "밝은 화면으로 변경" : "어두운 화면으로 변경"} title="화면 테마 변경">{theme === "dark" ? <Sun /> : <Moon />}</button>
      </div>
      <div className="search-area">
        <label className="search-field"><Search aria-hidden="true" /><span className="sr-only">관측 지점 또는 지역 검색</span><input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setQuery(""); }} placeholder="관측 지점 또는 지역 검색" autoComplete="off" />{query && <button onClick={() => setQuery("")} aria-label="검색 지우기"><X size={20} /></button>}</label>
        {query.trim() && <div className="search-results" aria-label="센서 검색 결과"><p className="search-count">검색 결과 {filtered.length.toLocaleString("ko-KR")}개</p><SafetySensorList sensors={filtered.slice(0, 8)} selectedId={selected?.sensor_id ?? null} onSelect={selectSensor} /></div>}
      </div>
    </header>
    <aside className="map-controls" aria-label="선택 지점 점수와 지도 제어">
      <div className="score-panel" aria-live="polite"><p>실험용 환경 안전도</p><div className="score-value" data-tone={scoreTone(selected?.score ?? null)}>{selected?.score === null || !selected ? <span className="score-missing">산출 불가</span> : <><strong>{selected.score.toFixed(1)}</strong><span>점</span></>}</div><span className="score-state">{state.kind === "loading" ? "데이터 조회 중" : state.kind === "error" ? "서버 연결 확인 필요" : selected ? statusText(selected.status) : "관측 지점 없음"}</span></div>
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
