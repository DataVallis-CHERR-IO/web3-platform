import { describe, expect, it } from "vitest";
import { FAL_QUEUE, coverPrompt, makeCover } from "../src/cover.js";
import { campaignText, fallbackCampaign } from "../src/fundraiser.js";

const ID = "0a1b2c3d-1111-2222-3333-444455556666";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4_000, 7)]);
const KEY = "fal-test-key-1234567890";

interface Call { url: string; auth: string | null; body?: unknown }

/** A fake fal: queue → IN_PROGRESS → COMPLETED → result → CDN download. */
function fakeFal(opts: { image?: Buffer; imageUrl?: string; statuses?: string[]; statusFailures?: number } = {}) {
  let failures = opts.statusFailures ?? 0;
  const calls: Call[] = [];
  const statuses = [...(opts.statuses ?? ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"])];
  const fetch = async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url, auth, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === FAL_QUEUE) return Response.json({ request_id: ID });
    if (url === `${FAL_QUEUE}/requests/${ID}/status` && failures-- > 0) return new Response("busy", { status: 503 });
    if (url === `${FAL_QUEUE}/requests/${ID}/status`) return Response.json({ status: statuses.shift() ?? "COMPLETED" });
    if (url === `${FAL_QUEUE}/requests/${ID}`) return Response.json({ images: [{ url: opts.imageUrl ?? "https://v3.fal.media/files/x/cover.jpg" }] });
    if (url.startsWith("https://")) return new Response(opts.image ?? JPEG);
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}
const noSleep = async () => undefined;

describe("cover photo (FLUX.2 [pro] on fal.ai)", () => {
  it("submits the photo brief, polls, downloads from fal's CDN without the key", async () => {
    const fal = fakeFal();
    const jpeg = await makeCover({ apiKey: KEY, scene: "straw in dog kennels at dawn", fetch: fal.fetch, sleep: noSleep });
    expect(jpeg.equals(JPEG)).toBe(true);
    expect(fal.calls.map((c) => c.url)).toEqual([
      FAL_QUEUE,
      `${FAL_QUEUE}/requests/${ID}/status`, `${FAL_QUEUE}/requests/${ID}/status`, `${FAL_QUEUE}/requests/${ID}/status`,
      `${FAL_QUEUE}/requests/${ID}`,
      "https://v3.fal.media/files/x/cover.jpg",
    ]);
    expect(fal.calls[0]!.body).toEqual({ prompt: coverPrompt("straw in dog kennels at dawn"), image_size: "landscape_4_3", output_format: "jpeg" });
    expect(coverPrompt("x")).toContain("No text, no letters, no logos");
    expect(fal.calls.slice(0, 5).every((c) => c.auth === `Key ${KEY}`)).toBe(true);
    expect(fal.calls[5]!.auth).toBeNull(); // the CDN never sees the key
  });

  it("waits out up to three failed status polls of a job fal already charges for; gives up after the fourth", async () => {
    const ok = await makeCover({ apiKey: KEY, scene: "a quiet library corner", fetch: fakeFal({ statusFailures: 3 }).fetch, sleep: noSleep });
    expect(ok.equals(JPEG)).toBe(true);
    const error = await makeCover({ apiKey: KEY, scene: "a quiet library corner", fetch: fakeFal({ statusFailures: 4 }).fetch, sleep: noSleep })
      .then(() => null, (e: Error) => e);
    expect(error?.message).toBe("cover: status: HTTP 503");
  });

  it("refuses a picture from elsewhere, a non-JPEG, a failed job and a slow one — never naming the key", async () => {
    const cases: [Parameters<typeof fakeFal>[0], number | undefined, RegExp][] = [
      [{ imageUrl: "https://evil.example/fal.media/cover.jpg" }, undefined, /not on fal's CDN \(evil\.example\)/],
      [{ imageUrl: "http://v3.fal.media/cover.jpg" }, undefined, /not on fal's CDN \(no https host\)/],
      [{ image: Buffer.from("<html>nope</html>".repeat(100)) }, undefined, /not a JPEG/],
      [{ statuses: ["FAILED"] }, undefined, /status FAILED/],
      [{ statuses: Array(50).fill("IN_PROGRESS") }, 0, /no picture within two minutes/],
    ];
    for (const [opts, waitMs, reason] of cases) {
      const error = await makeCover({ apiKey: KEY, scene: "a quiet library corner", fetch: fakeFal(opts).fetch, sleep: noSleep, waitMs })
        .then(() => null, (e: Error) => e);
      expect(error?.message, String(reason)).toMatch(reason);
      expect(error?.message).not.toContain(KEY);
    }
    const down = await makeCover({ apiKey: KEY, scene: "a quiet library corner", fetch: async () => new Response("no", { status: 401 }), sleep: noSleep })
      .then(() => null, (e: Error) => e);
    expect(down?.message).toBe("cover: submit: HTTP 401");
  });

  it("the writer's scene is checked; a missing or odd one does not cost the text", () => {
    const story = "Our small shelter keeps thirty dogs outside. ".repeat(4).trim() + "\n\nVolunteers do the work.";
    const base = { title: "Warm kennels for winter", story, cause: "animals" };
    expect(campaignText({ ...base, scene: "wooden kennels with straw on a frosty morning" }, "f")!.scene)
      .toBe("wooden kennels with straw on a frosty morning");
    expect(campaignText(base, "f")!.scene).toBe("a small charity project: Warm kennels for winter");
    expect(campaignText({ ...base, scene: "see https://example.org for the kennels we use" }, "f")!.scene)
      .toBe("a small charity project: Warm kennels for winter");
    expect(campaignText({ ...base, scene: "kennels\nwith straw and blankets in the yard" }, "f")!.scene)
      .toBe("a small charity project: Warm kennels for winter");
    expect(fallbackCampaign("f").scene).toMatch(/kennels/);
  });
});
