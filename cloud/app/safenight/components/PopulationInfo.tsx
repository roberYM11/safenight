import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import ky from "ky";
import { z } from "zod";
import type { PlaceTarget } from "../utils/place-api";
import { formatDistance, formatTime } from "../utils/format";

const populationSchema = z.object({
  status: z.enum(["AVAILABLE", "STALE", "NO_COVERAGE", "UNAVAILABLE"]),
  area: z.object({ code: z.string(), name: z.string(), category: z.string() }).nullable(),
  population_min: z.number().finite().nonnegative().nullable(), population_max: z.number().finite().nonnegative().nullable(),
  congestion: z.string().nullable(), observed_at: z.iso.datetime({ offset: true }).nullable(), fetched_at: z.iso.datetime({ offset: true }).nullable(),
  source: z.string(), source_url: z.string().url(), source_update_minutes: z.number().positive(), cache_minutes: z.number().positive(),
  metric: z.literal("area_present_population_estimate"), note: z.string(),
  area_relation: z.enum(["CONTAINS", "NEARBY_AREA"]).nullish(), distance_to_area_m: z.number().finite().nonnegative().nullish(),
}).readonly();
type State = { readonly kind: "loading" } | { readonly kind: "ready"; readonly data: z.infer<typeof populationSchema> } | { readonly kind: "error" };

export function PopulationInfo({ point, revision }: { readonly point: PlaceTarget; readonly revision?: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const { lat, lon } = point;
  useEffect(() => {
    const controller = new AbortController(); setState({ kind: "loading" });
    void ky.get("/api/population", { searchParams: { lat, lon }, signal: controller.signal, timeout: 20000, retry: 0 }).json<unknown>().then(value => {
      if (!controller.signal.aborted) setState({ kind: "ready", data: populationSchema.parse(value) });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof Error) { setState({ kind: "error" }); return; }
      throw error;
    });
    return () => controller.abort();
  }, [lat, lon, revision]);

  const data = state.kind === "ready" ? state.data : null;
  const stale = data !== null && (data.status === "STALE" || (data.observed_at !== null && Date.now() - Date.parse(data.observed_at) > 30 * 60 * 1000));
  const count = data?.population_min !== null && data?.population_min !== undefined && data?.population_max !== null && data?.population_max !== undefined ? `${data.population_min.toLocaleString("ko-KR")}~${data.population_max.toLocaleString("ko-KR")}명` : null;
  return <section className="population-card" aria-label="유동인구 공개자료">
    <div className="population-title"><Users size={18} /><h3>추정 유동인구</h3>{stale && <span className="population-stale">지난 관측</span>}</div>
    {state.kind === "loading" && <p role="status">해당 구역의 인구 자료를 확인하고 있습니다.</p>}
    {state.kind === "error" && <p role="alert">인구 자료에 연결하지 못했습니다. 인구가 0명이라는 뜻은 아닙니다.</p>}
    {data && <>
      {data.area && <p>{data.area_relation === "NEARBY_AREA" && "인근 구역 · "}{data.area.name}{data.congestion && ` · ${data.congestion}`}</p>}
      {data.area_relation === "NEARBY_AREA" && data.distance_to_area_m !== null && data.distance_to_area_m !== undefined && <p>선택한 위치는 이 구역 밖이며, 구역 경계까지 {formatDistance(data.distance_to_area_m)}입니다.</p>}
      {count && <strong className="population-count">{count}</strong>}
      {data.observed_at && <time dateTime={data.observed_at}>인구 관측 {formatTime(data.observed_at)} KST</time>}
      <p>{stale && data.status === "AVAILABLE" ? "관측 시각이 30분을 넘어 지난 자료입니다. 현재 인구로 해석하지 마세요." : data.note}</p>
      <details><summary>인구 자료의 의미·출처</summary><p>통신 기반의 구역 내 인구 추정치입니다. 선택한 한 지점의 보행자 수나 분당 통과 인원이 아닙니다. 인구가 많거나 적다는 사실만으로 안전도를 가산하지 않습니다.</p><p>원천 약 {data.source_update_minutes}분 집계 · 서버 최대 {data.cache_minutes}분 캐시</p><a href={data.source_url} target="_blank" rel="noreferrer">{data.source}</a></details>
    </>}
  </section>;
}
