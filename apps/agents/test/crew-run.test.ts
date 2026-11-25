import { describe, expect, it } from "vitest";
import { createBudget, BudgetExceeded } from "../src/budget.js";
import { ask, firstJson } from "../src/llm.js";
import { DEFAULT_PLAN, checkRunnable, defaultPlan, planRun } from "../src/dispatcher.js";
import { observe } from "../src/observe.js";
import { fileReports, fingerprint, issueBody, marker, normalizeDetail, MAX_NEW_ISSUES, type Bug } from "../src/reports.js";
import { redact } from "../src/runlog.js";
import { placeAssignments } from "../src/models.js";
import { CREW } from "../src/crew.js";

// TASK-061d: dispatcher, observations, bug reports. No network: every HTTP call goes to a fake.

type Call = { url: string; init: RequestInit };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const modelAnswer = (text: string) => json(200, { content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 20 } });
const names = CREW.map((c) => c.name);
const summary = { liveCampaigns: 3, subPools: 1, balances: {}, openReports: 0 };

describe("model calls (llm.ts)", () => {
  it("charges the budget before the call and sends the key only as a header", async () => {
    const calls: Call[] = [];
    const budget = createBudget({ llmTokens: 10_000, transactions: 1, campaigns: 1, organisations: 1 });
    const answer = await ask({
      apiKey: "sk-test-key", model: "m", system: "s".repeat(30), user: "u".repeat(30), maxTokens: 50, budget,
      fetch: async (url, init) => { calls.push({ url, init: init! }); return modelAnswer("[]"); },
    });
    expect(answer.text).toBe("[]");
    expect(budget.used().llmTokens).toBe(10 + 10 + 50);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test-key");
    expect(String(calls[0]!.init.body)).not.toContain("sk-test-key");
  });

  it("refuses a call that would pass the token cap — nothing is sent", async () => {
    let sent = 0;
    const budget = createBudget({ llmTokens: 40, transactions: 1, campaigns: 1, organisations: 1 });
    await expect(ask({ apiKey: "k", model: "m", system: "s", user: "u", maxTokens: 50, budget, fetch: async () => { sent++; return modelAnswer("[]"); } }))
      .rejects.toBeInstanceOf(BudgetExceeded);
    expect(sent).toBe(0);
  });

  it("does not echo an error body", async () => {
    const budget = createBudget();
    await expect(ask({ apiKey: "k", model: "m", system: "s", user: "u", maxTokens: 5, budget, fetch: async () => json(401, { error: "secret k" }) }))
      .rejects.toThrow(/^model call answered 401$/);
  });

  it("finds the JSON in a chatty answer", () => {
    expect(firstJson('Here you go:\n[{"a":1}]\nThanks')).toEqual([{ a: 1 }]);
    expect(() => firstJson("no plan today")).toThrow("no JSON");
  });
});

