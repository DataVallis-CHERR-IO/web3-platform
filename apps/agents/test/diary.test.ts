import { describe, expect, it } from "vitest";
import { createBudget } from "../src/budget.js";
import { DIARY_MAX_TOKENS, diaryInput, fallbackDiary, validateDiary, writeDiary, type DiaryStep } from "../src/diary.js";
import { fileDiary } from "../src/reports.js";

// TASK-061f: crew diary. No network: every HTTP call goes to a fake.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const answer = (text: string, stop_reason = "end_turn") => json(200, { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 }, stop_reason });

const steps: DiaryStep[] = [
  { agent: "donor-1", persona: "donor", step: "donate", ok: true, detail: "donated 2 USDC to Clean Water, tx 0x" + "ab".repeat(32) },
  { agent: "donor-2", persona: "donor", step: "vote", ok: false, detail: "no button, mail me at jane@example.com" },
  { agent: "staff-1", persona: "staff", step: "review organisation", ok: true, detail: 'approved "Real Person Foundation"' },
  { agent: "staff-1", persona: "staff", step: "red team", ok: true, detail: 'caught "DOUBLE YOUR MONEY via PayPal": the story has a link — saved' },
  { agent: "staff-1", persona: "staff", step: "campaign queue", ok: true, detail: "1 waiting; 0 approved and 0 held by the agent, 0 left for a person; red team: 1 caught, 0 missed" },
  { agent: "scammer-1", persona: "redteam", step: "scam-campaign", ok: true, detail: 'submitted "Send bank transfer for 200% returns"' },
];
const good = { title: "A quiet day on the testnet", body: "Two donors tried to help. One donated 2 USDC. One vote failed. The staff agent caught 1 scam attempt.", xDraft: "Testnet crew: 1 donation, 1 failed vote, 1 scam attempt caught." };
const ctx = { runUrl: "https://github.com/x/y/actions/runs/1", imageSha: "abc", secrets: ["s3cret-value"] };
const date = "2026-11-28";

describe("diary input", () => {
  it("leaves out the red team's details and keeps only counts; no e-mail, hash or admin-page names", () => {
    const { text, counts } = diaryInput(steps, []);
    expect(text).not.toMatch(/scammer|DOUBLE YOUR MONEY|PayPal|bank transfer|200%/i);
    expect(text).not.toContain("jane@example.com");
    expect(text).not.toMatch(/0xab/);
    expect(text).not.toContain("Real Person Foundation");
    expect(text).toContain("Scam attempts caught by the staff agent: 1; missed: 0");
    expect(text).toContain("1 waiting; 0 approved");
    expect(text).not.toContain("red team: 1 caught");
    expect(counts).toMatchObject({ caught: 1, missed: 0, agents: 3, steps: 4, passed: 3, failed: 1 });
  });

  it("redacts secrets like the run log", () => {
    const { text } = diaryInput([{ agent: "a", persona: "donor", step: "donate", ok: true, detail: "key s3cret-value used" }], ["s3cret-value"]);
    expect(text).not.toContain("s3cret-value");
  });

  it("the prompt that is sent carries no red-team detail", async () => {
    let sent = "";
    await writeDiary(steps, { apiKey: "k", budget: createBudget(), date, fetch: async (_u, init) => { sent = String(init!.body); return answer(JSON.stringify(good)); } });
    expect(sent).not.toMatch(/scammer|DOUBLE YOUR MONEY|PayPal|jane@example/i);
    expect(sent).toContain("claude-haiku-5-5");
    expect(sent).toContain(`"max_tokens":${DIARY_MAX_TOKENS}`);
  });
});

describe("validation", () => {
  const input = "donate 2 1 3 4 scam attempts 1 2026-11-28";
  it("accepts a good diary", () => {
    expect(validateDiary(good, input)).toEqual({ ok: true, diary: good });
  });
  it.each([
    ["a link", { ...good, body: "One. Two. See https://x.example now. Four." }],
    ["a bare domain", { ...good, xDraft: "Read cherr.io today" }],
    ["an e-mail address", { ...good, body: "One. Two. Mail a@b.co. Four." }],
    ["a hashtag", { ...good, xDraft: "Good day #web3" }],
    ["an emoji", { ...good, title: "Great day 🎉" }],
    ["a title over 80 characters", { ...good, title: "x".repeat(81) }],
    ["a two-line title", { ...good, title: "one\ntwo" }],
    ["two sentences", { ...good, body: "One. Two." }],
    ["seven sentences", { ...good, body: "A. B. C. D. E. F. G." }],
    ["an X draft over 280 characters", { ...good, xDraft: "x".repeat(281) }],
    ["a number that is not in the input", { ...good, xDraft: "999 donations" }],
    ["the red team", { ...good, body: "One. Two. The red team tried. Four." }],
  ])("rejects %s", (_n, value) => {
    expect(validateDiary(value, input).ok).toBe(false);
  });
  it("the fallback always passes", () => {
    for (const c of [{ steps: 4, passed: 3, failed: 1, agents: 3, caught: 1, missed: 1 }, { steps: 0, passed: 0, failed: 0, agents: 0, caught: 0, missed: 0 }]) {
      const d = fallbackDiary(c, date);
      const input = `${Object.values(c).join(" ")} ${date}`;
      expect(validateDiary(d, input).ok).toBe(true);
    }
  });
});

