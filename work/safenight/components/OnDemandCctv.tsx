import { useEffect, useRef, useState } from "react";
import { Camera, X } from "lucide-react";
import ky, { HTTPError } from "ky";
import { z } from "zod";
import type { Sensor } from "../utils/api";
import { NearbyCctvSchema } from "../utils/cctv";
import type { NearbyCamera, NearbyCctv } from "../utils/cctv";
import { NearbyVideoPlayer } from "./NearbyVideoPlayer";
import "./OnDemandCctv.css";

type SearchState =
  | { readonly kind: "idle" }
  | { readonly kind: "searching" }
  | { readonly kind: "ready"; readonly result: NearbyCctv }
  | { readonly kind: "error"; readonly message: string };

function resultTitle(result: NearbyCctv): string {
  switch (result.status) {
    case "FOUND": return `반경 1km 내 가까운 CCTV ${result.cameras.length}곳`;
    case "NO_MATCH": return "조회한 자료에서 주변 CCTV를 찾지 못했습니다.";
    case "COVERAGE_UNKNOWN": return "이 지역의 CCTV 위치 정보를 확인할 수 없습니다.";
    case "PROVIDER_ERROR": return "CCTV를 불러오지 못했습니다. 다시 시도해 주세요.";
  }
}

export function OnDemandCctv({ sensor }: { readonly sensor: Sensor }) {
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [selected, setSelected] = useState<NearbyCamera | null>(null);
  const request = useRef<AbortController | null>(null);
  const player = useRef<HTMLDivElement>(null);
  useEffect(() => () => { request.current?.abort(); }, []);
  useEffect(() => { if (selected) player.current?.scrollIntoView({ block: "nearest" }); }, [selected]);

  function close() {
    request.current?.abort();
    request.current = null;
    setSelected(null);
    setState({ kind: "idle" });
  }

  async function search() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setSelected(null);
    setState({ kind: "searching" });
    try {
      const body = await ky.get("/api/cctv/nearby", {
        searchParams: { lat: sensor.lat, lon: sensor.lon, radius_m: 1000 },
        signal: controller.signal, timeout: 25000, retry: 0,
      }).json<unknown>();
      if (!controller.signal.aborted) setState({ kind: "ready", result: NearbyCctvSchema.parse(body) });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof HTTPError && error.response.status === 404) {
        setState({ kind: "error", message: "CCTV 조회 서비스를 이용할 수 없습니다. 잠시 후 다시 시도해 주세요." });
      } else if (error instanceof z.ZodError) {
        setState({ kind: "error", message: "CCTV 정보를 표시할 수 없습니다. 잠시 후 다시 시도해 주세요." });
      } else if (error instanceof Error) {
        setState({ kind: "error", message: "조회하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요." });
      } else {
        throw error;
      }
    }
  }

  return <section aria-label="주변 CCTV" className="nearby-cctv">
    <div className="nearby-actions">
      <button className="text-button" onClick={() => { void search(); }} disabled={state.kind === "searching"}>
        <Camera size={18} aria-hidden="true" /> {state.kind === "searching" ? "주변 CCTV 확인 중…" : "주변 CCTV 찾기"}
      </button>
      {state.kind !== "idle" && <button className="icon-button" onClick={close} aria-label="CCTV 조회 닫기"><X size={18} /></button>}
    </div>
    {state.kind === "idle" && <p className="muted">반경 1km의 CCTV 설치 위치를 확인합니다.</p>}
    {state.kind === "searching" && <p role="status">선택한 위치 주변의 CCTV를 확인하고 있습니다.</p>}
    {state.kind === "error" && <p role="alert">{state.message}</p>}
    {state.kind === "ready" && <>
      <div role="status"><p>{resultTitle(state.result)}</p>{!state.result.lookup_complete && state.result.cameras.length > 0 && <p className="muted">일부 CCTV 정보가 누락될 수 있습니다.</p>}</div>
      {state.result.video_status !== "AVAILABLE" && <p className="muted">영상 준비 중 · CCTV 위치만 표시됩니다.</p>}
      {selected?.playback_url && (selected.playback_type === "hls" || selected.playback_type === "mp4") && <div ref={player}>
        <button className="text-button" onClick={() => setSelected(null)}>영상 닫기</button>
        <NearbyVideoPlayer key={selected.camera_id} url={selected.playback_url} type={selected.playback_type} name={selected.name || selected.camera_id} sourceUrl={selected.source_url} />
      </div>}
      {state.result.cameras.length > 0 && <ul className="nearby-list">{state.result.cameras.map(camera => <li key={camera.camera_id}>
        <strong>{camera.name || camera.camera_id}</strong>
        <p className="muted">직선거리 {Math.round(camera.distance_m).toLocaleString("ko-KR")}m{camera.video_available ? " · 영상 제공" : ""}</p>
        {camera.video_available && camera.playback_url && (camera.playback_type === "hls" || camera.playback_type === "mp4") && <button className="text-button" onClick={() => setSelected(camera)} aria-pressed={selected?.camera_id === camera.camera_id}>주변 영상 보기</button>}
        {camera.video_available && camera.playback_url && camera.playback_type === "external" && <a href={camera.playback_url} target="_blank" rel="noreferrer">제공처에서 영상 보기</a>}
      </li>)}</ul>}
      <a href="https://www.utic.go.kr/traffic/cctvList.do" target="_blank" rel="noreferrer">공식 교통 CCTV 지도 열기</a>
    </>}
  </section>;
}
