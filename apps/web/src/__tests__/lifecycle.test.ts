import { describe, expect, it } from "vitest";
import {
  donorAction, dueActions, settlementAmount, voteTally, votesWaiting,
  type CampaignLifecycle, type DonorPosition, type MyCampaignDonation,
} from "@/lib/campaigns/lifecycle";

// TASK-033b: the pure lifecycle rules against Campaign.sol's own arithmetic
// (finalize, release, closeVote, claimRefund / settleToPool).

const U = 1_000_000n; // 1 USDC
const NOW = 1_800_000_000n;

function lc(over: Partial<CampaignLifecycle> = {}): CampaignLifecycle {
  return {
    address: "0x" + "a".repeat(40), state: "LIVE", deadline: NOW + 100n, endTime: 0n, voteEnd: 0n, currentRound: 0,
    tranchesReleased: 0, payoutMode: null, totalRaised: 1000n * U, poolDonated: 0n, released: 0n, rejectedRemainder: 0n,
    settlementStart: 0n, swept: false,
    snapshot: { voteWindow: 3600, quorumBps: 2500, approvalBps: 5100, releaseDelay: 259_200, refundSweepDelay: 15_552_000 },
    round: null, ...over,
  };
}
const voting = (yes: bigint, no: bigint, over: Partial<CampaignLifecycle> = {}) =>
  lc({ state: "VOTING", voteEnd: NOW + 60n, currentRound: 1,
       round: { round: 1, bundleHash: "0x" + "b".repeat(64), voteEnd: NOW + 60n, yes, no, outcome: null, closedAt: null }, ...over });
const pos = (over: Partial<DonorPosition> = {}): DonorPosition =>
  ({ address: "0x" + "c".repeat(40), donated: 100n * U, preference: "REFUND", settled: false, vote: null, ...over });

describe("voteTally (closeVote arithmetic, ADR-045)", () => {
  it("quorum is 25 % of donated human weight — exactly 25 % passes, just below does not", () => {
    expect(voteTally(voting(250n * U, 0n))!.quorumReached).toBe(true);
    expect(voteTally(voting(250n * U - 1n, 0n))!.quorumReached).toBe(false);
  });

  it("pool donations do not count towards the base", () => {
    const t = voteTally(voting(200n * U, 0n, { poolDonated: 200n * U }))!; // base 800 → 25 % = 200
    expect(t.base).toBe(800n * U);
    expect(t.quorumReached).toBe(true);
    expect(t.turnoutBps).toBe(2500n);
  });

  it("approval needs 51 % of the cast weight", () => {
    expect(voteTally(voting(510n * U, 490n * U))!.approvalReached).toBe(true);
    expect(voteTally(voting(509n * U, 491n * U))!.approvalReached).toBe(false);
    expect(voteTally(voting(0n, 0n))).toMatchObject({ approvalReached: false, quorumReached: false, yesBps: 0n });
  });

  it("no base (everything came from the pool) never reaches quorum", () => {
    expect(voteTally(voting(0n, 0n, { poolDonated: 1000n * U }))!.quorumReached).toBe(false);
  });

  it("unknown snapshot → unknown result, never today's config", () => {
    const t = voteTally(voting(500n * U, 0n, { snapshot: { voteWindow: null, quorumBps: null, approvalBps: null, releaseDelay: null, refundSweepDelay: null } }))!;
    expect(t.quorumReached).toBeNull();
    expect(t.approvalReached).toBeNull();
    expect(t.turnoutBps).toBe(5000n);
  });

  it("no round → no tally", () => expect(voteTally(lc())).toBeNull());
});

describe("dueActions", () => {
  it("finalize once the deadline has passed (LIVE only)", () => {
    expect(dueActions(lc({ deadline: NOW }), NOW).finalize).toBe(true);
    expect(dueActions(lc({ deadline: NOW + 1n }), NOW).finalize).toBe(false);
    expect(dueActions(lc({ state: "SUCCEEDED", deadline: NOW - 10n }), NOW).finalize).toBe(false);
  });

  it("closeVote once the vote window is over", () => {
    expect(dueActions(voting(0n, 0n, { voteEnd: NOW }), NOW).closeVote).toBe(true);
    expect(dueActions(voting(0n, 0n, { voteEnd: NOW + 1n }), NOW).closeVote).toBe(false);
  });

  it("release: needs the payout mode; SINGLE waits for its own release delay, MILESTONES does not", () => {
    const ended = { state: "SUCCEEDED" as const, endTime: NOW - 100n };
    expect(dueActions(lc({ ...ended, payoutMode: null }), NOW).release).toBe(false);
    expect(dueActions(lc({ ...ended, payoutMode: 1 }), NOW).release).toBe(true);
    const single = dueActions(lc({ ...ended, payoutMode: 0 }), NOW);
    expect(single).toMatchObject({ release: false, releaseAt: NOW - 100n + 259_200n });
    expect(dueActions(lc({ ...ended, payoutMode: 0 }), NOW - 100n + 259_200n).release).toBe(true);
    const unknown = lc({ ...ended, payoutMode: 0, snapshot: { ...lc().snapshot, releaseDelay: null } });
    expect(dueActions(unknown, NOW + 10n ** 9n)).toMatchObject({ release: false, releaseAt: null });
  });
});

describe("settlement and donor actions", () => {
  it("FAILED returns everything; REJECTED pays pro rata, rounded down like the contract", () => {
    expect(settlementAmount(lc({ state: "FAILED" }), 123n)).toBe(123n);
    const rejected = lc({ state: "REJECTED", totalRaised: 3n * U, rejectedRemainder: 2n * U });
    expect(settlementAmount(rejected, 1n * U)).toBe(666_666n);
    expect(settlementAmount(lc({ state: "PAYING" }), 1n * U)).toBe(0n);
  });

  it("vote while open, shows the cast vote, nothing after the window", () => {
    expect(donorAction(voting(0n, 0n), pos(), NOW)).toEqual({ kind: "vote", weight: 100n * U });
    expect(donorAction(voting(0n, 0n), pos({ vote: { approve: false, weight: 100n * U } }), NOW))
      .toEqual({ kind: "voted", approve: false, weight: 100n * U });
    expect(donorAction(voting(0n, 0n, { voteEnd: NOW }), pos(), NOW)).toEqual({ kind: "none" });
  });

  it("refund or pool by preference; nothing once settled or swept", () => {
    const failed = lc({ state: "FAILED" });
    expect(donorAction(failed, pos(), NOW)).toEqual({ kind: "refund", amount: 100n * U });
    expect(donorAction(failed, pos({ preference: "EMERGENCY_POOL" }), NOW)).toEqual({ kind: "pool", amount: 100n * U });
    expect(donorAction(failed, pos({ settled: true }), NOW)).toEqual({ kind: "settled" });
    expect(donorAction(lc({ state: "FAILED", swept: true }), pos(), NOW)).toEqual({ kind: "none" });
    expect(donorAction(failed, pos({ donated: 0n }), NOW)).toEqual({ kind: "none" });
  });

  it("votes waiting counts campaigns with at least one address that can still vote", () => {
    const item = (l: CampaignLifecycle, p: DonorPosition[]): MyCampaignDonation => ({ campaignId: "x", slug: "x", title: "x", lifecycle: l, positions: p });
    expect(votesWaiting([
      item(voting(0n, 0n), [pos(), pos({ address: "0x" + "d".repeat(40) })]),
      item(voting(0n, 0n), [pos({ vote: { approve: true, weight: 1n } })]),
      item(lc({ state: "FAILED" }), [pos()]),
    ], NOW)).toBe(1);
  });
});
