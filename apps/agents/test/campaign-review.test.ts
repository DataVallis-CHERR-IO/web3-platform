import { describe, expect, it } from "vitest";
import { createBudget } from "../src/budget.js";
import { MAX_CREW_GOAL_EUR, checkCampaign, goalAsSet, type CampaignSubmission } from "../src/review.js";
import { decideCampaign } from "../src/staff-review.js";
import { CAUSE_LABELS, COUNTRY, marker } from "../src/fundraiser.js";

// TASK-061e part 2, step 2b: the staff agent's campaign review. No network: every HTTP call goes to a fake.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const modelAnswer = (text: string) => json(200, { content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 20 } });
const CREW_ADDRESS = "0xa8fa000000000000000000000000000000004d48";
const budget = () => createBudget({ llmTokens: 100_000, transactions: 1, campaigns: 1, organisations: 1 });
const CHECKS = { causeLabels: Object.values(CAUSE_LABELS), country: COUNTRY.option };

/** A crew campaign as the admin page shows it (fundraiser.ts `startCampaign`). */
const campaign = (over: Partial<CampaignSubmission> = {}): CampaignSubmission => ({
  campaignId: "0b4f2c1e-0000-4000-8000-000000000002",
  title: "Books and Reading Corners for a Small Village Library",
  cause: CAUSE_LABELS.education,
  country: "Slovenia",
  goal: "€100",
  duration: "21 days",
  payoutAddress: "0xA8fa000000000000000000000000000000004D48",
  story: `Volunteers want two reading corners.\n\nEvery euro buys books.\n\n${marker("fundraiser-1", "campaign")}`,
  starterIsAgent: true,
  coverUrl: "http://127.0.0.1:9090/cherrio-public-local/campaigns/0b4f2c1e-0000-4000-8000-000000000002/c-1.webp",
  noExtraMedia: true,
  ...over,
});

describe("deterministic checks (checkCampaign)", () => {
  it("a crew campaign as fundraiser.ts writes it passes, for both fundraisers", () => {
    expect(checkCampaign(campaign(), [CREW_ADDRESS], CHECKS)).toEqual([]);
    // The marker's agent name has a digit; it must not count as a "long number".
    const second = campaign({ story: `Cushions for a reading corner.\n\n${marker("fundraiser-2", "campaign")}` });
    expect(checkCampaign(second, [CREW_ADDRESS], CHECKS)).toEqual([]);
  });

  it.each([
    ["a person's campaign", { starterIsAgent: false }, "the starter is not a testnet agent"],
    ["payout to a foreign wallet", { payoutAddress: "0x1111111111111111111111111111111111111111" }, "the payout address is not a crew wallet"],
    ["no payout address yet", { payoutAddress: "" }, "the payout address is not a crew wallet"],
    ["no marker", { story: "Volunteers want two reading corners." }, "the story has no testnet agent marker"],
    ["an organisation marker", { story: `Corners.\n\n${marker("fundraiser-1", "organisation")}` }, "the story has no testnet agent marker"],
    ["a link in the story", { story: `See www.example.org.\n\n${marker("fundraiser-1", "campaign")}` }, "the story has a link, e-mail, address or long number"],
    ["an IBAN-like number in the story", { story: `Pay to SI56 0201 0001 2345 678.\n\n${marker("fundraiser-1", "campaign")}` }, "the story has a link, e-mail, address or long number"],
    ["an e-mail in the title", { title: "Write to help@example.org" }, "the title has a link, e-mail, address or long number"],
    ["an unknown cause", { cause: "Politics" }, "the cause is unknown"],
    ["another country", { country: "Croatia" }, "the country is not Slovenia (crew campaigns are)"],
    ["a US dollar goal", { goal: "$100" }, "the goal is not in euros (crew campaigns are)"],
    ["a large goal", { goal: "€25,000" }, `the goal is above €${MAX_CREW_GOAL_EUR}`],
    ["no cover", { coverUrl: "" }, "there is no cover image"],
    ["gallery or documents", { noExtraMedia: false }, "there are gallery images, videos or documents (crew campaigns have none)"],
  ] as const)("%s → hold", (_what, over, reason) => {
    expect(checkCampaign(campaign(over as Partial<CampaignSubmission>), [CREW_ADDRESS], CHECKS)).toContain(reason);
  });

  it("the goal limit is inclusive, in cents, and reads thousands separators", () => {
    expect(checkCampaign(campaign({ goal: "€1,000" }), [CREW_ADDRESS], CHECKS)).toEqual([]);
    expect(checkCampaign(campaign({ goal: "€1,000.50" }), [CREW_ADDRESS], CHECKS)).toContain(`the goal is above €${MAX_CREW_GOAL_EUR}`);
    expect(checkCampaign(campaign({ goal: "€1,001" }), [CREW_ADDRESS], CHECKS)).toContain(`the goal is above €${MAX_CREW_GOAL_EUR}`);
  });

  it("only the goal as set counts, not the display-currency conversion in front of it", () => {
    // Display currency USD (Playwright's en-US default): "≈ $117 (€100)".
    expect(checkCampaign(campaign({ goal: "≈ $117 (€100)" }), [CREW_ADDRESS], CHECKS)).toEqual([]);
    expect(checkCampaign(campaign({ goal: "≈ $14,081 (€12,000)" }), [CREW_ADDRESS], CHECKS)).toContain(`the goal is above €${MAX_CREW_GOAL_EUR}`);
    // Display currency EUR and a US dollar goal: not euros, even though a € amount is shown first.
    expect(checkCampaign(campaign({ goal: "≈ €92 ($100)" }), [CREW_ADDRESS], CHECKS)).toContain("the goal is not in euros (crew campaigns are)");
    expect(checkCampaign(campaign({ goal: "€1.000" }), [CREW_ADDRESS], CHECKS)).toContain("the goal is not in euros (crew campaigns are)");
  });
});

