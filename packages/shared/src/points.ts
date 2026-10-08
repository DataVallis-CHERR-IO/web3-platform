// Proof of Charity v2 (ADR-057): the point table and the levels. Numbers are
// configuration — changing them here needs no new ADR; the structure does
// (diminishing returns for donations, an action per level, attributed sharing).
// The worker awards points (apps/worker/src/points.ts); the web app shows levels.

export const POINTS = {
  registration: 50,
  firstDonation: 100,
  /** Cap per campaign of `donationPoints(total)`. */
  donationCap: 100,
  vote: 30,
  rating: 20,
  /** A new donor who gave through your personal link, per campaign and donor. */
  referralDonor: 20,
  /** At most this many referral donors are credited per campaign and referrer. */
  referralDonorsPerCampaign: 10,
  /** A friend who joined through your link and donated: to you / to the friend. */
  friendReferrer: 100,
  friendBonus: 50,
  campaignSuccess: 20,
  kyc: 100,
  orgReferral: 300,
} as const;

/** Ledger entries of these rules carry `rule_version = 2` (ADR-048 entries are 1). */
export const POINTS_RULE_VERSION = 2;

const USDC_UNIT = 1_000_000n;

/** Integer square root (floor) of a non-negative bigint. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of a negative number");
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}

/**
 * Points for everything a user gave to one campaign: 10 × √(USDC), whole USDC,
 * at most 100. The square root of the *total* — splitting a gift earns nothing extra.
 * 1 USDC → 10, 25 → 50, 100 or more → 100.
 */
export function donationPoints(totalUsdcUnits: bigint): number {
  if (totalUsdcUnits <= 0n) return 0;
  const whole = totalUsdcUnits / USDC_UNIT;
  return Math.min(POINTS.donationCap, Number(isqrt(100n * whole)));
}

/** Campaign states that reached the success threshold (chain.campaign.state). */
export const SUCCEEDED_CAMPAIGN_STATES = ["SUCCEEDED", "PAYING", "VOTING", "NEEDS_REVIEW", "COMPLETED"] as const;

export interface LevelProgress {
  /** Status points (not voided). */
  statusPoints: number;
  campaignsSupported: number;
  votes: number;
  ratings: number;
  /** Different people who donated through the user's link. */
  peopleBrought: number;
  /** Different calendar months with points. */
  activeMonths: number;
}

export interface LevelRule {
  level: 1 | 2 | 3 | 4 | 5;
  key: "supporter" | "giver" | "guardian" | "ambassador" | "champion";
  points: number;
  /** The action this level asks for, beyond the points. */
  met: (p: LevelProgress) => boolean;
}

export const LEVELS: readonly LevelRule[] = [
  { level: 1, key: "supporter", points: 50, met: () => true },
  { level: 2, key: "giver", points: 250, met: (p) => p.campaignsSupported >= 3 },
  { level: 3, key: "guardian", points: 700, met: (p) => p.votes >= 1 && p.ratings >= 1 },
  { level: 4, key: "ambassador", points: 1500, met: (p) => p.peopleBrought >= 3 },
  { level: 5, key: "champion", points: 3500, met: (p) => p.activeMonths >= 6 },
];

/**
 * The highest level whose points AND condition are met — and every level below
 * it too (levels are climbed in order). 0 = not yet Level 1 (fewer than 50 points).
 */
export function levelFor(p: LevelProgress): number {
  let level = 0;
  for (const rule of LEVELS) {
    if (p.statusPoints >= rule.points && rule.met(p)) level = rule.level;
    else break;
  }
  return level;
}
