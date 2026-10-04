import { getAddress } from "viem";
import type { lifecycleJson, positionJson } from "./lifecycle";

// TASK-033b part 3: what the lifecycle panel on the campaign page shows, from
// the `GET /api/lifecycle/:campaign` JSON. Pure (no React, no i18n): the panel
// turns `stage` into words and `buttons` into buttons. Unit-tested.

export type LifecycleData = ReturnType<typeof lifecycleJson>;
export type PositionData = ReturnType<typeof positionJson>;

export type Stage =
  | "ending" // LIVE past the deadline, waiting for finalize()
  | "awaiting-plan" // SUCCEEDED, the operator has not set the payout mode yet
  | "release-wait" // SUCCEEDED SINGLE, the guardian window is still open
  | "release-due" // SUCCEEDED, release() can be called
  | "paying" // PAYING: a milestone payment went out, the next one needs proof + a vote
  | "voting" // VOTING, window open
  | "vote-over" // VOTING, window over, waiting for closeVote()
  | "needs-review" // NEEDS_REVIEW: no quorum, CHERR.IO decides
  | "completed"
  | "failed"
  | "rejected"
  | "frozen"
  | "live"; // still live (the donate panel shows instead)

export type Trigger = "finalize" | "closeVote" | "release";

export interface PositionView {
  address: string;
  donated: string;
  kind: PositionData["action"]["kind"];
  /** vote weight or refund / pool amount (USDC units), when the kind has one. */
  amount: string | null;
  approve: boolean | null;
}

export interface PanelView {
  stage: Stage;
  /** Anyone logged in with a wallet may press these. */
  triggers: Trigger[];
  /** Payment number currently being voted on or next (2 or 3), for MILESTONES. */
  payment: number | null;
  positions: PositionView[];
}

export function panelView(lc: LifecycleData, positions: PositionData[] | null, now: bigint): PanelView {
  const voteOpen = lc.state === "VOTING" && now < BigInt(lc.voteEnd);
  let stage: Stage;
  switch (lc.state) {
    case "LIVE": stage = lc.due.finalize ? "ending" : "live"; break;
    case "SUCCEEDED":
      stage = lc.payoutMode === null ? "awaiting-plan" : lc.due.release ? "release-due" : "release-wait";
      break;
    case "PAYING": stage = "paying"; break;
    case "VOTING": stage = voteOpen ? "voting" : "vote-over"; break;
    case "NEEDS_REVIEW": stage = "needs-review"; break;
    case "COMPLETED": stage = "completed"; break;
    case "FAILED": stage = "failed"; break;
    case "REJECTED": stage = "rejected"; break;
    case "FROZEN": stage = "frozen"; break;
  }
  const triggers: Trigger[] = [];
  if (lc.due.finalize) triggers.push("finalize");
  if (lc.due.closeVote || stage === "vote-over") triggers.push("closeVote");
  if (lc.due.release) triggers.push("release");
  // Milestones: tranche 1 is paid on release(); rounds 1 and 2 decide payments 2 and 3.
  const payment = lc.payoutMode === "MILESTONES" && (lc.state === "VOTING" || lc.state === "PAYING" || lc.state === "NEEDS_REVIEW")
    ? Math.min(lc.tranchesReleased + 1, 3)
    : null;
  return {
    stage,
    triggers,
    payment,
    positions: (positions ?? []).map((p) => ({
      address: p.address,
      donated: p.donated,
      kind: p.action.kind,
      amount: ("amount" in p.action ? p.action.amount : "weight" in p.action ? p.action.weight : null) ?? null,
      approve: ("approve" in p.action ? p.action.approve : null) ?? null,
    })),
  };
}

/** "0x1234…AbCd", checksummed as wallets show it. */
export const shortAddress = (a: string) => {
  const c = getAddress(a);
  return `${c.slice(0, 6)}…${c.slice(-4)}`;
};

/** Basis points as a percent string with at most one decimal ("25", "37.5"). */
export const bpsPercent = (bps: number) => (Math.round(bps / 10) / 10).toString();
