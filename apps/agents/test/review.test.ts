import { describe, expect, it } from "vitest";
import { createBudget } from "../src/budget.js";
import { ATTACHMENT_TOKENS, ask } from "../src/llm.js";
import { auditNote, checkOrganisation, classify, parseVerdict, type OrgApplication } from "../src/review.js";
import { decide } from "../src/staff-review.js";
import { fileHolds, holdMarker, type Hold } from "../src/reports.js";
import { DEFAULT_PLAN, checkRunnable, defaultPlan } from "../src/dispatcher.js";
import { placeAssignments } from "../src/models.js";
import { CREW } from "../src/crew.js";
import { marker } from "../src/fundraiser.js";

// TASK-061e part 2: the staff agent's organisation review. No network: every HTTP call goes to a fake.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const modelAnswer = (text: string) => json(200, { content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 20 } });
const CREW_ADDRESS = "0xa8fa000000000000000000000000000000004d48";
const budget = () => createBudget({ llmTokens: 100_000, transactions: 1, campaigns: 1, organisations: 1 });

const app = (over: Partial<OrgApplication> = {}): OrgApplication => ({
  submissionId: "0b4f2c1e-0000-4000-8000-000000000001",
  name: "Lantern Hill Reading Fund (testnet)",
  legalName: "Lantern Hill Reading Fund Association (testnet)",
  country: "SI",
  website: "",
  description: `Volunteers read with children after school.\n\n${marker("fundraiser-1", "organisation")}`,
  causes: ["education", "children"],
  payoutAddress: "0xA8fa000000000000000000000000000000004D48",
  applicantIsAgent: true,
  documents: [
    { kind: "Extract from the register", href: "/api/admin/files/11111111-1111-4111-8111-111111111111" },
    { kind: "Proof of representation", href: "/api/admin/files/22222222-2222-4222-8222-222222222222" },
  ],
  ...over,
});

describe("deterministic checks (checkOrganisation)", () => {
  it("a crew application as fundraiser.ts writes it passes", () => {
    expect(checkOrganisation(app(), [CREW_ADDRESS])).toEqual([]);
  });

  it.each([
    ["a person, not an agent", { applicantIsAgent: false }, "the applicant is not a testnet agent"],
    ["payout to a foreign wallet", { payoutAddress: "0x1111111111111111111111111111111111111111" }, "the payout address is not a crew wallet"],
    ["a sanctioned country", { country: "KP" }, "the country is unknown or under sanctions"],
    ["a link in the description", { description: `See www.example.org. ${marker("fundraiser-1", "organisation")}` }, "the description has a link, e-mail, address or long number"],
    ["a phone number in the name", { name: "Call 040 123 456 (testnet)" }, "the name has a link, e-mail, address or long number"],
    ["no marker", { description: "Volunteers read with children after school." }, "the description has no testnet agent marker"],
    ["a website", { website: "https://example.org" }, "a website is given (crew organisations have none)"],
    ["a missing document", { documents: [] }, "document missing: Extract from the register"],
    ["an unknown cause", { causes: ["politics"] }, "causes are missing or unknown"],
  ] as const)("%s → hold", (_what, over, reason) => {
    expect(checkOrganisation(app(over as Partial<OrgApplication>), [CREW_ADDRESS])).toContain(reason);
  });
});

describe("classifier (classify) — fail closed", () => {
  it("parses only pass / hold with a list of one-line texts", () => {
    expect(parseVerdict({ verdict: "pass", reasons: [] })).toEqual({ verdict: "pass", reasons: [] });
    expect(parseVerdict({ verdict: "hold", reasons: [] })).toEqual({ verdict: "hold", reasons: ["held without a reason"] });
    expect(parseVerdict({ verdict: "hold", reasons: ["a\nb", "x".repeat(300)] }).reasons).toEqual(["a b", "x".repeat(200)]);
    expect(() => parseVerdict({ verdict: "approve", reasons: [] })).toThrow();
    expect(() => parseVerdict({ verdict: "pass", reasons: "fine" })).toThrow();
    expect(() => parseVerdict(["pass"])).toThrow();
  });

  it.each([
    ["no key", { model: "m" }, "no classifier (ANTHROPIC_API_KEY missing)"],
    ["no model", { model: null, apiKey: "k" }, "no classifier (ANTHROPIC_API_KEY missing)"],
    ["HTTP 500", { model: "m", apiKey: "k", fetch: async () => json(500, {}) }, "classifier failed (model call answered 500)"],
    ["prose instead of JSON", { model: "m", apiKey: "k", fetch: async () => modelAnswer("Looks fine to me!") }, "classifier failed (no JSON in the answer)"],
    ["an unknown verdict", { model: "m", apiKey: "k", fetch: async () => modelAnswer('{"verdict":"approve","reasons":[]}') }, "classifier failed (the verdict is neither pass nor hold)"],
  ] as const)("%s → hold", async (_what, o, reason) => {
    expect(await classify({}, [], { budget: budget(), ...o } as never)).toEqual({ verdict: "hold", reasons: [reason], failed: true });
  });

  it("the budget is spent before the call: a cap reached holds without sending", async () => {
    let sent = 0;
    const tiny = createBudget({ llmTokens: 50, transactions: 1, campaigns: 1, organisations: 1 });
    const v = await classify({}, [], { model: "m", apiKey: "k", budget: tiny, fetch: async () => { sent++; return modelAnswer('{"verdict":"pass","reasons":[]}'); } });
    expect(v).toEqual({ verdict: "hold", reasons: ["classifier failed (budget: llmTokens)"], failed: true });
    expect(sent).toBe(0);
  });

  it("sends documents as image / document blocks before the text, and counts them", async () => {
    let body: { messages: { content: { type: string; source?: { media_type: string } }[] }[] } | null = null;
    const b = budget();
    await ask({
      apiKey: "k", model: "m", system: "s", user: "u", maxTokens: 10, budget: b,
      attachments: [{ mediaType: "application/pdf", data: Buffer.from("%PDF") }, { mediaType: "image/png", data: Buffer.from("png") }],
      fetch: async (_u, init) => { body = JSON.parse(String(init!.body)); return modelAnswer("{}"); },
    });
    expect(body!.messages[0]!.content.map((c) => c.type)).toEqual(["document", "image", "text"]);
    expect(body!.messages[0]!.content[1]!.source!.media_type).toBe("image/png");
    expect(b.used().llmTokens).toBeGreaterThanOrEqual(2 * ATTACHMENT_TOKENS);
  });
});

