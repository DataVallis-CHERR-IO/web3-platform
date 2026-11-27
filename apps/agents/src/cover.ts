/**
 * apps/agents/src/cover.ts — a real cover photo for a crew campaign (FLUX.2 [pro] on fal.ai).
 *
 * The fundraiser agent makes the picture itself, like a person who brings a photo, and
 * uploads it through the campaign page; the app re-encodes it like any upload. Same
 * photo rules as the admin's demo covers (apps/web/src/lib/demo/cover.ts, ADR-052 §4):
 * documentary look, no text, no logos, no identifiable faces. fal's queue API —
 * submit, poll, fetch the result, download from fal's CDN (no key sent there).
 *
 * Any failure throws; the caller then draws the old "TEST DOCUMENT" cover, so a fal
 * outage never stops a run. The key is a run secret: redacted from the run log.
 */
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const FAL_MODEL = "fal-ai/flux-2-pro";
export const FAL_QUEUE = `https://queue.fal.run/${FAL_MODEL}`;
/** The app refuses covers above 5 MB (MAX_IMAGE_BYTES); a 4:3 1 MP JPEG is far below. */
export const MAX_COVER_BYTES = 5 * 1024 * 1024;
/** fal answers in ~10–30 s; past this the drawn cover is used. */
export const COVER_WAIT_MS = 120_000;
/** Where fal serves results. Anything else is not downloaded. */
const IMAGE_HOSTS = /^(?:[a-z0-9-]+\.)*fal\.media$|^storage\.googleapis\.com$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The same photo brief as the admin's demo covers, around the writer's one-line scene. */
export function coverPrompt(scene: string): string {
  return (
    `Documentary-style colour photograph, natural light, realistic, 4:3: ${scene}. ` +
    "No text, no letters, no logos, no watermarks, no brand names. " +
    "If people appear they are ordinary, not famous, seen from a distance or from behind; no identifiable faces."
  );
}

export interface CoverOptions {
  apiKey: string;
  scene: string;
  fetch?: Fetch;
  sleep?: Sleep;
  waitMs?: number;
}

const fail = (why: string): never => {
  throw new Error(`cover: ${why}`);
};

async function json(res: Response | null, what: string): Promise<Record<string, unknown>> {
  if (!res) return fail(`${what}: no response`);
  if (!res.ok) return fail(`${what}: HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return body ?? fail(`${what}: not JSON`);
}

/** One JPEG from FLUX.2 [pro]. Throws with a short reason (never the key) on any problem. */
export async function makeCover(o: CoverOptions): Promise<Buffer> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? realSleep;
  const auth = { Authorization: `Key ${o.apiKey}` };
  const get = (url: string, headers?: Record<string, string>) =>
    f(url, { headers, signal: AbortSignal.timeout(20_000) }).catch(() => null);

  const submitted = await json(
    await f(FAL_QUEUE, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: coverPrompt(o.scene), image_size: "landscape_4_3", output_format: "jpeg" }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null),
    "submit"
  );
  const id = submitted.request_id;
  if (typeof id !== "string" || !REQUEST_ID.test(id)) return fail("submit: no request id");

  const until = Date.now() + (o.waitMs ?? COVER_WAIT_MS);
  // fal already works (and charges) once submitted: a few failed polls are waited out, not given up on.
  let pollErrors = 0;
  for (;;) {
    let status: unknown;
    try {
      status = (await json(await get(`${FAL_QUEUE}/requests/${id}/status`, auth), "status")).status;
    } catch (error) {
      if (++pollErrors > 3 || Date.now() >= until) throw error;
      await sleep(3_000);
      continue;
    }
    if (status === "COMPLETED") break;
    if (status !== "IN_QUEUE" && status !== "IN_PROGRESS") fail(`status ${String(status).slice(0, 20)}`);
    if (Date.now() >= until) fail("no picture within two minutes");
    await sleep(3_000);
  }

  const result = await json(await get(`${FAL_QUEUE}/requests/${id}`, auth), "result");
  const url = (result.images as { url?: unknown }[] | undefined)?.[0]?.url;
  if (typeof url !== "string") return fail("result without an image");
  let host = "";
  try {
    const u = new URL(url);
    host = u.protocol === "https:" ? u.hostname : "";
  } catch {
    host = "";
  }
  if (!IMAGE_HOSTS.test(host)) fail(`image not on fal's CDN (${host.slice(0, 40) || "no https host"})`);

  // No key to the CDN.
  const image = await get(url);
  if (!image?.ok) return fail(`download: ${image ? `HTTP ${image.status}` : "no response"}`);
  if (Number(image.headers.get("content-length") ?? "0") > MAX_COVER_BYTES) return fail("image too large");
  const bytes = Buffer.from(await image.arrayBuffer());
  if (bytes.length > MAX_COVER_BYTES) fail(`image too large (${bytes.length} bytes)`);
  if (bytes.length < 1_000 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) fail("not a JPEG");
  return bytes;
}
