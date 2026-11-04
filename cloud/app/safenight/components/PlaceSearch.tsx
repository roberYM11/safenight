import { useEffect, useMemo, useRef, useState } from "react";
import { MapPin, Search, X } from "lucide-react";
import { searchPlaces } from "../utils/place-api";
import type { Place, PlaceSearchResult } from "../utils/place-api";
import type { Sensor } from "../utils/api";
import { SafetySensorList } from "./SafetyDetails";

type SearchState = { readonly kind: "idle" } | { readonly kind: "loading" } | { readonly kind: "ready"; readonly data: PlaceSearchResult } | { readonly kind: "error" };
type Props = { readonly sensors: readonly Sensor[]; readonly selectedId: Sensor["sensor_id"] | null; readonly onSelect: (place: Place) => void; readonly onSelectSensor: (sensor: Sensor) => void };

export function PlaceSearch({ sensors, selectedId, onSelect, onSelectSensor }: Props) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [open, setOpen] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const matches = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term ? sensors.filter(sensor => `${sensor.sensor_id} ${sensor.district} ${sensor.neighborhood}`.toLocaleLowerCase().includes(term)).slice(0, 4) : [];
  }, [query, sensors]);

  async function submit() {
    const term = query.trim();
    if (term.length < 2) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: "loading" }); setOpen(true);
    try {
      const data = await searchPlaces(term, controller.signal);
      if (controller.signal.aborted) return;
      setState({ kind: "ready", data });
      if (data.places[0]) { onSelect(data.places[0]); setOpen(false); }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof Error) { setState({ kind: "error" }); return; }
      throw error;
    }
  }

  function clear() { active.current?.abort(); setQuery(""); setState({ kind: "idle" }); setOpen(false); }
  return <div className="search-area">
    <form role="search" className="search-field" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <Search aria-hidden="true" />
      <label className="sr-only" htmlFor="place-query">장소 또는 주소 검색</label>
      <input id="place-query" value={query} minLength={2} maxLength={80} onFocus={() => setOpen(true)} onChange={event => { active.current?.abort(); setQuery(event.target.value); setState({ kind: "idle" }); setOpen(true); }} onKeyDown={event => { if (event.nativeEvent.isComposing && event.key === "Enter") event.preventDefault(); if (event.key === "Escape") setOpen(false); }} placeholder="잠실역, 강남역, 주소 검색" autoComplete="off" />
      {query && <button type="button" onClick={clear} aria-label="검색 지우기"><X size={19} /></button>}
      <button type="submit" className="place-submit" disabled={state.kind === "loading" || query.trim().length < 2} aria-label="장소 검색">검색</button>
    </form>
    {open && query.trim() && <div className="search-results" aria-label="장소와 관측 센서 검색 결과">
      {state.kind === "loading" && <p className="search-count" role="status">장소를 찾고 있습니다.</p>}
      {state.kind === "idle" && <p className="search-count">Enter 또는 검색을 누르면 해당 위치로 이동합니다.</p>}
      {state.kind === "error" && <p className="search-count" role="alert">장소 검색에 연결하지 못했습니다. 잠시 후 다시 검색해 주세요.</p>}
      {state.kind === "ready" && <>
        <p className="search-count">장소 검색 결과 {state.data.places.length}개</p>
        {state.data.places.length === 0 && <p className="search-count">서울 안의 장소명이나 도로명주소로 다시 검색해 주세요.</p>}
        <ul className="place-results">{state.data.places.map(place => <li key={place.id}><button className="place-result" onClick={() => { onSelect(place); setOpen(false); }}><MapPin size={18} aria-hidden="true" /><span><strong>{place.name}</strong><small>{place.address}</small></span></button></li>)}</ul>
        <p className="search-attribution"><a href={state.data.attribution_url} target="_blank" rel="noreferrer">{state.data.attribution}</a> · {state.data.provider}</p>
      </>}
      {matches.length > 0 && <><p className="search-count">관측 센서</p><SafetySensorList sensors={matches} selectedId={selectedId} onSelect={sensor => { onSelectSensor(sensor); clear(); }} /></>}
    </div>}
  </div>;
}
