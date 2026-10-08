import { describe, expect, it } from "vitest";
import { LEVELS, POINTS, donationPoints, isqrt, levelFor, type LevelProgress } from "../src/points";

// ADR-057 point table and levels (TASK-056).

const U = 1_000_000n;
const base: LevelProgress = { statusPoints: 0, campaignsSupported: 0, votes: 0, ratings: 0, peopleBrought: 0, activeMonths: 0 };

describe("donation points", () => {
  it("are 10 × √USDC of the total, whole USDC, capped at 100", () => {
    expect(donationPoints(0n)).toBe(0);
    expect(donationPoints(999_999n)).toBe(0); // under 1 USDC
    expect(donationPoints(1n * U)).toBe(10);
    expect(donationPoints(2n * U)).toBe(14); // √200 = 14.14
    expect(donationPoints(25n * U)).toBe(50);
    expect(donationPoints(99n * U)).toBe(99);
    expect(donationPoints(100n * U)).toBe(100);
    expect(donationPoints(10_000n * U)).toBe(100);
    expect(donationPoints(10n ** 30n)).toBe(100);
  });

  it("splitting a gift earns nothing extra", () => {
    const once = donationPoints(100n * U);
    const total = donationPoints(100n * 1n * U); // 100 × 1 USDC, same total
    expect(total).toBe(once);
    expect(100 * donationPoints(1n * U)).toBeGreaterThan(once); // what per-donation √ would have paid
  });

  it("isqrt is exact around perfect squares and for huge numbers", () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 99n, 100n, 101n]) {
      const r = isqrt(n);
      expect(r * r <= n && (r + 1n) * (r + 1n) > n).toBe(true);
    }
    const big = 12345678901234567890123n;
    const r = isqrt(big * big + 5n);
    expect(r).toBe(big);
    expect(() => isqrt(-1n)).toThrow();
  });
});

describe("levels", () => {
  it("need the points AND the action, in order", () => {
    expect(levelFor(base)).toBe(0);
    expect(levelFor({ ...base, statusPoints: 50 })).toBe(1);
    // A whale: many points, one campaign — stays Supporter.
    expect(levelFor({ ...base, statusPoints: 10_000, campaignsSupported: 1 })).toBe(1);
    expect(levelFor({ ...base, statusPoints: 250, campaignsSupported: 3 })).toBe(2);
    // Points for L3 but no rating yet.
    expect(levelFor({ ...base, statusPoints: 700, campaignsSupported: 3, votes: 2 })).toBe(2);
    expect(levelFor({ ...base, statusPoints: 700, campaignsSupported: 3, votes: 1, ratings: 1 })).toBe(3);
    expect(levelFor({ ...base, statusPoints: 1500, campaignsSupported: 3, votes: 1, ratings: 1, peopleBrought: 3 })).toBe(4);
    // Champion needs six active months, whatever the points.
    const almost = { statusPoints: 9_999, campaignsSupported: 9, votes: 9, ratings: 9, peopleBrought: 9, activeMonths: 5 };
    expect(levelFor(almost)).toBe(4);
    expect(levelFor({ ...almost, activeMonths: 6 })).toBe(5);
    // A missing lower condition blocks the higher levels too.
    expect(levelFor({ ...almost, campaignsSupported: 2, activeMonths: 6 })).toBe(1);
  });

  it("match ADR-057's table", () => {
    expect(LEVELS.map((l) => [l.level, l.key, l.points])).toEqual([
      [1, "supporter", 50], [2, "giver", 250], [3, "guardian", 700], [4, "ambassador", 1500], [5, "champion", 3500],
    ]);
    expect(POINTS).toMatchObject({ registration: 50, firstDonation: 100, vote: 30, rating: 20, referralDonor: 20, friendReferrer: 100, friendBonus: 50, campaignSuccess: 20 });
  });
});
