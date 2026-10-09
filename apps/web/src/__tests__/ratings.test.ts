import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { getAddress, type Hex } from "viem";
import * as schema from "@cherrio/db";
import { ratingTypedData } from "@cherrio/shared/ratings";
import { getDb } from "@/lib/db";
import { listRatings, loadRatingContext, orgRatingSummaries, ratingWindowStart, saveRating, type ContractSignatureVerifier } from "@/lib/ratings";
import { GET, POST } from "@/app/api/campaigns/[id]/rating/route";
import { ensureFakeChain, deleteFakeChainRows } from "./helpers/fake-chain";
import { ORIGIN, PAYOUT_ADDRESS, cleanUp, createOrganization, createUser, type TestUser } from "./helpers/organizations";

// TASK-057 (ADR-058): who may rate a finished campaign, the EIP-712 signature
// check and the save (one rating per donor and campaign, newer signature wins).

const RUN = Date.now().toString(36);
const U = 1_000_000n;
const CHAIN_ID = 31337;
const DAY = 86_400;
const nowS = () => Math.floor(Date.now() / 1000);
const addr = () => `0x${randomBytes(20).toString("hex")}`;
const hash = () => `0x${randomBytes(32).toString("hex")}`;

let owner: TestUser;
let donor: TestUser;
let stranger: TestUser;
let orgId: string;
let donorWallet: PrivateKeyAccount;
const smartAccount = addr();
const chainAddresses: string[] = [];
let n = 0;

const never: ContractSignatureVerifier = async () => {
  throw new Error("the contract verifier must not be called for an EOA");
};

async function campaign(chain: Record<string, string | number>, opts: { individual?: boolean; release?: number; donors?: string[] } = {}) {
  const address = addr();
  const [row] = await getDb().insert(schema.campaigns).values({
    orgId: opts.individual ? null : orgId, starterUserId: owner.id,
    beneficiaryType: opts.individual ? "INDIVIDUAL" : "ORGANIZATION", title: `Rating ${RUN} ${++n}`, slug: `rating-${RUN}-${n}`,
    story: { format: "plain", text: "Story. ".repeat(20) }, cause: "animals", country: "SI", goalAmountMinor: "1000000",
    durationDays: 30, status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB", rateAt: new Date(),
    targetUsdc: 1000n * U, beneficiaryAddress: PAYOUT_ADDRESS.toLowerCase(), deadline: new Date(), onchainAddress: address,
  }).returning({ id: schema.campaigns.id });
  chainAddresses.push(address);
  const cols = { state: "COMPLETED", end_time: nowS() - 30 * DAY, ...chain };
  const names = Object.keys(cols);
  await getDb().execute(sql`
    insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, tx_hash, log_index, block_number, block_time,
      ${sql.raw(names.join(", "))})
    values (${address}, ${hash()}, ${PAYOUT_ADDRESS.toLowerCase()}, ${opts.individual ? 1 : 0}, ${(1000n * U).toString()}, ${nowS()}, ${hash()}, 0, 1, ${nowS()},
      ${sql.join(names.map((k) => sql`${cols[k as keyof typeof cols]}`), sql`, `)})
  `);
  for (const d of opts.donors ?? [donorWallet.address.toLowerCase()]) {
    await getDb().execute(sql`
      insert into chain.donation (id, campaign, donor, amount, preference, sub_pool_id, tx_hash, log_index, block_number, block_time)
      values (${hash()}, ${address}, ${d}, ${(10n * U).toString()}, 0, 0, ${hash()}, 0, 1, ${nowS()})
    `);
  }
  if (opts.release !== undefined) {
    await getDb().execute(sql`
      insert into chain.tranche_release (id, campaign, tranche_index, beneficiary, amount, fee, tx_hash, log_index, block_number, block_time)
      values (${hash()}, ${address}, 0, ${PAYOUT_ADDRESS.toLowerCase()}, ${(100n * U).toString()}, 0, ${hash()}, 0, 1, ${opts.release})
    `);
  }
  return { id: row!.id, address };
}

