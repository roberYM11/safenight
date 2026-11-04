import { useEffect, useState } from "react";
import { loadPlaceAssessment } from "./place-api";
import type { PlaceTarget, PlaceAssessmentState } from "./place-api";

export function usePlaceAssessment(point: PlaceTarget | null, revision: string | undefined) {
  const [state, setState] = useState<PlaceAssessmentState>({ kind: "idle" });
  useEffect(() => {
    if (!point) { setState({ kind: "idle" }); return; }
    const controller = new AbortController();
    setState({ kind: "loading" });
    void loadPlaceAssessment(point, controller.signal).then(data => {
      if (!controller.signal.aborted) setState({ kind: "ready", data });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof Error) { setState({ kind: "error" }); return; }
      throw error;
    });
    return () => controller.abort();
  }, [point, revision]);
  if (point && state.kind === "ready" && (state.data.location.lat !== point.lat || state.data.location.lon !== point.lon)) return { kind: "loading" } as const;
  return state;
}
