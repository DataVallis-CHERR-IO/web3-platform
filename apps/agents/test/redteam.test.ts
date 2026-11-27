/**
 * TASK-061f red team: the scams are real tests of the review, never content that could
 * slip through quietly. Each scam must fit the app's form, carry the agent marker, and
 * be meant for the layer that should stop it.
 */
import { describe, expect, it } from "vitest";
import { CAMPAIGN_LIMITS } from "@cherrio/shared/campaigns";
import { AGENT_CREW } from "@cherrio/shared/agent-crew";
import { SCAMS, RED_TEAM_CAUGHT, RED_TEAM_MISSED, redTeamNote, redTeamOutcome, scamFor } from "../src/redteam.js";
import { isRedTeam } from "../src/staff-review.js";
import { classify } from "../src/review.js";
import { createBudget } from "../src/budget.js";
import { CAUSE_LABELS, COUNTRY, marker } from "../src/fundraiser.js";
import { checkCampaign, type CampaignSubmission } from "../src/review.js";
import { CREW } from "../src/crew.js";
import { checkRunnable, defaultPlan } from "../src/dispatcher.js";
import { placeAssignments } from "../src/models.js";

const scammer = AGENT_CREW.find((c) => c.persona === "redteam")!;
const submission = (i: number): CampaignSubmission => {
  const s = SCAMS[i]!;
  return {
    campaignId: "00000000-0000-0000-0000-000000000000", title: s.title, cause: CAUSE_LABELS[s.cause], country: COUNTRY.option,
    goal: `€${s.goalEur}`, duration: "21 days", payoutAddress: scammer.address,
    story: `${s.story}\n\n${marker(scammer.name, "campaign")}`, starterIsAgent: true, coverUrl: "https://example.test/c.webp", noExtraMedia: true,
  };
};
const checks = (i: number) => checkCampaign(submission(i), AGENT_CREW.map((c) => c.address), { causeLabels: Object.values(CAUSE_LABELS), country: COUNTRY.option });

describe("red team (redteam.ts)", () => {
  it("is one registry member, index 9, never the staff or a fundraiser", () => {
    expect(scammer).toMatchObject({ index: 9, name: "scammer-1", address: "0x0e9cab8003981f8fb07a608e7b2d8d037370d83b" });
    expect(AGENT_CREW.filter((c) => c.persona === "redteam")).toHaveLength(1);
  });

  it("tries every scam once in six days", () => {
    const day = Date.UTC(2026, 10, 28);
    const ids = Array.from({ length: SCAMS.length }, (_, i) => scamFor(new Date(day + i * 86_400_000)).id);
    expect(new Set(ids).size).toBe(SCAMS.length);
    expect(scamFor(new Date(day)).id).toBe(scamFor(new Date(day + 3_600_000)).id); // one scenario per day
  });

  it.each(SCAMS.map((s, i) => [s.id, i] as const))("%s fits the form and is meant for the right layer", (_id, i) => {
    const s = SCAMS[i]!;
    const story = submission(i).story;
    expect(s.title.length).toBeGreaterThanOrEqual(CAMPAIGN_LIMITS.title.min);
    expect(s.title.length).toBeLessThanOrEqual(CAMPAIGN_LIMITS.title.max);
    expect(story.length).toBeGreaterThanOrEqual(CAMPAIGN_LIMITS.story.min);
    expect(s.goalEur).toBeGreaterThanOrEqual(CAMPAIGN_LIMITS.goal.min);
    expect(story).toContain("Created by the CHERR.IO testnet agent scammer-1.");
    // "checks" scams are stopped by the fixed checks; "classifier" scams must pass them, so the model is what is tested.
    if (s.expected === "checks") expect(checks(i)).not.toEqual([]);
    else expect(checks(i)).toEqual([]);
  });

  it("writes the rejection note the public page counts, within the app's 10–1,000 characters", () => {
    expect(redTeamNote(true, ["asks to pay outside the platform"])).toBe(`${RED_TEAM_CAUGHT} — asks to pay outside the platform`);
    expect(redTeamNote(false, [])).toMatch(new RegExp(`^${RED_TEAM_MISSED} — `));
    const long = redTeamNote(true, Array.from({ length: 20 }, () => "x".repeat(200)));
    expect(long.length).toBeLessThanOrEqual(1000);
    expect(redTeamNote(true, ["line\nbreak"])).not.toMatch(/\n/);
  });

  it("fails closed: the registry's red team is always recognised, whatever the caller passes", () => {
    expect(isRedTeam(scammer.address.toUpperCase().replace("0X", "0x"))).toBe(true); // checksum-ish casing from the page
    expect(isRedTeam(scammer.address, [])).toBe(true);
    expect(isRedTeam("0x0000000000000000000000000000000000000001", ["0x0000000000000000000000000000000000000001"])).toBe(true);
    for (const c of AGENT_CREW.filter((m) => m.persona !== "redteam")) expect(isRedTeam(c.address)).toBe(false);
  });

  it("a failed check is inconclusive, never a catch; a pass is a miss", async () => {
    expect(redTeamOutcome({ verdict: "hold" })).toBe("caught");
    expect(redTeamOutcome({ verdict: "pass" })).toBe("missed");
    expect(redTeamOutcome(await classify({}, [], { model: null, budget: createBudget() }))).toBe("inconclusive");
    const http500 = async () => new Response("{}", { status: 500 });
    expect(redTeamOutcome(await classify({}, [], { model: "m", apiKey: "k", budget: createBudget(), fetch: http500 }))).toBe("inconclusive");
  });

  it("only the red team may submit scams, and it does nothing else but its organisation", () => {
    const names = CREW.map((c) => c.name);
    expect(() => checkRunnable(placeAssignments([{ task: "scam-campaign", agent: "fundraiser-1" }], names, {}))).toThrow("cannot do scam-campaign");
    expect(() => checkRunnable(placeAssignments([{ task: "donate", agent: "scammer-1" }], names, {}))).toThrow("cannot do donate");
    expect(() => checkRunnable(placeAssignments([{ task: "start-campaign", agent: "scammer-1" }], names, {}))).toThrow("cannot do start-campaign");
    expect(defaultPlan({}).filter((p) => p.agent === "scammer-1").map((p) => [p.task, p.model])).toEqual([["start-organisation", "claude-sonnet-5-5"], ["scam-campaign", null]]);
  });
});
