import { useEffect, useState } from "react";
import ky from "ky";
import { z } from "zod";
import { Lightbulb, ShieldCheck } from "lucide-react";
import type { PlaceTarget } from "../utils/place-api";
import { formatDistance, formatTime } from "../utils/format";
import { PopulationInfo } from "./PopulationInfo";

const facilitySchema = z.object({ id: z.string(), name: z.string(), lat: z.number(), lon: z.number(), address: z.string().nullable(), source_id: z.string(), distance_m: z.number().nonnegative(), camera_count: z.number().int().nonnegative().nullish() }).readonly();
const contextSchema = z.object({
  radius_m: z.number().positive(), usage: z.literal("CONTEXT_ONLY"), score_included: z.literal(false),
  checked_at: z.iso.datetime({ offset: true }).optional(),
  groups: z.array(z.object({ kind: z.enum(["streetlight", "security_light", "cctv"]), label: z.string(), status: z.enum(["AVAILABLE", "NO_RECORDS"]), count: z.number().int().nonnegative().nullable(), nearest: z.array(facilitySchema).readonly() }).readonly()).readonly(),
  sources: z.array(z.object({ id: z.string(), title: z.string(), url: z.string().url(), district: z.string(), reference_date: z.string(), updated_at: z.string(), coverage_note: z.string() }).readonly()).readonly(),
}).readonly();
type Context = z.infer<typeof contextSchema>;
type ContextState = { readonly kind: "loading" } | { readonly kind: "ready"; readonly data: Context } | { readonly kind: "error" };
type Props = { readonly point: PlaceTarget | null; readonly compact?: boolean; readonly onSelectPlace?: (place: PlaceTarget) => void; readonly revision?: string };

export function LocationContext({ point, compact = false, onSelectPlace, revision }: Props) {
  const [state, setState] = useState<ContextState>({ kind: "loading" });
  const lat = point?.lat; const lon = point?.lon;
  useEffect(() => {
    if (lat === undefined || lon === undefined) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    void ky.get("/api/context", { searchParams: { lat, lon }, signal: controller.signal, retry: 0, timeout: 15000 }).json<unknown>().then(value => {
      if (!controller.signal.aborted) setState({ kind: "ready", data: contextSchema.parse(value) });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof Error) { setState({ kind: "error" }); return; }
      throw error;
    });
    return () => controller.abort();
  }, [lat, lon, revision]);

  if (!point) return <p className="empty-state">장소를 검색하거나 지도에서 위치를 선택해 주세요.</p>;
  return <section className={`context-content${compact ? " is-compact" : ""}`} aria-label="주변 시설 공개자료">
    {!compact && <div className="observation-heading"><div><h2>{point.name}</h2><p>{point.address}</p></div></div>}
    <PopulationInfo key={`${point.lat}:${point.lon}`} point={point} revision={revision} />
    <h3 className="context-title">주변 안전시설 <span>반경 1km · 공개 설치자료</span></h3>
    {state.kind === "loading" && <p className="detail-footnote" role="status">주변 시설 자료를 확인하고 있습니다.</p>}
    {state.kind === "error" && <p className="data-note" role="alert">시설 자료에 연결하지 못했습니다. 시설이 없다는 뜻은 아닙니다.</p>}
    {state.kind === "ready" && <>
      <dl className="facility-grid">{state.data.groups.map(group => <div key={group.kind}><dt>{group.kind === "cctv" ? <ShieldCheck size={17} /> : <Lightbulb size={17} />}{group.label}</dt><dd>{group.count === null ? <small>확인자료 없음</small> : <>{group.count.toLocaleString("ko-KR")}<small>{group.kind === "cctv" ? "대" : "개"}</small></>}</dd></div>)}</dl>
      <p className="context-note">공개자료에 등록된 설치 수입니다. 미확보 지역은 0으로 표시하지 않습니다. 현재 점등·작동 여부나 안전을 보장하지 않습니다.{state.data.checked_at && <> 자료 확인 {formatTime(state.data.checked_at)} KST · 매일 갱신 확인</>}</p>
      {!compact && <>
        {state.data.groups.map(group => group.nearest.length > 0 && <section key={group.kind} className="nearby-facilities"><h3>가까운 {group.label}</h3><ul>{group.nearest.map(facility => <li key={facility.id}><div><strong>{facility.name}</strong><span>{formatDistance(facility.distance_m)}{facility.camera_count !== undefined && facility.camera_count !== null && ` · ${facility.camera_count}대`}</span></div>{facility.address && <p>{facility.address}</p>}{onSelectPlace && <button className="text-button" onClick={() => onSelectPlace({ id: facility.id, name: facility.name, address: facility.address ?? "공개 설치 위치", lat: facility.lat, lon: facility.lon })}>지도에서 보기</button>}</li>)}</ul></section>)}
      </>}
      <details className="context-sources"><summary>자료 기준일·출처와 반영 범위</summary><p className="detail-footnote">시설 현황은 추가 참고정보이며, 현재 조도·소음 모델 점수에 가산하지 않습니다.</p><ul className="source-list">{state.data.sources.map(source => <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a><p>원자료 기준 {source.reference_date} · 포털 갱신 {source.updated_at}</p><p>{source.coverage_note}</p></li>)}</ul></details>
    </>}
  </section>;
}