describe("dispatcher (dispatcher.ts)", () => {
  it("the default plan is valid and covers every runnable task", () => {
    const plan = defaultPlan({});
    expect(plan.map((p) => p.task).sort()).toEqual([...new Set(DEFAULT_PLAN.map((p) => p.task))].sort().flatMap((t) => DEFAULT_PLAN.filter((p) => p.task === t).map(() => t)));
    expect(plan.find((p) => p.task === "donate")!.model).toBe("claude-haiku-5-5");
  });

  it("without a key it runs the default plan and says why", async () => {
    const r = await planRun(summary, { budget: createBudget(), env: {} });
    expect([r.source, r.reason]).toEqual(["default", "no ANTHROPIC_API_KEY"]);
  });

  it("uses the dispatcher's plan on the dispatcher model when it keeps the rules", async () => {
    let body = "";
    const r = await planRun(summary, {
      apiKey: "k", budget: createBudget(), env: {},
      fetch: async (_u, init) => { body = String(init!.body); return modelAnswer('[{"task":"awkward-use","agent":"awkward-1","tier":"routine"},{"task":"donate","agent":"donor-3"}]'); },
    });
    expect(JSON.parse(body).model).toBe("claude-opus-5-5");
    expect(r.source).toBe("dispatcher");
    expect(r.plan.map((p) => [p.agent, p.task, p.model])).toEqual([["awkward-1", "awkward-use", "claude-haiku-5-5"], ["donor-3", "donate", "claude-haiku-5-5"]]);
  });

  it.each([
    ["a persona doing another's task", '[{"task":"pool-give","agent":"donor-1"}]', "cannot do pool-give"],
    ["a task the runner cannot do yet", '[{"task":"start-campaign","agent":"fundraiser-1"}]', "not runnable yet"],
    ["work on the dispatcher's model", '[{"task":"donate","agent":"donor-1","tier":"dispatcher"}]', "dispatcher's model"],
    ["the treasury", '[{"task":"donate","agent":"treasury"}]', "cannot do donate"],
    ["an empty plan", "[]", "empty plan"],
    ["prose", "I would donate first.", "no JSON"],
  ])("falls back to the default plan on %s", async (_what, text, reason) => {
    const r = await planRun(summary, { apiKey: "k", budget: createBudget(), env: {}, fetch: async () => modelAnswer(text) });
    expect(r.source).toBe("default");
    expect(r.reason).toContain(reason);
    expect(r.plan.length).toBe(DEFAULT_PLAN.length);
  });

  it("caps a plan at eight tasks", () => {
    const many = Array.from({ length: 9 }, () => ({ task: "donate", agent: "donor-1" }));
    expect(() => checkRunnable(placeAssignments(many, names, {}))).toThrow("more than 8");
  });

  it("falls back when the budget cannot pay for the dispatcher", async () => {
    const r = await planRun(summary, { apiKey: "k", budget: createBudget({ llmTokens: 10, transactions: 1, campaigns: 1, organisations: 1 }), env: {}, fetch: async () => modelAnswer("[]") });
    expect([r.source, r.reason]).toEqual(["default", "budget reached: llmTokens (cap 10)"]);
  });
});

describe("observations (observe.ts)", () => {
  it("returns at most three short strings and nothing without a key or model", async () => {
    const budget = createBudget();
    const fetch = async () => modelAnswer(`["one","${"x".repeat(300)}",3,"three","four"]`);
    const r = await observe({ model: "claude-haiku-5-5", task: "donate", pageText: "Donate" }, { apiKey: "k", budget, fetch });
    expect(r).toEqual(["one", "x".repeat(160), "three"]);
    expect(await observe({ model: null, task: "t", pageText: "p" }, { apiKey: "k", budget, fetch })).toEqual([]);
    expect(await observe({ model: "m", task: "t", pageText: "p" }, { budget, fetch })).toEqual([]);
    expect(await observe({ model: "m", task: "t", pageText: "p" }, { apiKey: "k", budget, fetch: async () => json(500, {}) })).toEqual([]);
  });
});

