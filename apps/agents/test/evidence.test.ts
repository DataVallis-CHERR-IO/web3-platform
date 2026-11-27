import { describe, expect, it } from "vitest";
import { campaignAddressIn, campaignIds, evidenceNote, lifecycleState, openEvidence, pickEvidenceTarget, type EvidenceData } from "../src/evidence.js";

// TASK-061g part A: the pure helpers. The browser flow needs the agents environment (NOT RUN here).

const ID1 = "0b1f2c3d-aaaa-4bbb-8ccc-0123456789ab";
const ID2 = "9f8e7d6c-1111-4222-9333-abcdefabcdef";
const open = (round: number, bundles: EvidenceData["bundles"] = []): EvidenceData => ({ openRound: round, bundles });

describe("evidenceNote", () => {
  it("says testnet, test documents, the payment and the agent", () => {
    const note = evidenceNote(2, "fundraiser-1");
    expect(note).toBe("Testnet: proof of use for payment 2 — test documents, not real spending. Created by the CHERR.IO testnet agent fundraiser-1.");
    expect(note.length).toBeLessThan(2000);
  });
});

describe("openEvidence / pickEvidenceTarget", () => {
  it("round 0 is payment 2, round 1 is payment 3", () => {
    expect(openEvidence(ID1, open(0))).toEqual({ id: ID1, round: 0, payment: 2, sealed: false });
    expect(openEvidence(ID1, open(1))).toMatchObject({ round: 1, payment: 3 });
  });
  it("nothing when the panel is closed, the round is odd or it is already on chain", () => {
    expect(openEvidence(ID1, { openRound: null, bundles: [] })).toBeNull();
    expect(openEvidence(ID1, open(2))).toBeNull();
    expect(openEvidence(ID1, open(-1))).toBeNull();
    expect(openEvidence(ID1, open(0, [{ round: 0, bundleHash: "0xab", onChain: true }]))).toBeNull();
  });
  it("a sealed bundle that is not on chain is resumed, not rebuilt", () => {
    expect(openEvidence(ID1, open(0, [{ round: 0, bundleHash: "0xab", onChain: false }]))?.sealed).toBe(true);
    expect(openEvidence(ID1, open(0, [{ round: 0, bundleHash: null, onChain: false }]))?.sealed).toBe(false);
  });
  it("takes the first open campaign only (one per run)", () => {
    const picked = pickEvidenceTarget([
      { id: ID1, data: { openRound: null, bundles: [] } },
      { id: ID2, data: open(1) },
      { id: "third", data: open(0) },
    ]);
    expect(picked).toMatchObject({ id: ID2, payment: 3 });
    expect(pickEvidenceTarget([])).toBeNull();
  });
});

describe("page data helpers", () => {
  it("campaignIds keeps campaign uuids once, in order", () => {
    expect(campaignIds([`/en/account/campaigns/${ID1}`, "/en/account/campaigns/new", `/account/campaigns/${ID2}#evidence`, `/en/account/campaigns/${ID1}`, "/en/account/campaigns"]))
      .toEqual([ID1, ID2]);
  });
  it("campaignAddressIn reads the address from plain and escaped page data", () => {
    const a = "0xAbCdEf0123456789aBcDeF0123456789abcdef01";
    expect(campaignAddressIn(`{"campaignId":"x","campaign":"${a}","beneficiary":"0x1"}`)).toBe(a.toLowerCase());
    expect(campaignAddressIn(`self.__next_f.push([1,"{\\"campaign\\":\\"${a}\\"}"])`)).toBe(a.toLowerCase());
    expect(campaignAddressIn('{"campaign":"0x12"}')).toBeNull();
  });
  it("lifecycleState reads the state of /api/lifecycle", () => {
    expect(lifecycleState({ now: "1", lifecycle: { state: "VOTING" } })).toBe("VOTING");
    expect(lifecycleState({ error: "not_found" })).toBeNull();
    expect(lifecycleState(null)).toBeNull();
  });
});
