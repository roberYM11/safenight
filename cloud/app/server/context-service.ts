import { env } from "cloudflare:workers";
import { BindingUnavailable } from "./cloud/bindings";
import { CloudContextStore, ContextStoreError } from "./context-store";
import { getBundledContextDataset, summarizeContext } from "./context-data";

type Current = NonNullable<Awaited<ReturnType<CloudContextStore["current"]>>>;
let seeded: Promise<void> | undefined;
let cached: { readonly expires: number; readonly value: Promise<Current> } | undefined;

export function invalidateContextCache(): void { cached = undefined; }

/** Preserve the initial public dataset once, then serve the latest completely published version. */
async function currentContext(now: Date): Promise<Current> {
  if (!env.DB || !env.BUCKET) throw new BindingUnavailable();
  const store = new CloudContextStore(env.DB, env.BUCKET);
  seeded ??= store.ensureSeed(getBundledContextDataset(), now).catch((error: unknown) => { seeded = undefined; throw error; });
  await seeded;
  if (cached && cached.expires > now.getTime()) return cached.value;
  const value = store.current().then(current => {
    if (!current) throw new ContextStoreError("context_snapshot_missing");
    return current;
  }).catch((error: unknown) => { cached = undefined; throw error; });
  cached = { value, expires: now.getTime() + 30000 };
  return value;
}

export async function locationContext(point: { readonly lat: number; readonly lon: number }, now = new Date()) {
  const current = await currentContext(now);
  return { ...summarizeContext(point, 1000, current.dataset), snapshot_id: current.id, checked_at: current.checked_at };
}
