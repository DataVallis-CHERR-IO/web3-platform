import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { getDb } from "@/lib/db";
import { listMyCampaignDonations, loadLifecycle, loadUserPositions } from "@/lib/campaigns/lifecycle";
import { GET as getLifecycle } from "@/app/api/lifecycle/[campaign]/route";
import { GET as getMyDonations } from "@/app/api/me/donations/route";
import { cleanUp, createOrganization, createUser, PAYOUT_ADDRESS, type TestUser } from "./helpers/organizations";
import { deleteFakeChainRows, ensureFakeChain } from "./helpers/fake-chain";

// TASK-033b: the lifecycle loaders and their API against the fake chain views.

const { campaigns, userAddresses } = schema;
const RUN = Date.now().toString(36);
const U = 1_000_000n;
const now = () => Math.floor(Date.now() / 1000);
const addr = () => `0x${randomBytes(20).toString("hex")}`;
const tx = () => `0x${randomBytes(32).toString("hex")}`;

let owner: TestUser;
let donor: TestUser;
let stranger: TestUser;
let orgId: string;
const chainAddresses: string[] = [];
const linked: string[] = [];
let n = 0;

async function deployed(chain: Record<string, string | number | boolean | null>) {
  const address = addr();
  await getDb().insert(campaigns).values({
    orgId, starterUserId: owner.id, beneficiaryType: "ORGANIZATION", title: `Lifecycle ${RUN} ${++n}`, slug: `lifecycle-${RUN}-${n}`,
    story: { format: "plain", text: "Story. ".repeat(20) }, cause: "animals", country: "SI", goalAmountMinor: "1000000",
    durationDays: 30, status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB", rateAt: new Date(),
    targetUsdc: 1000n * U, beneficiaryAddress: PAYOUT_ADDRESS.toLowerCase(), deadline: new Date(), onchainAddress: address,
  });
  chainAddresses.push(address);
  const cols = { state: "LIVE", total_raised: "0", ...chain };
  const names = Object.keys(cols);
  await getDb().execute(sql`
    insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, tx_hash, log_index, block_number, block_time,
      ${sql.raw(names.join(", "))})
    values (${address}, ${tx()}, ${PAYOUT_ADDRESS.toLowerCase()}, 0, ${(1000n * U).toString()}, ${now() - 10}, ${tx()}, 0, 1, ${now()},
      ${sql.join(names.map((k) => sql`${cols[k as keyof typeof cols]}`), sql`, `)})
  `);
  return address;
}

async function donorRow(campaign: string, who: string, donated: bigint, preference = 0, settled = false) {
  await getDb().execute(sql`
    insert into chain.campaign_donor (campaign, donor, donated, preference, sub_pool_id, settled)
    values (${campaign}, ${who}, ${donated.toString()}::numeric, ${preference}, 0, ${settled})
  `);
}

async function link(userId: string, address: string) {
  await getDb().insert(userAddresses).values({ userId, address, kind: "EXTERNAL" });
  linked.push(address);
}

const req = (url: string, cookie?: string) => new Request(`http://localhost${url}`, { headers: cookie ? { cookie } : {} });

