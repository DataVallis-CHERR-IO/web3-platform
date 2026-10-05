import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { getDb } from "@/lib/db";
import { LANDING_GRID_SIZE, getLandingCampaigns, pickLandingCampaigns } from "@/lib/campaigns/landing";
import type { PublicCampaignSummary, PublicState } from "@/lib/campaigns/public";
import { cleanUp, createOrganization, createUser, PAYOUT_ADDRESS, type TestUser } from "./helpers/organizations";
import { deleteFakeChainRows, ensureFakeChain } from "./helpers/fake-chain";

// TASK-037: the landing shows real published campaigns — the soonest-ending live
// one as the hero, the next live ones in the grid, never ended campaigns.

const summary = (id: string, state: PublicState | null): PublicCampaignSummary => ({
  id,
  slug: id,
  title: id,
  orgName: "Org",
  orgVerified: true,
  cause: "animals",
  country: "SI",
  coverUrl: null,
  targetEurCents: 100_000n,
  targetUsdc: 117_000_000n,
  deadline: new Date(),
  address: `0x${id}`,
  isDemo: false,
  onChain: state === null ? null : { state, raised: 0n, payoutMode: null, donors: 0, endTime: 0n },
});

describe("pickLandingCampaigns", () => {
  it("takes the first live campaign as hero and the next live ones for the grid, in order", () => {
    const list = [
      summary("a", "live"),
      summary("b", "live"),
      summary("c", "ending"),
      summary("d", "live"),
      summary("e", "failed"),
      summary("f", "completed"),
    ];
    const { hero, grid } = pickLandingCampaigns(list);
    expect(hero?.id).toBe("a");
    expect(grid.map((c) => c.id)).toEqual(["b", "d"]);
  });

  it("limits the grid to one row", () => {
    const list = Array.from({ length: 10 }, (_, i) => summary(`l${i}`, "live"));
    const { hero, grid } = pickLandingCampaigns(list);
    expect(hero?.id).toBe("l0");
    expect(grid).toHaveLength(LANDING_GRID_SIZE);
    expect(grid[0]!.id).toBe("l1");
  });

  it("has no hero and an empty grid when nothing is live (ended, unknown or no chain data)", () => {
    const { hero, grid } = pickLandingCampaigns([
      summary("x", "succeeded"),
      summary("y", "voting"),
      summary("z", "unknown"),
      summary("w", null),
    ]);
    expect(hero).toBeNull();
    expect(grid).toEqual([]);
  });

  it("handles an empty list", () => {
    expect(pickLandingCampaigns([])).toEqual({ hero: null, grid: [] });
  });
});

const { campaigns } = schema;
const RUN = Date.now().toString(36);
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const addr = () => `0x${randomBytes(20).toString("hex")}`;
const tx = () => `0x${randomBytes(32).toString("hex")}`;

let owner: TestUser;
let orgId: string;
const created: { id: string; address: string }[] = [];
let n = 0;

async function deployed(deadlineInSeconds: number, state: string) {
  const address = addr();
  const deadlineEpoch = now() + deadlineInSeconds;
  const [row] = await getDb()
    .insert(campaigns)
    .values({
      orgId,
      starterUserId: owner.id,
      beneficiaryType: "ORGANIZATION",
      title: `Landing test ${RUN} ${++n}`,
      slug: `landing-test-${RUN}-${n}`,
      story: { format: "plain", text: "Story. ".repeat(20) },
      cause: "animals",
      country: "SI",
      targetEurCents: "1000000",
      durationDays: 30,
      status: "DEPLOYED",
      eurUsdRate: "1.17000000",
      rateSource: "ECB",
      rateAt: new Date(),
      targetUsdc: 11_700_000_000n,
      beneficiaryAddress: PAYOUT_ADDRESS.toLowerCase(),
      deadline: new Date(deadlineEpoch * 1000),
      onchainAddress: address,
    })
    .returning({ id: campaigns.id });
  created.push({ id: row!.id, address });
  await getDb().execute(sql`
    insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, state,
                                total_raised, payout_mode, end_time, tx_hash, log_index, block_number, block_time)
    values (${address}, ${tx()}, ${PAYOUT_ADDRESS.toLowerCase()}, 0, 11700000000, ${deadlineEpoch}, ${state},
            0::numeric, null, 0, ${tx()}, 0, 1, ${now()})
  `);
  return row!.id;
}

describe("getLandingCampaigns (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("landing campaign tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await ensureFakeChain(getDb());
    owner = await createUser();
    orgId = (await createOrganization(owner)).id;
  });

  afterAll(async () => {
    for (const c of created) await deleteFakeChainRows(getDb(), c.address);
    await cleanUp();
  });

  it("puts the soonest-ending live campaign in the hero and keeps ended ones out", async () => {
    // Other test files share this database and may add live campaigns with
    // deadlines in days; ten minutes is sooner than any of them.
    const soonest = await deployed(600, "LIVE");
    const later = await deployed(20 * DAY, "LIVE");
    const failed = await deployed(-DAY, "FAILED");
    const past = await deployed(-60, "LIVE"); // deadline passed, waits for finalize → "ending"

    const { hero, grid, total, chainAvailable } = await getLandingCampaigns(getDb());
    expect(chainAvailable).toBe(true);
    expect(total).toBeGreaterThanOrEqual(4);
    expect(hero?.id).toBe(soonest);
    expect(hero?.onChain?.state).toBe("live");
    expect(grid.length).toBeLessThanOrEqual(LANDING_GRID_SIZE);
    for (const c of grid) expect(c.onChain?.state).toBe("live");
    const shown = [hero!.id, ...grid.map((c) => c.id)];
    expect(shown).not.toContain(failed);
    expect(shown).not.toContain(past);
    // `later` is live but may be pushed out of a full grid by other files' campaigns.
    if (grid.length < LANDING_GRID_SIZE) expect(shown).toContain(later);
  });
});
