import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { getDb } from "@/lib/db";
import { allocationPhase, loadAllocations, loadPoolCards, voteFigures } from "@/lib/pool/public";
import { ensureFakeChain } from "./helpers/fake-chain";

// Public Emergency Pool page (TASK-014a) on Postgres with the fake chain views:
// sub-pool cards, allocations with the weight that could vote (contributions
// before the proposal block only), and the contract's counting rule.

const db = () => getDb();
const POOL = 9301;
const usdc = (n: number) => BigInt(n) * 1_000_000n;
const A = "0x93010000000000000000000000000000000000aa";
const B = "0x93010000000000000000000000000000000000bb";
const CAMPAIGN = "0x9301000000000000000000000000000000000c01";

describe("public Emergency Pool page (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("pool page tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    await ensureFakeChain(db());
    await db().insert(schema.emergencySubpools).values({ poolId: POOL, slug: `test-pool-${POOL}`, nameKey: "x", descriptionKey: "x" });
    await db().execute(sql`insert into chain.pool (id, balance, total_contributed) values (${POOL}, ${usdc(5).toString()}, ${usdc(13).toString()})`);
    // A gives 7 at block 10 and 1 more at block 30; B gives 5 at block 20 (through a failed campaign)
    // and 2 in the proposal block 25 itself — too late for that vote (weight = contributed at block 24).
    await db().execute(sql`
      insert into chain.pool_contribution (id, pool_id, donor, amount, source, campaign, block_number) values
        ('t014-1', ${POOL}, ${A}, ${usdc(7).toString()}, 'DIRECT', null, 10),
        ('t014-2', ${POOL}, ${B}, ${usdc(5).toString()}, 'CAMPAIGN', ${CAMPAIGN}, 20),
        ('t014-3', ${POOL}, ${A}, ${usdc(1).toString()}, 'DIRECT', null, 30),
        ('t014-4', ${POOL}, ${B}, ${usdc(2).toString()}, 'DIRECT', null, 25)`);
    const later = Math.floor(Date.now() / 1000) + 3600;
    // 930101: proposed at block 25 (A 7 + B 5 = 12 eligible), B voted yes. 930102: passed, only 3 of 4 sent.
    await db().execute(sql`
      insert into chain.allocation (id, pool_id, campaign, amount, delivered, yes_votes, no_votes, vote_end, proposal_block, snap_quorum_bps, snap_approval_bps, state) values
        (930101, ${POOL}, ${CAMPAIGN}, ${usdc(2).toString()}, null, ${usdc(5).toString()}, 0, ${later}, 25, 2500, 5100, 'VOTING'),
        (930102, ${POOL}, ${CAMPAIGN}, ${usdc(4).toString()}, ${usdc(3).toString()}, ${usdc(13).toString()}, 0, 100, 35, 2500, 5100, 'PASSED')`);
  });
  afterAll(async () => {
    await db().execute(sql`delete from chain.allocation where id in (930101, 930102)`);
    await db().execute(sql`delete from chain.pool_contribution where id in ('t014-1', 't014-2', 't014-3', 't014-4')`);
    await db().execute(sql`delete from chain.pool where id = ${POOL}`);
    await db().delete(schema.emergencySubpools).where(inArray(schema.emergencySubpools.poolId, [POOL]));
  });

  it("a card per sub-pool on chain: balance, credited contributions, distinct contributors", async () => {
    const cards = await loadPoolCards(db());
    const card = cards!.find((c) => c.poolId === POOL);
    expect(card).toEqual({ poolId: POOL, slug: `test-pool-${POOL}`, balance: usdc(5), contributed: usdc(13), contributors: 2 });
    // Exactly the sub-pools that have a chain.pool row are listed (a theme not created on chain is not).
    const expected = (await db().execute(sql`
      select s.pool_id from app.emergency_subpools s join chain.pool p on p.id = s.pool_id order by s.pool_id`)) as unknown as { pool_id: number }[];
    const missing = (await db().execute(sql`
      select s.pool_id from app.emergency_subpools s left join chain.pool p on p.id = s.pool_id where p.id is null`)) as unknown as { pool_id: number }[];
    expect(cards!.map((c) => c.poolId)).toEqual(expected.map((r) => Number(r.pool_id)));
    expect(cards!.some((c) => missing.some((m) => Number(m.pool_id) === c.poolId))).toBe(false);
  });

  it("allocations newest first; eligible weight counts only contributions before the proposal block", async () => {
    const rows = (await loadAllocations(db()))!.filter((r) => r.poolId === POOL);
    expect(rows.map((r) => r.id)).toEqual(["930102", "930101"]);
    const [passed, open] = rows;
    expect(open).toMatchObject({ amount: usdc(2), delivered: null, yes: usdc(5), no: 0n, eligible: usdc(12), quorumBps: 2500, approvalBps: 5100, state: "VOTING" });
    expect(open!.campaignTitle).toBeNull(); // no app campaign with that address: the page shows the address
    expect(passed).toMatchObject({ amount: usdc(4), delivered: usdc(3), eligible: usdc(15), state: "PASSED" });
    expect(passed!.voteEnd.toISOString()).toBe("1970-01-01T00:01:40.000Z");
  });

  it("counts like EmergencyPool.closeAllocation: integer basis points, thresholds inclusive", () => {
    expect(voteFigures({ yes: usdc(5), no: 0n, eligible: usdc(12), quorumBps: 2500, approvalBps: 5100 })).toEqual({
      turnoutBps: 4166, approvalBps: 10000, quorumReached: true, approvalReached: true,
    });
    // Exactly at the quorum and exactly at the approval share both pass.
    expect(voteFigures({ yes: 51n, no: 49n, eligible: 400n, quorumBps: 2500, approvalBps: 5100 })).toMatchObject({
      turnoutBps: 2500, approvalBps: 5100, quorumReached: true, approvalReached: true,
    });
    expect(voteFigures({ yes: 50n, no: 49n, eligible: 400n, quorumBps: 2500, approvalBps: 5100 })).toMatchObject({
      quorumReached: false, approvalReached: false,
    });
    // Nobody could vote (only sweeps in the pool): no turnout, never a quorum.
    expect(voteFigures({ yes: 0n, no: 0n, eligible: 0n, quorumBps: 2500, approvalBps: 5100 })).toEqual({
      turnoutBps: 0, approvalBps: null, quorumReached: false, approvalReached: false,
    });
  });

  it("an open vote past its end waits to be counted; every state has a phase", () => {
    const now = new Date("2026-10-09T12:00:00Z");
    expect(allocationPhase("VOTING", new Date("2026-10-09T13:00:00Z"), now)).toBe("open");
    expect(allocationPhase("VOTING", new Date("2026-10-09T12:00:00Z"), now)).toBe("counting");
    expect(
      (["PASSED", "REJECTED", "NEEDS_REVIEW", "RESOLVED_PASS", "RESOLVED_REJECT", "DELIVERY_FAILED"] as const).map((s) =>
        allocationPhase(s, now, now)
      )
    ).toEqual(["sent", "notApproved", "review", "sentByCherrio", "returnedByCherrio", "notSent"]);
  });
});
