import { describe, expect, it } from "vitest";
import { redTeamAddresses } from "@cherrio/shared/agent-crew";
import {
  MAX_PAYOUT_PLANS_PER_RUN, PAYOUT_NOTE, choosePlan, classifyOutcome, crewVerdict, parseSuggestion, payoutTargets,
} from "../src/staff-payout.js";

const ID = "0123abcd-0123-4abc-8abc-0123456789ab";
const ID2 = "11111111-2222-4333-8444-555555555555";
const CREW = ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"];
const RED = redTeamAddresses("dev")[0]!;

describe("suggestion text on the page", () => {
  it("reads the plan from 'Suggested: …'", () => {
    expect(parseSuggestion("Suggested: One payment — the organisation's first campaign, paid at once under supervision.")).toBe("single");
    expect(parseSuggestion("Suggested: Three milestone payments — an individual's campaign is always paid in milestones.")).toBe("milestones");
    expect(parseSuggestion("  SUGGESTED: one payment — x")).toBe("single");
  });
  it("gives null for anything else; the default is One payment", () => {
    expect(parseSuggestion("")).toBeNull();
    expect(parseSuggestion("Suggested: something else")).toBeNull();
    expect(parseSuggestion("Not suggested: One payment")).toBeNull();
    expect(choosePlan("")).toBe("single");
    expect(choosePlan("Suggested: Three milestone payments — x")).toBe("milestones");
  });
  it("types the documented note", () => {
    expect(PAYOUT_NOTE).toBe("Testnet staff agent: suggested plan (ADR-049)");
    expect(PAYOUT_NOTE.length).toBeGreaterThanOrEqual(10); // the app's note minimum
  });
});

describe("crew / red-team / person filter", () => {
  const base = { startedByAgent: true, payoutAddress: CREW[0]!.toUpperCase().replace("0X", "0x"), crewAddresses: CREW };
  it("accepts a crew campaign (any address case)", () => {
    expect(crewVerdict(base)).toEqual({ ok: true });
  });
  it("refuses a person's campaign", () => {
    const v = crewVerdict({ ...base, startedByAgent: false });
    expect(v.ok).toBe(false);
  });
  it("refuses a red-team wallet even when it is listed as crew", () => {
    const v = crewVerdict({ ...base, payoutAddress: RED, crewAddresses: [...CREW, RED] });
    expect(v).toEqual({ ok: false, reason: "a red-team wallet" });
    expect(crewVerdict({ ...base, redTeamExtra: [CREW[0]!] }).ok).toBe(false);
  });
  it("refuses a payout address that is not a crew wallet", () => {
    expect(crewVerdict({ ...base, payoutAddress: "0x3333333333333333333333333333333333333333" }).ok).toBe(false);
    expect(crewVerdict({ ...base, payoutAddress: "" }).ok).toBe(false);
  });
});

describe("queue rows and the per-run cap", () => {
  it("keeps only 'Set the payout plan' campaign links, once each", () => {
    const rows = [
      { href: `/en/admin/campaigns/${ID}#chain-actions`, task: "Set the payout plan" },
      { href: `/en/admin/campaigns/${ID}`, task: "Set the payout plan" },
      { href: `/en/admin/campaigns/${ID2}#chain-actions`, task: "Decide the vote" },
      { href: "/en/admin/kyb", task: "Set the payout plan" },
    ];
    expect(payoutTargets(rows)).toEqual([`/en/admin/campaigns/${ID}`]);
  });
  it("caps the opened rows and sets at most two plans per run", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ href: `/en/admin/campaigns/${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`, task: "Set the payout plan" }));
    expect(payoutTargets(many)).toHaveLength(20);
    expect(payoutTargets(many, 3)).toHaveLength(3);
    expect(MAX_PAYOUT_PLANS_PER_RUN).toBe(2);
  });
});

describe("the panel's confirmation text", () => {
  it("tells sent, unknown and reverted apart (texts from admin.guardian.panel in en.json)", () => {
    expect(classifyOutcome("Sent. The page updates when the indexer has seen the transaction (about a minute).\nTransaction: 0xabc")).toBe("sent");
    expect(classifyOutcome("Sent, but the result is not known yet. Check the transaction.")).toBe("unknown");
    expect(classifyOutcome("The transaction failed on the blockchain. Nothing changed.")).toBe("reverted");
    expect(classifyOutcome("Confirming…")).toBeNull();
  });
});