describe("writeDiary", () => {
  const run = (fetch: (u: string, i?: RequestInit) => Promise<Response>, budget = createBudget(), apiKey: string | undefined | null = "k") =>
    writeDiary(steps, { apiKey: apiKey ?? undefined, budget, date, fetch });

  it("uses the model answer when it is valid, and counts it against the budget", async () => {
    const budget = createBudget();
    const r = await run(async () => answer(JSON.stringify(good)), budget);
    expect(r.source).toBe("model");
    expect(r.diary).toEqual(good);
    expect(budget.used().llmTokens).toBeGreaterThanOrEqual(DIARY_MAX_TOKENS);
  });
  it("falls back on a model error", async () => {
    const r = await run(async () => json(500, { error: "x" }));
    expect([r.source, r.reason]).toEqual(["fallback", "model call answered 500"]);
  });
  it("falls back on a cut-off answer", async () => {
    const r = await run(async () => answer(JSON.stringify(good), "max_tokens"));
    expect(r.source).toBe("fallback");
    expect(r.reason).toMatch(/cut off/);
  });
  it("falls back on an invalid answer", async () => {
    const r = await run(async () => answer(JSON.stringify({ ...good, xDraft: "see https://evil.example" })));
    expect(r.source).toBe("fallback");
    expect(r.reason).toMatch(/link/);
    expect(await run(async () => answer("no json here"))).toMatchObject({ source: "fallback" });
  });
  it("falls back, without a call, when the budget is reached", async () => {
    let sent = 0;
    const r = await run(async () => { sent++; return answer(JSON.stringify(good)); }, createBudget({ llmTokens: 100, transactions: 1, campaigns: 1, organisations: 1 }));
    expect([r.source, sent]).toEqual(["fallback", 0]);
    expect(r.reason).toMatch(/budget reached/);
  });
  it("falls back without a key, without a call", async () => {
    let sent = 0;
    const r = await run(async () => { sent++; return answer("{}"); }, createBudget(), null);
    expect([r.source, sent]).toEqual(["fallback", 0]);
  });
});

describe("filing (fileDiary)", () => {
  it("one issue labelled agent-diary through the reports path, redacted, no mentions", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const n = await fileDiary({ ...good, title: "Hi @bob s3cret-value", body: "Mail @bob. Two. Three." }, {
      token: "t", repo: "o/r", ctx,
      fetch: async (url, init) => { calls.push({ url, init: init! }); return json(201, { number: 9 }); },
    });
    expect(n).toBe(9);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/o/r/issues");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer t");
    const sent = JSON.parse(String(calls[0]!.init.body)) as { title: string; body: string; labels: string[] };
    expect(sent.labels).toEqual(["agent-diary"]);
    expect(sent.title.startsWith("[agent-diary] ")).toBe(true);
    expect(sent.title + sent.body).not.toContain("s3cret-value");
    expect(sent.body).not.toMatch(/@bob/);
    expect(sent.body).toContain(good.xDraft);
    expect(sent.body).toContain(ctx.runUrl);
  });
  it("nothing is filed without a token or repository", async () => {
    let sent = 0;
    const fetch = async () => { sent++; return json(201, { number: 1 }); };
    expect(await fileDiary(good, { ctx, fetch })).toBeNull();
    expect(await fileDiary(good, { token: "t", ctx, fetch })).toBeNull();
    expect(sent).toBe(0);
  });
  it("a failing GitHub call throws (the runner catches it)", async () => {
    await expect(fileDiary(good, { token: "t", repo: "o/r", ctx, fetch: async () => json(500, {}) })).rejects.toThrow("answered 500");
  });
});