describe("goal as set (goalAsSet)", () => {
  it("drops the display conversion the model read as a second amount (run 45683594846)", () => {
    expect(goalAsSet("≈ $109.35 (€100)")).toBe("€100");
    expect(goalAsSet("€100")).toBe("€100");
  });
});

describe("decision (decideCampaign)", () => {
  const options = (fetch?: (u: string, init?: RequestInit) => Promise<Response>) =>
    ({ secret: null, crewAddresses: [CREW_ADDRESS], model: "m", apiKey: "k", budget: budget(), holds: [], fetch });

  it("failed checks hold without reading the cover or calling the model", async () => {
    let read = 0;
    let sent = 0;
    const v = await decideCampaign(campaign({ starterIsAgent: false }), async () => { read++; return []; },
      options(async () => { sent++; return modelAnswer("{}"); }));
    expect(v.verdict).toBe("hold");
    expect([read, sent]).toEqual([0, 0]);
  });

  it("an unreadable cover holds; a hold from the model holds; checks + pass → pass without the cover link", async () => {
    expect(await decideCampaign(campaign(), async () => { throw new Error("cover: type text/html is not checked"); }, options()))
      .toEqual({ verdict: "hold", reasons: ["cover could not be read (cover: type text/html is not checked)"], failed: true });
    expect(await decideCampaign(campaign(), async () => [], options(async () => modelAnswer('{"verdict":"hold","reasons":["odd cover"]}'))))
      .toEqual({ verdict: "hold", reasons: ["odd cover"] });

    let user = "";
    const v = await decideCampaign(campaign({ goal: "≈ $109.35 (€100)" }), async () => [{ mediaType: "image/webp", data: Buffer.from("RIFF") }], options(async (_u, init) => {
      const content = JSON.parse(String(init!.body)).messages[0].content as { type: string; text?: string; source?: { media_type: string } }[];
      user = JSON.stringify(content);
      return modelAnswer('{"verdict":"pass","reasons":[]}');
    }));
    expect(v).toEqual({ verdict: "pass", reasons: [] });
    expect(user).toContain("Books and Reading Corners for a Small Village Library");
    expect(user).toContain('"media_type":"image/webp"');
    expect(user).toContain('\\"goal\\":\\"€100\\"');
    expect(user).not.toContain("cherrio-public-local");
  });
});