async function sign(c: { address: string }, stars: number, comment: string | null, issuedAt = nowS(), wallet = donorWallet) {
  const typed = ratingTypedData(CHAIN_ID, {
    campaign: c.address as `0x${string}`, organization: orgId, stars, comment, issuedAt: BigInt(issuedAt),
  });
  return { stars, comment, issuedAt, signer: wallet.address, signature: await wallet.signTypedData(typed) };
}

const save = (c: { id: string }, rating: Awaited<ReturnType<typeof sign>>, user = donor, verifyContract = never) =>
  saveRating(getDb(), { campaignId: c.id, userId: user.id, rating, chainId: CHAIN_ID, verifyContract });

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("rating tests need DATABASE_URL");
  process.env.APP_ENV = "local";
  await ensureFakeChain(getDb());
  owner = await createUser();
  donor = await createUser();
  stranger = await createUser();
  orgId = (await createOrganization(owner)).id;
  donorWallet = privateKeyToAccount(generatePrivateKey());
  await getDb().insert(schema.userAddresses).values([
    { userId: donor.id, address: donorWallet.address.toLowerCase(), kind: "EXTERNAL", isPrimary: true },
    { userId: donor.id, address: smartAccount, kind: "SMART_ACCOUNT", isPrimary: false },
  ]);
});

afterAll(async () => {
  const db = getDb();
  await db.delete(schema.ratings).where(eq(schema.ratings.orgId, orgId));
  await db.delete(schema.userAddresses).where(inArray(schema.userAddresses.userId, [donor.id, owner.id]));
  for (const a of chainAddresses) await deleteFakeChainRows(db, a);
  await db.delete(schema.campaigns).where(eq(schema.campaigns.starterUserId, owner.id)); // incl. the individual one
  await cleanUp();
});

describe("rating window (ADR-058)", () => {
  it("opens when the campaign is finished: last release for COMPLETED, settlement start or end for FAILED/REJECTED", () => {
    const base = { endTime: 100n, settlementStart: 0n, lastRelease: null };
    expect(ratingWindowStart({ ...base, state: "COMPLETED", lastRelease: 500n })).toBe(500n);
    expect(ratingWindowStart({ ...base, state: "COMPLETED" })).toBe(100n);
    expect(ratingWindowStart({ ...base, state: "FAILED", settlementStart: 300n })).toBe(300n);
    expect(ratingWindowStart({ ...base, state: "REJECTED" })).toBe(100n);
    for (const state of ["LIVE", "SUCCEEDED", "PAYING", "VOTING", "NEEDS_REVIEW", "FROZEN"]) {
      expect(ratingWindowStart({ ...base, state })).toBeNull();
    }
  });
});

describe("who may rate (Postgres, fake chain)", () => {
  it("a donor of a finished organisation campaign within 90 days; not before, not after, not others", async () => {
    const open = await campaign({}, { release: nowS() - 10 * DAY });
    const ctx = await loadRatingContext(getDb(), open.id, donor.id);
    expect(ctx).toMatchObject({ status: "open", orgId, rating: null });
    expect(Math.round((ctx.windowEndsAt!.getTime() / 1000 - (nowS() - 10 * DAY)) / DAY)).toBe(90);

    expect((await loadRatingContext(getDb(), open.id, stranger.id)).status).toBe("not_donor");
    expect((await loadRatingContext(getDb(), (await campaign({ state: "SUCCEEDED" })).id, donor.id)).status).toBe("not_finished");
    expect((await loadRatingContext(getDb(), (await campaign({}, { release: nowS() - 91 * DAY })).id, donor.id)).status).toBe("window_closed");
    expect((await loadRatingContext(getDb(), (await campaign({ state: "FAILED", settlement_start: nowS() - DAY })).id, donor.id)).status).toBe("open");
    expect((await loadRatingContext(getDb(), (await campaign({}, { individual: true })).id, donor.id)).status).toBe("individual");
    expect((await loadRatingContext(getDb(), "00000000-0000-4000-8000-000000000000", donor.id)).status).toBe("not_found");
  });

  it("the organisation's own people cannot rate it, even when they donated", async () => {
    const ownWallet = addr();
    await getDb().insert(schema.userAddresses).values({ userId: owner.id, address: ownWallet, kind: "EXTERNAL", isPrimary: true });
    const c = await campaign({}, { donors: [ownWallet] });
    expect((await loadRatingContext(getDb(), c.id, owner.id)).status).toBe("own");
  });
});

