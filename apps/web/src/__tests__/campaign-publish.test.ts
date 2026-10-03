import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getAddress, type Hex } from "viem";
import * as schema from "@cherrio/db";
import { predictCampaignAddress } from "@cherrio/shared";
import { getDb } from "@/lib/db";
import { POST as prepareRoute } from "@/app/api/admin/campaigns/[id]/publish/prepare/route";
import { POST as sentRoute } from "@/app/api/admin/campaigns/[id]/publish/sent/route";
import { POST as checkRoute } from "@/app/api/admin/campaigns/[id]/publish/check/route";
import { linkDeployedCampaign, preparePublish, publishDeployment, recordPublishTx, type PublishDeployment } from "@/lib/campaigns/publish";
import { applicationRateLimiter } from "@/lib/security/rate-limit";
import { cleanUp, createOrganization, createUser, ORIGIN, PAYOUT_ADDRESS, type TestUser } from "./helpers/organizations";
import { ensureFakeChain } from "./helpers/fake-chain";

// Integration tests for on-chain publishing (TASK-010c): prepare, record the
// hash, and link through the indexer's `chain.campaign` view — simulated here
// by a table with the same columns (the test database has no indexer).

const { campaigns, auditLog, orgMembers } = schema;
const AMOY_DEV: PublishDeployment = {
  chainId: 80002,
  factory: "0xd5Ca76A8FC6E15C6cC3F3C691A2b6c70D9715a00",
  implementation: "0x6F6A9F54cC48a13bC5bFc127d16D874D07ccEA8F",
  platformConfig: "0x4d2570ccB2a6653D62a002027C0d383FfB193A16",
};
const TARGET = 14_080_800_000n;
const NOW = new Date("2026-10-02T12:00:00.400Z");
const txHash = () => `0x${randomBytes(32).toString("hex")}`;
const offchainIds: Hex[] = [];

type Result = { status: number; json: Record<string, unknown> | null };
async function call(route: (req: Request, ctx: never) => Promise<Response>, user: TestUser | null, id: string, body: unknown = {}): Promise<Result> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: ORIGIN };
  if (user) headers.cookie = user.cookie;
  const res = await route(new Request(`${ORIGIN}/api/admin/campaigns/${id}/publish`, { method: "POST", headers, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  } as never);
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

const campaignRow = async (id: string) => (await getDb().select().from(campaigns).where(eq(campaigns.id, id)))[0]!;
const auditActions = async (id: string) =>
  (await getDb().select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, id))).map((a) => a.action).sort();

let n = 0;
/** A campaign as the review left it: APPROVED with the snapshot. */
async function approvedCampaign(owner: TestUser, orgId: string, reviewer: TestUser): Promise<{ id: string; offchainId: Hex }> {
  const offchain = randomBytes(32);
  offchainIds.push(`0x${offchain.toString("hex")}`);
  const [row] = await getDb()
    .insert(campaigns)
    .values({
      orgId, starterUserId: owner.id, beneficiaryType: "ORGANIZATION", title: `Publish test ${++n}`,
      slug: `publish-test-${orgId}-${n}`, story: { format: "plain", text: "x".repeat(60) }, cause: "animals",
      country: "SI", targetEurCents: "1200000", durationDays: 30, status: "APPROVED", submittedAt: new Date(),
      eurUsdRate: "1.17340000", rateSource: "ECB", rateAt: new Date("2026-10-01T00:00:00Z"), targetUsdc: TARGET,
      beneficiaryAddress: PAYOUT_ADDRESS.toLowerCase(), offchainId: offchain, reviewerId: reviewer.id, reviewedAt: new Date(),
    })
    .returning({ id: campaigns.id });
  return { id: row!.id, offchainId: `0x${offchain.toString("hex")}` };
}

/** What the indexer writes when it sees CampaignCreated (columns of the `chain.campaign` view). */
async function indexerRow(offchainId: Hex, override: Partial<{ address: string; beneficiary: string; target: string; deadline: string }> = {}) {
  const row = {
    address: predictCampaignAddress(AMOY_DEV.factory, AMOY_DEV.implementation, offchainId).toLowerCase(),
    beneficiary: PAYOUT_ADDRESS.toLowerCase(),
    target: TARGET.toString(),
    deadline: String(Math.floor(NOW.getTime() / 1000) + 30 * 86_400),
    ...override,
  };
  await getDb().execute(sql`
    insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, state, tx_hash, log_index, block_number, block_time)
    values (${row.address}, ${offchainId}, ${row.beneficiary}, 0, ${row.target}::numeric, ${row.deadline}::numeric, 'LIVE',
            ${`0x${"9a".repeat(32)}`}, 3, 49100000, 1791028800)
  `);
  return row;
}

