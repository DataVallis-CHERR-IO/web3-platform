import type { Status } from "@cherrio/ui";
import type { PublicState } from "@/lib/campaigns/public";

// Display helpers shared by the public campaign list and page (TASK-011a).

const CHIP: Record<PublicState, Status> = {
  live: "live",
  ending: "pending",
  succeeded: "succeeded",
  voting: "voting",
  completed: "completed",
  failed: "failed",
  frozen: "frozen",
  "needs-review": "needs-review",
  rejected: "rejected",
  unknown: "pending",
};

export const chipFor = (state: PublicState): Status => CHIP[state];

/** Whole days left before the deadline (floor): 0 on the last day, null once it has passed. */
export function daysLeft(deadline: Date, now: number = Date.now()): number | null {
  const ms = deadline.getTime() - now;
  if (ms <= 0) return null;
  return Math.floor(ms / 86_400_000);
}

/** Percent of the target raised (bigint maths), for the bar's accessible name. */
export function percentRaised(raised: bigint, target: bigint): number {
  if (target <= 0n) return 0;
  return Number((raised * 100n) / target);
}