describe("saving a signed rating", () => {
  it("stores a valid EOA signature with the signer; a newer one replaces it; an older one is refused", async () => {
    const c = await campaign({}, { release: nowS() - DAY });
    const first = await sign(c, 4, "Good updates, slow invoices", nowS() - 60);
    expect(await save(c, first)).toEqual({ ok: true, created: true });
    const second = await sign(c, 5, null);
    expect(await save(c, second)).toEqual({ ok: true, created: false });
    expect(await save(c, first)).toEqual({ ok: false, error: "stale" }); // replay of the older signature

    const rows = await getDb()
      .select({ stars: schema.ratings.stars, comment: schema.ratings.comment, signer: schema.ratings.signerAddress, signedAt: schema.ratings.signedAt })
      .from(schema.ratings)
      .where(eq(schema.ratings.campaignId, c.id));
    expect(rows).toEqual([{ stars: 5, comment: null, signer: donorWallet.address.toLowerCase(), signedAt: new Date(second.issuedAt * 1000) }]);
    const ctx = await loadRatingContext(getDb(), c.id, donor.id);
    expect(ctx.rating).toMatchObject({ stars: 5, comment: null });
    const audit = await getDb().select({ action: schema.auditLog.action, data: schema.auditLog.data })
      .from(schema.auditLog).where(eq(schema.auditLog.entityId, c.id));
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain("slow invoices"); // the private comment stays out of the log
  });

  it("refuses a changed message, a foreign or unlinked signer, a stale time and wrong input", async () => {
    const c = await campaign({}, { release: nowS() - DAY });
    const signed = await sign(c, 3, "fine");
    expect(await save(c, { ...signed, stars: 5 })).toEqual({ ok: false, error: "bad_signature" });
    expect(await save(c, { ...signed, comment: "excellent" })).toEqual({ ok: false, error: "bad_signature" });
    const other = privateKeyToAccount(generatePrivateKey());
    expect(await save(c, await sign(c, 3, null, nowS(), other))).toEqual({ ok: false, error: "not_your_address" });
    expect(await save(c, { ...signed, signer: other.address })).toEqual({ ok: false, error: "not_your_address" });
    expect(await save(c, await sign(c, 3, null, nowS() - 15 * 60))).toEqual({ ok: false, error: "stale" });
    expect(await save(c, { ...signed, stars: 6 })).toEqual({ ok: false, error: "invalid_request" });
    expect(await save(c, { ...signed, comment: "x".repeat(1001) })).toEqual({ ok: false, error: "invalid_request" });
    expect(await save(c, signed, stranger)).toEqual({ ok: false, error: "not_donor" });
    const rows = await getDb().select({ id: schema.ratings.id }).from(schema.ratings).where(eq(schema.ratings.campaignId, c.id));
    expect(rows).toHaveLength(0);
  });

  it("a smart account's signature is checked on chain (ERC-1271 / ERC-6492)", async () => {
    const c = await campaign({}, { release: nowS() - DAY });
    const signature = `0x${"ab".repeat(100)}` as Hex;
    const rating = { stars: 4, comment: null, issuedAt: nowS(), signer: smartAccount as `0x${string}`, signature };
    const verifier = vi.fn<ContractSignatureVerifier>(async () => true);
    expect(await save(c, rating, donor, verifier)).toEqual({ ok: true, created: true });
    expect(verifier).toHaveBeenCalledOnce();
    expect(verifier.mock.calls[0]![0].typedData.message).toMatchObject({ campaign: getAddress(c.address), organization: orgId, stars: 4 });
    expect(await save(c, { ...rating, issuedAt: nowS() + 1 }, donor, async () => false)).toEqual({ ok: false, error: "bad_signature" });
  });
});