describe("decision (decide)", () => {
  it("failed checks hold without reading documents or calling the model", async () => {
    let read = 0;
    let sent = 0;
    const v = await decide(app({ applicantIsAgent: false }), async () => { read++; return []; },
      { secret: null, crewAddresses: [CREW_ADDRESS], model: "m", apiKey: "k", budget: budget(), holds: [], fetch: async () => { sent++; return modelAnswer("{}"); } });
    expect(v.verdict).toBe("hold");
    expect([read, sent]).toEqual([0, 0]);
  });

  it("an unreadable document holds; checks + classifier pass → pass, and the model never sees the file links", async () => {
    const o = { secret: null, crewAddresses: [CREW_ADDRESS], model: "m", apiKey: "k", budget: budget(), holds: [] };
    expect(await decide(app(), async () => { throw new Error("download answered 403"); }, o))
      .toEqual({ verdict: "hold", reasons: ["documents could not be read (download answered 403)"] });
    let user = "";
    const v = await decide(app(), async () => [], { ...o, fetch: async (_u, init) => { user = JSON.parse(String(init!.body)).messages[0].content; return modelAnswer('{"verdict":"pass","reasons":[]}'); } });
    expect(v).toEqual({ verdict: "pass", reasons: [] });
    expect(user).toContain("Lantern Hill Reading Fund (testnet)");
    expect(user).not.toContain("/api/admin/files/");
    expect(auditNote("claude-sonnet-5-5", v).length).toBeLessThanOrEqual(500);
  });
});

describe("hold issues (fileHolds)", () => {
  const ctx = { runUrl: "https://github.com/x/y/actions/runs/1", imageSha: "abc", secrets: ["s3cret-value"] };
  const hold: Hold = { kind: "organisation", id: "sub-1", name: "Odd @org", path: "/en/admin/kyb/sub-1", reasons: ["mentions s3cret-value\nand more"] };

  it("one issue per held submission, labelled agent-hold, redacted; an open one is not repeated", async () => {
    const posted: { title: string; body: string; labels: string[] }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      if (!init?.method) return json(200, [{ body: `x ${holdMarker({ kind: "organisation", id: "sub-2" })}` }]);
      posted.push(JSON.parse(String(init.body)));
      expect(url).toBe("https://api.github.com/repos/o/r/issues");
      return json(201, { number: 7 });
    };
    const r = await fileHolds([hold, { ...hold, id: "sub-2" }], { token: "t", repo: "o/r", ctx, fetch });
    expect(r).toEqual({ created: [7], commented: [], skipped: ["organisation:sub-2"] });
    expect(posted[0]!.labels).toEqual(["agent-hold"]);
    expect(posted[0]!.title).toBe("[agent-hold] organisation: Odd @​org");
    expect(posted[0]!.body).toContain(holdMarker(hold));
    expect(posted[0]!.body).toContain("https://testnet.cherr.io/en/admin/kyb/sub-1");
    expect(posted[0]!.body).not.toContain("s3cret-value");
  });

  it("without a token nothing is sent", async () => {
    let sent = 0;
    const r = await fileHolds([hold], { ctx, fetch: async () => { sent++; return json(200, []); } });
    expect([r.skipped, sent]).toEqual([["organisation:sub-1"], 0]);
  });
});

describe("plan", () => {
  it("the default plan reviews once, with the staff agent, after the applications and before start-campaign", () => {
    const tasks = defaultPlan({}).map((p) => `${p.agent} ${p.task}`);
    const at = (t: string) => tasks.indexOf(t);
    expect(tasks.filter((t) => t.endsWith("review-submission"))).toEqual(["staff review-submission"]);
    expect(at("staff review-submission")).toBeGreaterThan(at("fundraiser-2 start-organisation"));
    expect(at("staff review-submission")).toBeLessThan(at("fundraiser-1 start-campaign"));
    // The red team (061f) applies and tries its scam before the review, so the staff agent sees it the same run.
    expect(at("staff review-submission")).toBeGreaterThan(at("scammer-1 scam-campaign"));
    expect(at("scammer-1 scam-campaign")).toBeGreaterThan(at("scammer-1 start-organisation"));
    expect(DEFAULT_PLAN.length).toBe(11);
  });

  it("only the staff agent may review, and only on the review tier", () => {
    const names = CREW.map((c) => c.name);
    expect(() => checkRunnable(placeAssignments([{ task: "review-submission", agent: "donor-1" }], names, {}))).toThrow("donor-1 cannot do review-submission");
    expect(() => placeAssignments([{ task: "review-submission", agent: "staff", tier: "routine" }], names, {})).toThrow("review tier");
  });
});