describe("bug reports (reports.ts)", () => {
  const bug: Bug = { flow: "crew", agent: "donor-1", persona: "donor", step: "donate on chain", detail: "page said 1.0963 USDC; donated(donor-1) 2.19 → 2.19 at 0x663911aae7ac357ed7c7d3cb9dc82770eabcce4d", path: "/en/campaigns/x" };
  const ctx = { runUrl: "https://github.com/o/r/actions/runs/1", imageSha: "abc1234", secrets: ["https://rpc.example/KEY123456"] };

  it("ignores amounts, addresses and the agent in the fingerprint, not the step or persona", () => {
    const again = { ...bug, agent: "donor-2", detail: "page said 5 USDC; donated(donor-2) 7 → 7 at 0x2d8aeed91824ba23de9589d94fc9d20bc102584a" };
    expect(normalizeDetail(again.detail)).toBe("page said # usdc; donated(donor-#) # → # at ⟨hex⟩");
    expect(fingerprint(again)).toBe(fingerprint(bug));
    expect(fingerprint({ ...bug, step: "indexed" })).not.toBe(fingerprint(bug));
    expect(fingerprint({ ...bug, persona: "awkward" })).not.toBe(fingerprint(bug));
    expect(fingerprint(bug)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("redacts the body and carries the marker", () => {
    const body = issueBody({ ...bug, detail: `failed at https://rpc.example/KEY123456 key ${"ab".repeat(32)}` }, ctx);
    expect(body.startsWith(marker(fingerprint({ ...bug, detail: "x" })).slice(0, 24))).toBe(true);
    expect(body).not.toContain("KEY123456");
    expect(body).not.toContain("ab".repeat(32));
    expect(body).toContain("https://testnet.cherr.io/en/campaigns/x");
  });

  it("sends nothing without a token or a valid repository", async () => {
    let sent = 0;
    const fetch = async () => { sent++; return json(200, []); };
    expect((await fileReports([bug], { ctx, fetch })).skipped).toHaveLength(1);
    expect((await fileReports([bug], { token: "t", repo: "not a repo", ctx, fetch })).skipped).toHaveLength(1);
    expect(sent).toBe(0);
  });

  it("comments on the open issue with the same fingerprint, opens one for a new bug, once per fingerprint", async () => {
    const calls: Call[] = [];
    const other: Bug = { ...bug, step: "pool give on chain", persona: "pool", agent: "pool-1" };
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      if (url.includes("/issues?labels=")) return json(200, [{ number: 7, body: `${marker(fingerprint(bug))}\nold` }, { number: 8, body: "x", pull_request: {} }]);
      if (url.endsWith("/issues/7/comments")) return json(201, { id: 1 });
      if (url.endsWith("/issues")) return json(201, { number: 9 });
      return json(404, {});
    };
    const r = await fileReports([bug, { ...bug, agent: "donor-2" }, other], { token: "t", repo: "DataVallis-CHERR-IO/cherrio-agent-reports", ctx, fetch });
    expect(r).toEqual({ created: [9], commented: [7], skipped: [] });
    expect(calls.map((c) => [c.init.method ?? "GET", c.url.replace("https://api.github.com/repos/DataVallis-CHERR-IO/cherrio-agent-reports", "")]))
      .toEqual([["GET", "/issues?labels=agent-report&state=open&per_page=100&page=1"], ["POST", "/issues/7/comments"], ["POST", "/issues"]]);
    const created = JSON.parse(String(calls[2]!.init.body));
    expect(created.labels).toEqual(["agent-report"]);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  it("cannot break out of the code block, ping anyone or forge a fingerprint", () => {
    const body = issueBody({ ...bug, detail: "x\n```\n@david see <!-- agent-fingerprint: 0000000000000000 --> [link](https://evil.example)" }, ctx);
    expect(body.match(/```/g)).toHaveLength(2);
    expect(body).not.toMatch(/@david/);
    expect(body.match(/<!-- agent-fingerprint/g)).toHaveLength(1);
  });

  it(`opens at most ${MAX_NEW_ISSUES} new issues per run`, async () => {
    let n = 0;
    const bugs = Array.from({ length: MAX_NEW_ISSUES + 3 }, (_, i) => ({ ...bug, step: `step ${"abcdefghijklmnop"[i]}` }));
    const r = await fileReports(bugs, { token: "t", repo: "o/r", ctx, fetch: async (url) => (url.includes("labels=") ? json(200, []) : json(201, { number: ++n })) });
    expect([r.created.length, r.skipped.length]).toEqual([MAX_NEW_ISSUES, 3]);
  });
});

describe("run log prose (runlog.ts)", () => {
  it("keeps model remarks readable but still removes the exact mnemonic and keys", () => {
    const phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const remark = "please make this donate button much clearer because people often miss where their money goes";
    expect(redact({ remarks: [remark] })).toEqual({ remarks: [remark] });
    expect(redact({ remarks: [`${phrase} ${"cd".repeat(32)}`] }, undefined, [phrase])).toEqual({ remarks: ["[redacted] [redacted]"] });
    expect(redact({ detail: remark })).toEqual({ detail: "[redacted]" });
  });
});