describe("showing ratings (TASK-057b)", () => {
  it("average and count per organisation; the list has stars, comment and campaign — never who rated", async () => {
    const [c1, c2] = [await campaign({}, { release: nowS() - DAY }), await campaign({}, { release: nowS() - DAY })];
    const other = await createUser();
    const otherWallet = privateKeyToAccount(generatePrivateKey());
    await getDb().insert(schema.userAddresses).values({ userId: other.id, address: otherWallet.address.toLowerCase(), kind: "EXTERNAL", isPrimary: true });
    await getDb().execute(sql`
      insert into chain.donation (id, campaign, donor, amount, preference, sub_pool_id, tx_hash, log_index, block_number, block_time)
      values (${hash()}, ${c2.address}, ${otherWallet.address.toLowerCase()}, 1000000, 0, 0, ${hash()}, 0, 1, ${nowS()})
    `);
    await getDb().execute(sql`
      insert into chain.donation (id, campaign, donor, amount, preference, sub_pool_id, tx_hash, log_index, block_number, block_time)
      values (${hash()}, ${c2.address}, ${donorWallet.address.toLowerCase()}, 1000000, 0, 0, ${hash()}, 0, 1, ${nowS()})
    `);
    expect(await save(c1, await sign(c1, 5, "Great"))).toMatchObject({ ok: true });
    expect(await save(c2, await sign(c2, 4, null))).toMatchObject({ ok: true });
    expect(await save(c2, await sign(c2, 2, "Slow updates", nowS(), otherWallet), other)).toMatchObject({ ok: true });
    await getDb().delete(schema.userAddresses).where(eq(schema.userAddresses.userId, other.id));

    const before = (await orgRatingSummaries(getDb(), [orgId])).get(orgId)!;
    expect(before.count).toBeGreaterThanOrEqual(3); // earlier tests rated other campaigns of the same organisation
    const forC2 = await listRatings(getDb(), { campaignId: c2.id });
    expect(forC2.map((r) => [r.stars, r.comment]).sort()).toEqual([[2, "Slow updates"], [4, null]]);
    expect(Object.keys(forC2[0]!).sort()).toEqual(["campaignId", "campaignTitle", "comment", "stars", "updatedAt"]);
    const all = await listRatings(getDb(), { orgId });
    expect(all.length).toBe(before.count);
    const mean = all.reduce((t, r) => t + r.stars, 0) / all.length;
    expect(before.average).toBe(Math.round(mean * 10) / 10);
    expect(await orgRatingSummaries(getDb(), [])).toEqual(new Map());
  });
});

describe("GET/POST /api/campaigns/:id/rating", () => {
  const req = (id: string, user: TestUser | null, init: RequestInit = {}) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Origin: ORIGIN };
    if (user) headers.cookie = user.cookie;
    return new Request(`${ORIGIN}/api/campaigns/${id}/rating`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  };
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("tells a donor they can rate, and refuses without a session, a wrong origin or bad input", async () => {
    const c = await campaign({}, { release: nowS() - DAY });
    expect((await GET(req(c.id, null), ctx(c.id))).status).toBe(401);
    const res = await GET(req(c.id, donor), ctx(c.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "open", organization: orgId, campaign: expect.any(String), rating: null });
    expect((await GET(req("nope", donor), ctx("nope"))).status).toBe(404);

    const body = JSON.stringify(await sign(c, 5, null));
    expect((await POST(req(c.id, donor, { method: "POST", body, headers: { Origin: "https://evil.example" } }), ctx(c.id))).status).toBe(403);
    expect((await POST(req(c.id, null, { method: "POST", body }), ctx(c.id))).status).toBe(401);
    expect((await POST(req(c.id, donor, { method: "POST", body: "{}" }), ctx(c.id))).status).toBe(400);
    const stranger403 = await POST(req(c.id, stranger, { method: "POST", body }), ctx(c.id));
    expect([stranger403.status, await stranger403.json()]).toEqual([403, { error: "not_donor" }]);
  });
});
