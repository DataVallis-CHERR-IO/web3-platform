// Browser side of the demo covers (TASK-038b): one campaign after another,
// start → poll every 3 s for up to 3 minutes. Pure logic with an injected
// fetch so it is unit-tested.

export type CoverOutcome = "done" | "failed" | "not_configured" | "timeout";

interface Json {
  status?: "done" | "pending";
  requestId?: string;
  error?: string;
}

async function post(fetchImpl: typeof fetch, url: string, body: unknown): Promise<{ ok: boolean; json: Json }> {
  const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, json: ((await res.json().catch(() => ({}))) as Json) ?? {} };
}

export async function generateCover(
  campaignId: string,
  { fetchImpl = fetch, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), pollMs = 3_000, maxPolls = 60 } = {}
): Promise<CoverOutcome> {
  const base = `/api/admin/demo-campaigns/${campaignId}/cover`;
  const started = await post(fetchImpl, base, {});
  if (!started.ok) return started.json.error === "not_configured" ? "not_configured" : "failed";
  if (started.json.status === "done") return "done";
  const requestId = started.json.requestId;
  if (!requestId) return "failed";
  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollMs);
    const checked = await post(fetchImpl, `${base}/check`, { requestId });
    if (!checked.ok) return checked.json.error === "not_configured" ? "not_configured" : "failed";
    if (checked.json.status === "done") return "done";
  }
  return "timeout";
}

/** Covers for several campaigns in order; stops early when FAL_KEY is missing. */
export async function generateCovers(
  ids: string[],
  onProgress: (done: number, failed: number) => void,
  options?: Parameters<typeof generateCover>[1]
): Promise<{ done: number; failed: number; notConfigured: boolean }> {
  let done = 0;
  let failed = 0;
  for (const id of ids) {
    const outcome = await generateCover(id, options);
    if (outcome === "not_configured") return { done, failed, notConfigured: true };
    if (outcome === "done") done++;
    else failed++;
    onProgress(done, failed);
  }
  return { done, failed, notConfigured: false };
}
