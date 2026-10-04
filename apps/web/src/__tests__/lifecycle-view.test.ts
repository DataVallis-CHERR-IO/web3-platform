import { describe, expect, it } from "vitest";
import { bpsPercent, panelView, shortAddress, type LifecycleData, type PositionData } from "@/lib/campaigns/lifecycle-view";

// TASK-033b part 3: which stage and buttons the lifecycle panel shows.

const NOW = 1_800_000_000n;
function lc(over: Partial<LifecycleData> = {}): LifecycleData {
  return {
    address: "0x" + "a".repeat(40), state: "LIVE", deadline: String(NOW + 10n), endTime: "0", voteEnd: "0", currentRound: 0,
    tranchesReleased: 0, payoutMode: null, totalRaised: "0", poolDonated: "0", released: "0", swept: false,
    snapshot: { voteWindow: 3600, quorumBps: 2500, approvalBps: 5100, releaseDelay: 259200, refundSweepDelay: 15552000 },
    round: null, tally: null, due: { finalize: false, closeVote: false, release: false, releaseAt: null }, ...over,
  };
}
const pos = (action: PositionData["action"]): PositionData =>
  ({ address: "0x" + "c".repeat(40), donated: "5000000", preference: "REFUND", settled: false, vote: null, action });

describe("panelView", () => {
  it("LIVE before the deadline is not the panel's business; after it, 'ending' with finalize", () => {
    expect(panelView(lc(), null, NOW).stage).toBe("live");
    const v = panelView(lc({ due: { finalize: true, closeVote: false, release: false, releaseAt: null } }), null, NOW);
    expect(v).toMatchObject({ stage: "ending", triggers: ["finalize"] });
  });

  it("SUCCEEDED: waiting for the plan, the safety wait, or ready to pay out", () => {
    expect(panelView(lc({ state: "SUCCEEDED" }), null, NOW).stage).toBe("awaiting-plan");
    expect(panelView(lc({ state: "SUCCEEDED", payoutMode: "SINGLE" }), null, NOW)).toMatchObject({ stage: "release-wait", triggers: [] });
    expect(panelView(lc({ state: "SUCCEEDED", payoutMode: "MILESTONES", due: { finalize: false, closeVote: false, release: true, releaseAt: null } }), null, NOW))
      .toMatchObject({ stage: "release-due", triggers: ["release"] });
  });

  it("VOTING: open → vote buttons for the donor; over → 'count the votes' for anyone; payment number from tranches", () => {
    const open = panelView(lc({ state: "VOTING", payoutMode: "MILESTONES", tranchesReleased: 1, voteEnd: String(NOW + 60n) }),
      [pos({ kind: "vote", weight: "5000000" })], NOW);
    expect(open).toMatchObject({ stage: "voting", triggers: [], payment: 2 });
    expect(open.positions).toEqual([{ address: "0x" + "c".repeat(40), donated: "5000000", kind: "vote", amount: "5000000", approve: null }]);
    const over = panelView(lc({ state: "VOTING", payoutMode: "MILESTONES", tranchesReleased: 2, voteEnd: String(NOW) }), null, NOW);
    expect(over).toMatchObject({ stage: "vote-over", triggers: ["closeVote"], payment: 3 });
  });

  it("a cast vote keeps its direction and weight", () => {
    const v = panelView(lc({ state: "VOTING", voteEnd: String(NOW + 60n) }), [pos({ kind: "voted", approve: false, weight: "7" })], NOW);
    expect(v.positions[0]).toMatchObject({ kind: "voted", approve: false, amount: "7" });
  });

  it("FAILED / REJECTED carry the refund or pool amount; settled and the other states", () => {
    expect(panelView(lc({ state: "FAILED" }), [pos({ kind: "refund", amount: "5000000" })], NOW).positions[0])
      .toMatchObject({ kind: "refund", amount: "5000000" });
    expect(panelView(lc({ state: "REJECTED" }), [pos({ kind: "pool", amount: "1" })], NOW)).toMatchObject({ stage: "rejected" });
    expect(panelView(lc({ state: "FAILED" }), [pos({ kind: "settled" })], NOW).positions[0]).toMatchObject({ kind: "settled", amount: null });
    for (const [state, stage] of [["PAYING", "paying"], ["COMPLETED", "completed"], ["NEEDS_REVIEW", "needs-review"], ["FROZEN", "frozen"]] as const)
      expect(panelView(lc({ state }), null, NOW).stage, state).toBe(stage);
  });

  it("helpers", () => {
    expect(shortAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe("0x5aAe…eAed");
    expect(bpsPercent(2500)).toBe("25");
    expect(bpsPercent(3750)).toBe("37.5");
    expect(bpsPercent(5100)).toBe("51");
  });
});
