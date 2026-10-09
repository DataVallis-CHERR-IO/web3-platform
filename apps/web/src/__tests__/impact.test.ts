import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { LEVELS } from "@cherrio/shared/points";
import { getDb } from "@/lib/db";
import { getImpact, missingFor } from "@/lib/points/impact";
import { createUser, cleanUp, type TestUser } from "./helpers/organizations";

// TASK-056b: "My impact" reads the points ledger (rule_version 2 entries from
// the worker) and turns it into a level, the next step and statistics.

const RUN = Date.now().toString(36);
let u: TestUser;
const campaignIds: string[] = [];

type Entry = { reason: string; delta: number; refKey: string; at?: Date; refId?: string; voided?: boolean };
async function ledger(userId: string, entries: Entry[]) {
  await getDb().insert(schema.pointsLedger).values(
    entries.flatMap((e) =>
      (["STATUS", "REWARD"] as const).map((bucket) => ({
        userId, bucket, delta: BigInt(e.delta), reason: e.reason as never, refKey: e.refKey, ruleVersion: 2,
        refType: e.refId ? "campaign" : null, refId: e.refId ?? null,
        createdAt: e.at ?? new Date(), voidedAt: e.voided ? new Date() : null,
      }))
    )
  );
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("impact tests need DATABASE_URL");
  process.env.APP_ENV = "local";
  u = await createUser();
});

afterAll(async () => {
  await getDb().delete(schema.pointsLedger).where(inArray(schema.pointsLedger.userId, [u.id]));
  await getDb().delete(schema.campaigns).where(inArray(schema.campaigns.id, campaignIds));
  await cleanUp();
});

describe("My impact", () => {
  it("a new user has no level and is told to earn 50 points", async () => {
    const fresh = await createUser();
    const impact = await getImpact(getDb(), fresh.id);
    expect(impact).toMatchObject({ level: 0, statusPoints: 0, rewardPoints: 0, recent: [] });
    expect(impact.next?.key).toBe("supporter");
    expect(impact.missing).toEqual([{ kind: "points", count: 50 }]);
  });

  it("counts campaigns, votes, people and months from the ledger; level and next step follow ADR-057", async () => {
    const [c] = await getDb()
      .insert(schema.campaigns)
      .values({
        starterUserId: u.id, beneficiaryType: "INDIVIDUAL", title: `Impact ${RUN}`, slug: `impact-${RUN}`,
        story: { format: "plain", text: "Story. ".repeat(20) }, cause: "animals", country: "SI", goalAmountMinor: "1000000",
        durationDays: 30, status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB", rateAt: new Date(),
        targetUsdc: 1_000_000_000n, beneficiaryAddress: `0x${"ab".repeat(20)}`, deadline: new Date(), onchainAddress: `0x${"cd".repeat(20)}`,
      })
      .returning({ id: schema.campaigns.id });
    campaignIds.push(c!.id);
    const month = (m: number) => new Date(Date.UTC(2026, m, 15));
    await ledger(u.id, [
      { reason: "REGISTRATION", delta: 50, refKey: "registration", at: month(3) },
      { reason: "FIRST_DONATION", delta: 100, refKey: "first-donation", at: month(4) },
      { reason: "DONATION", delta: 10, refKey: "donation:0xaa:10", at: month(4) },
      { reason: "DONATION", delta: 10, refKey: "donation:0xaa:20", at: month(4) }, // same campaign
      { reason: "DONATION", delta: 50, refKey: "donation:0xbb:50", at: month(5) },
      { reason: "DONATION", delta: 100, refKey: "donation:0xcc:100", at: month(6), refId: c!.id },
      { reason: "VOTE", delta: 30, refKey: "vote2:0xaa:1", at: month(6) },
      { reason: "REFERRAL", delta: 20, refKey: "link:0xaa:11111111-1111-4111-8111-111111111111", at: month(7) },
      { reason: "REFERRAL", delta: 20, refKey: "link:0xbb:11111111-1111-4111-8111-111111111111", at: month(7) }, // same person
      { reason: "REFERRAL", delta: 100, refKey: "friend:22222222-2222-4222-8222-222222222222", at: month(7) },
      { reason: "CAMPAIGN_SUCCESS", delta: 20, refKey: "success:0xaa", at: month(8) },
      { reason: "VOTE", delta: 200, refKey: "vote:0xaa:1", at: month(2), voided: true }, // ADR-048, voided by 0017
    ]);
    const impact = await getImpact(getDb(), u.id);
    expect(impact).toMatchObject({
      statusPoints: 510, rewardPoints: 510, campaignsSupported: 3, votes: 1, ratings: 0, peopleBrought: 2,
      activeMonths: 6, campaignsSucceeded: 1,
    });
    // 510 points and 3 campaigns → Giver; Guardian needs 700 points, a vote (done) and a rating.
    expect(impact.level).toBe(2);
    expect(impact.next?.key).toBe("guardian");
    expect(impact.missing).toEqual([{ kind: "points", count: 190 }, { kind: "rating" }]);
    // Latest first; the donation names its campaign; voided entries are not shown.
    expect(impact.recent[0]).toMatchObject({ reason: "CAMPAIGN_SUCCESS", delta: 20 });
    expect(impact.recent.find((e) => e.delta === 100 && e.reason === "DONATION")).toMatchObject({
      campaignTitle: `Impact ${RUN}`, campaignSlug: `impact-${RUN}`,
    });
    expect(impact.recent.some((e) => e.delta === 200)).toBe(false);
    expect(impact.recent).toHaveLength(10);
  });

  it("missing steps name every unmet condition", () => {
    const base = { statusPoints: 0, campaignsSupported: 0, votes: 0, ratings: 0, peopleBrought: 0, activeMonths: 0 };
    const rule = (key: string) => LEVELS.find((l) => l.key === key)!;
    expect(missingFor(rule("giver"), { ...base, statusPoints: 300, campaignsSupported: 1 })).toEqual([{ kind: "campaigns", count: 2 }]);
    expect(missingFor(rule("guardian"), base)).toEqual([{ kind: "points", count: 700 }, { kind: "vote" }, { kind: "rating" }]);
    expect(missingFor(rule("ambassador"), { ...base, statusPoints: 2000, peopleBrought: 1 })).toEqual([{ kind: "people", count: 2 }]);
    expect(missingFor(rule("champion"), { ...base, statusPoints: 3500, activeMonths: 4 })).toEqual([{ kind: "months", count: 2 }]);
  });
});
