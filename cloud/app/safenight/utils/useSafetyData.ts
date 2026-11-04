import { useEffect, useState } from "react";
import { z } from "zod";
import { loadDashboard } from "./api";
import type { Dashboard } from "./api";

export type DataState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: Dashboard }
  | { readonly kind: "error"; readonly message: string };

export function useSafetyData() {
  const [state, setState] = useState<DataState>({ kind: "loading" });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const data = await loadDashboard(controller.signal);
        if (!controller.signal.aborted) setState({ kind: "ready", data });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof Error) {
          const message = error instanceof z.ZodError
            ? "관측 정보를 표시할 수 없습니다. 잠시 후 다시 시도해 주세요."
            : "연결할 수 없습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.";
          setState({ kind: "error", message });
          return;
        }
        throw error;
      }
    }
    setState({ kind: "loading" });
    void load();
    const interval = window.setInterval(() => { void load(); }, 60000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [revision]);

  return { state, refresh: () => setRevision(value => value + 1) };
}