describe("lifecycle loaders and API (Postgres, fake chain)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("lifecycle tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await ensureFakeChain(getDb());
    owner = await createUser();
    donor = await createUser();
    stranger = await createUser();
    orgId = (await createOrganization(owner)).id;
  });

  afterAll(async () => {
    const db = getDb();
    for (const a of chainAddresses) await deleteFakeChainRows(db, a);
    if (linked.length > 0) await db.delete(userAddresses).where(inArray(userAddresses.address, linked));
    await cleanUp();
  });

  it("a vote in progress: own snapshot, current round, tally, my positions and my vote", async () => {
    const voteEnd = now() + 3600;
    const c = await deployed({
      state: "VOTING", total_raised: (1000n * U).toString(), pool_donated: (200n * U).toString(), payout_mode: 1,
      tranches_released: 1, current_round: 1, vote_end: voteEnd, snap_vote_window: 3600, snap_quorum_bps: 2500,
      snap_approval_bps: 5100, snap_release_delay: 259200, snap_refund_sweep_delay: 15552000,
    });
    const [a1, a2, other] = [addr(), addr(), addr()];
    await link(donor.id, a1);
    await link(donor.id, a2);
    await donorRow(c, a1, 300n * U);
    await donorRow(c, a2, 100n * U);
    await donorRow(c, other, 400n * U);
    await getDb().execute(sql`
      insert into chain.vote_round (campaign, round, bundle_hash, vote_end, yes_votes, no_votes, tx_hash, log_index, block_number, block_time)
      values (${c}, 0, ${tx()}, 1, 0, 0, ${tx()}, 0, 1, 1), (${c}, 1, ${tx()}, ${voteEnd}, ${(300n * U).toString()}, 0, ${tx()}, 0, 2, 2)
    `);
    await getDb().execute(sql`
      insert into chain.vote (campaign, round, voter, approve, weight, tx_hash, log_index, block_number, block_time)
      values (${c}, 1, ${a1}, true, ${(300n * U).toString()}, ${tx()}, 0, 3, 3), (${c}, 0, ${a2}, false, 1, ${tx()}, 0, 1, 1)
    `);

    const lc = (await loadLifecycle(getDb(), c.toUpperCase().replace("0X", "0x")))!;
    expect(lc).toMatchObject({ state: "VOTING", currentRound: 1, payoutMode: 1, totalRaised: 1000n * U, poolDonated: 200n * U });
    expect(lc.snapshot).toEqual({ voteWindow: 3600, quorumBps: 2500, approvalBps: 5100, releaseDelay: 259200, refundSweepDelay: 15552000 });
    expect(lc.round).toMatchObject({ round: 1, yes: 300n * U, no: 0n, voteEnd: BigInt(voteEnd), outcome: null });

    const positions = await loadUserPositions(getDb(), donor.id, lc);
    expect(positions).toEqual([
      { address: a1, donated: 300n * U, preference: "REFUND", settled: false, vote: { approve: true, weight: 300n * U } },
      // a2 voted in round 0 only — that is not a vote in round 1
      { address: a2, donated: 100n * U, preference: "REFUND", settled: false, vote: null },
    ]);
    expect(await loadUserPositions(getDb(), stranger.id, lc)).toEqual([]);

    const anon = await (await getLifecycle(req(`/api/lifecycle/${c}`), { params: Promise.resolve({ campaign: c }) })).json();
    expect(anon.positions).toBeNull();
    expect(anon.lifecycle).toMatchObject({
      state: "VOTING", payoutMode: "MILESTONES", round: { round: 1, yes: (300n * U).toString(), no: "0" },
      tally: { base: (800n * U).toString(), turnoutBps: 3750, yesBps: 10000, quorumReached: true, approvalReached: true },
      due: { closeVote: false, finalize: false, release: false },
    });
    const mine = await (await getLifecycle(req(`/api/lifecycle/${c}`, donor.cookie), { params: Promise.resolve({ campaign: c }) })).json();
    expect(mine.positions.map((p: { action: unknown }) => p.action)).toEqual([
      { kind: "voted", approve: true, weight: (300n * U).toString() },
      { kind: "vote", weight: (100n * U).toString() },
    ]);
  });

  it("a view without the snapshot columns' values → unknown, not today's config", async () => {
    const c = await deployed({ state: "SUCCEEDED", payout_mode: 0, end_time: now() - 100 });
    const lc = (await loadLifecycle(getDb(), c))!;
    expect(lc.snapshot).toEqual({ voteWindow: null, quorumBps: null, approvalBps: null, releaseDelay: null, refundSweepDelay: null });
    const body = await (await getLifecycle(req(`/api/lifecycle/${c}`), { params: Promise.resolve({ campaign: c }) })).json();
    expect(body.lifecycle.due).toEqual({ finalize: false, closeVote: false, release: false, releaseAt: null });
  });

  it("unknown or malformed campaign", async () => {
    const unknown = addr();
    expect(await loadLifecycle(getDb(), unknown)).toBeNull();
    expect((await getLifecycle(req(`/api/lifecycle/${unknown}`), { params: Promise.resolve({ campaign: unknown }) })).status).toBe(404);
    expect((await getLifecycle(req("/api/lifecycle/nope"), { params: Promise.resolve({ campaign: "nope" }) })).status).toBe(400);
  });

  it("My donations: every campaign of the user's addresses, next actions and the votes-waiting count", async () => {
    const failed = await deployed({ state: "FAILED", total_raised: (50n * U).toString(), snap_quorum_bps: 2500 });
    const rejected = await deployed({ state: "REJECTED", total_raised: (300n * U).toString(), rejected_remainder: (200n * U).toString() });
    const a = addr();
    await link(donor.id, a);
    await donorRow(failed, a, 50n * U, 1);
    await donorRow(rejected, a, 30n * U, 0);

    const list = (await listMyCampaignDonations(getDb(), donor.id))!;
    const byAddress = new Map(list.map((d) => [d.lifecycle.address, d]));
    expect(byAddress.get(failed)!.positions[0]).toMatchObject({ address: a, preference: "EMERGENCY_POOL" });
    expect(byAddress.has(rejected)).toBe(true);
    expect(await listMyCampaignDonations(getDb(), stranger.id)).toEqual([]);

    expect((await getMyDonations(req("/api/me/donations"))).status).toBe(401);
    const res = await getMyDonations(req("/api/me/donations", donor.cookie));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.votesWaiting).toBe(1); // the VOTING campaign above, where a2 has not voted
    const actions = Object.fromEntries(
      body.donations.flatMap((d: { lifecycle: { address: string }; positions: { address: string; action: unknown }[] }) =>
        d.positions.filter((p) => p.address === a).map((p) => [d.lifecycle.address, p.action]))
    );
    expect(actions[failed]).toEqual({ kind: "pool", amount: (50n * U).toString() });
    expect(actions[rejected]).toEqual({ kind: "refund", amount: (20n * U).toString() }); // 30 × 200 / 300
  });
});
