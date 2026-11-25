import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ORGANIZATION_CAUSES } from "@cherrio/shared";
import { BudgetExceeded, createBudget } from "../src/budget.js";
import { checkRunnable } from "../src/dispatcher.js";
import { placeAssignments } from "../src/models.js";
import { CREW } from "../src/crew.js";
import { CAUSE_LABELS, campaignText, checkText, marker, orgText, writeCampaign, writeOrg } from "../src/fundraiser.js";

// TASK-061e: the fundraiser's texts are model output = data. No network: every call goes to a fake.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const modelAnswer = (text: string) => async () => json(200, { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 } });
const story = "Our shelter keeps about thirty dogs in outdoor kennels. Before the frost we insulate them and buy straw. Volunteers do all the work; every euro goes into materials.";

describe("fundraiser texts (fundraiser.ts)", () => {
  it("refuses links, e-mail, wallet addresses and account-like numbers, and texts out of range", () => {
    expect(checkText("A plain sentence about dogs.", 5, 100)).toBe("A plain sentence about dogs.");
    for (const bad of [
      "Pay at https://example.org today",
      "write to help@shelter.org",
      "send to 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      "IBAN SI56 1910 0000 0123 438",
      "call 040 123 456",
      "www.shelter.org",
    ]) expect(checkText(bad, 5, 100), bad).toBeNull();
    expect(checkText("tiny", 5, 100)).toBeNull();
    expect(checkText("x".repeat(101), 5, 100)).toBeNull();
    expect(checkText(42, 1, 100)).toBeNull();
    expect(checkText("Hill Dog\n::error::forged", 5, 100, true)).toBeNull();
    expect(checkText("First paragraph.\n\nSecond paragraph.", 5, 100)).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("always adds the testnet suffix and the agent marker, and needs a known cause", () => {
    const org = orgText({ name: "Hill Dog Rescue", description: "We rescue abandoned dogs and find them new homes nearby.", cause: "animals" }, "fundraiser-1")!;
    expect(org.name).toBe("Hill Dog Rescue (testnet)");
    expect(org.description.endsWith(marker("fundraiser-1", "organisation"))).toBe(true);
    expect(orgText({ name: "Hill Dog Rescue", description: "We rescue abandoned dogs and find them new homes nearby.", cause: "weapons" }, "f")).toBeNull();
    const campaign = campaignText({ title: "Warm kennels for winter", story, cause: "animals" }, "fundraiser-2")!;
    expect(campaign.story).toContain("testnet agent fundraiser-2");
    expect(campaignText({ title: "Warm kennels", story: "too short", cause: "animals" }, "f")).toBeNull();
  });

  it("uses the model's text when it keeps the rules, the fixed text otherwise — and says which", async () => {
    const budget = createBudget();
    const good = await writeOrg("fundraiser-1", { model: "m", apiKey: "k", budget,
      fetch: modelAnswer('Sure: {"name":"Hill Dog Rescue","description":"We rescue abandoned dogs and find them new homes nearby.","cause":"animals"}') });
    expect(good).toMatchObject({ source: "m", text: { name: "Hill Dog Rescue (testnet)" } });

    const withLink = await writeCampaign("fundraiser-1", { model: "m", apiKey: "k", budget,
      fetch: modelAnswer(JSON.stringify({ title: "Warm kennels for winter", story: `${story} Donate at https://evil.example`, cause: "animals" })) });
    expect(withLink.source).toBe("fixed text (model answer refused)");
    expect(withLink.text.title).toBe("Warm kennels for the winter");

    expect((await writeOrg("fundraiser-1", { model: null, apiKey: "k", budget })).source).toBe("fixed text (no model)");
    expect((await writeOrg("fundraiser-1", { model: "m", apiKey: "k", budget, fetch: async () => json(500, {}) })).source).toBe("fixed text (model call answered 500)");
  });

  it("does not swallow a budget stop", async () => {
    const budget = createBudget({ llmTokens: 10, transactions: 1, campaigns: 1, organisations: 1 });
    await expect(writeOrg("fundraiser-1", { model: "m", apiKey: "k", budget, fetch: modelAnswer("{}") })).rejects.toBeInstanceOf(BudgetExceeded);
  });

  it("the cause labels are the app's English labels", () => {
    const en = JSON.parse(readFileSync(new URL("../../web/messages/en.json", import.meta.url), "utf8")) as { organizations: { form: { causeNames: Record<string, string> } } };
    expect(CAUSE_LABELS).toEqual(en.organizations.form.causeNames);
    expect(Object.keys(CAUSE_LABELS).sort()).toEqual([...ORGANIZATION_CAUSES].sort());
  });

  it("only a fundraiser may start organisations and campaigns", () => {
    const names = CREW.map((c) => c.name);
    expect(() => checkRunnable(placeAssignments([{ task: "start-campaign", agent: "donor-1" }], names, {}))).toThrow("donor-1 cannot do start-campaign");
    const ok = checkRunnable(placeAssignments([{ task: "start-organisation", agent: "fundraiser-2" }], names, {}));
    expect(ok[0]).toMatchObject({ tier: "explore", model: "claude-sonnet-5-5" });
  });
});