describe("campaign publishing — prepare, record the transaction, link through the indexer (Postgres)", () => {
  let admin: TestUser;
  let owner: TestUser;
  let orgId: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("campaign publish tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await ensureFakeChain(getDb());
    admin = await createUser({ admin: true });
    owner = await createUser();
    orgId = (await createOrganization(owner)).id;
  });
  beforeEach(() => applicationRateLimiter.reset());
  afterAll(async () => {
    for (const id of offchainIds) await getDb().execute(sql`delete from chain.campaign where offchain_id = ${id}`);
    await cleanUp();
  });

  it("prepare: the createCampaign parameters from the approval, the deadline stored, the clone address predicted", async () => {
    const { id, offchainId } = await approvedCampaign(owner, orgId, admin);
    const prepared = await preparePublish(getDb(), admin.id, id, AMOY_DEV, NOW);
    const deadline = Math.floor(NOW.getTime() / 1000) + 30 * 86_400;
    expect(prepared).toEqual({
      chainId: 80002,
      factory: getAddress(AMOY_DEV.factory),
      platformConfig: getAddress(AMOY_DEV.platformConfig),
      predictedAddress: predictCampaignAddress(AMOY_DEV.factory, AMOY_DEV.implementation, offchainId),
      params: { offchainId, beneficiary: PAYOUT_ADDRESS, target: "14080800000", deadline: String(deadline), beneficiaryType: 0 },
    });
    expect((await campaignRow(id)).deadline!.getTime()).toBe(deadline * 1000);

    // Preparing again later: a new deadline, the same offchain id.
    const later = await preparePublish(getDb(), admin.id, id, AMOY_DEV, new Date(NOW.getTime() + 3_600_000));
    expect(later.params.offchainId).toBe(offchainId);
    expect(Number(later.params.deadline)).toBe(deadline + 3600);
  });

  it("the full path: prepare → sent → indexer row → DEPLOYED, audited once", async () => {
    const { id, offchainId } = await approvedCampaign(owner, orgId, admin);
    await expect(recordPublishTx(getDb(), admin.id, id, txHash())).rejects.toThrow("not_prepared");
    await preparePublish(getDb(), admin.id, id, AMOY_DEV, NOW);
    const hash = txHash().toUpperCase().replace("0X", "0x");
    await recordPublishTx(getDb(), admin.id, id, hash);
    expect((await campaignRow(id)).publishTxHash).toBe(hash.toLowerCase());

    expect(await linkDeployedCampaign(getDb(), admin.id, id, AMOY_DEV)).toEqual({ status: "APPROVED", onChain: "not_found", publishing: true });
    const onChain = await indexerRow(offchainId);
    expect(await linkDeployedCampaign(getDb(), admin.id, id, AMOY_DEV)).toEqual({ status: "DEPLOYED", address: getAddress(onChain.address) });
    expect(await campaignRow(id)).toMatchObject({
      status: "DEPLOYED",
      onchainAddress: onChain.address,
      deployedAt: new Date(1_791_028_800_000),
      publishTxHash: `0x${"9a".repeat(32)}`, // the hash the indexer saw wins
    });
    // Again: nothing changes, no second audit row.
    expect((await linkDeployedCampaign(getDb(), admin.id, id, AMOY_DEV)).status).toBe("DEPLOYED");
    expect(await auditActions(id)).toEqual(["campaign.deployed", "campaign.publish_sent"]);
    await expect(preparePublish(getDb(), admin.id, id, AMOY_DEV, NOW)).rejects.toThrow("not_approved");
  });

  it("an on-chain campaign that does not match (target, beneficiary, deadline or address) is not linked; audited once", async () => {
    for (const override of [
      { target: (TARGET + 1n).toString() },
      { beneficiary: `0x${"12".repeat(20)}` },
      { deadline: "1" },
      { address: `0x${"34".repeat(20)}` },
    ]) {
      const { id, offchainId } = await approvedCampaign(owner, orgId, admin);
      await preparePublish(getDb(), admin.id, id, AMOY_DEV, NOW);
      await indexerRow(offchainId, override);
      const expected = { status: "APPROVED", onChain: "mismatch", publishing: false };
      expect(await linkDeployedCampaign(getDb(), admin.id, id, AMOY_DEV), JSON.stringify(override)).toEqual(expected);
      expect(await linkDeployedCampaign(getDb(), admin.id, id, AMOY_DEV)).toEqual(expected);
      expect(await campaignRow(id)).toMatchObject({ status: "APPROVED", onchainAddress: null });
      expect(await auditActions(id)).toEqual(["campaign.link_mismatch"]);
    }
  });

  it("routes: admin only (404), member refused, only APPROVED, no contracts in local, hash format checked", async () => {
    const { id } = await approvedCampaign(owner, orgId, admin);
    const stranger = await createUser();
    expect(await call(prepareRoute as never, null, id)).toEqual({ status: 404, json: null });
    expect(await call(prepareRoute as never, stranger, id)).toEqual({ status: 404, json: null });
    expect(await call(sentRoute as never, owner, id, { txHash: txHash() })).toEqual({ status: 404, json: null });
    expect(await call(checkRoute as never, stranger, id)).toEqual({ status: 404, json: null });

    // APP_ENV=local has no contracts: nothing to prepare, nothing to link.
    expect(publishDeployment()).toBeNull();
    expect(await call(prepareRoute as never, admin, id)).toEqual({ status: 409, json: { error: "contracts_unavailable" } });
    expect(await call(checkRoute as never, admin, id)).toEqual({
      status: 200, json: { status: "APPROVED", onChain: "indexer_unavailable", publishing: false },
    });
    expect(await call(sentRoute as never, admin, id, { txHash: "0x1234" })).toEqual({ status: 400, json: { error: "validation_failed" } });
    expect(await call(sentRoute as never, admin, id, { txHash: txHash() })).toEqual({ status: 409, json: { error: "not_prepared" } });

    const memberAdmin = await createUser({ admin: true });
    await getDb().insert(orgMembers).values({ orgId, userId: memberAdmin.id, role: "ORG_MEMBER" });
    expect(await call(prepareRoute as never, memberAdmin, id)).toEqual({ status: 409, json: { error: "self_review" } });
    await getDb().delete(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, memberAdmin.id)));

    await getDb().update(campaigns).set({ status: "PENDING_REVIEW" }).where(eq(campaigns.id, id));
    expect(await call(prepareRoute as never, admin, id)).toEqual({ status: 409, json: { error: "not_approved" } });
    expect((await campaignRow(id)).deadline).toBeNull();
  });
});
