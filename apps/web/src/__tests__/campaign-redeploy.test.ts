import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { Hex } from "viem";
import * as schema from "@cherrio/db";
import { predictCampaignAddress } from "@cherrio/shared";
import { getDb } from "@/lib/db";
import type { PublishDeployment } from "@/lib/campaigns/publish";
import { RedeployResetRefusedError, resetCampaignsFromEarlierDeployment } from "@/lib/campaigns/redeploy";
import { cleanUp, createOrganization, createUser, PAYOUT_ADDRESS, type TestUser } from "./helpers/organizations";

// After the testnet contracts are deployed again: campaigns published to the
// old factory go back to APPROVED; campaigns on the current factory stay.

const { campaigns, auditLog, evidenceBundles } = schema;
const CURRENT: PublishDeployment = {
  chainId: 80002,
  factory: "0x30594D1B207d6101a82Bf2A89da622FB26E5a0B5",
  implementation: "0x2C1F9AA8FCD1a990D12A5Bdbd8C79dF19b3ED3c6",
  platformConfig: "0xFdC7134BDcE8e3Ed07322eD1F90DA15297ca5e0B",
};
// The amoy-dev factory before ADR-061.
const OLD = { factory: "0xd5Ca76A8FC6E15C6cC3F3C691A2b6c70D9715a00", implementation: "0x6F6A9F54cC48a13bC5bFc127d16D874D07ccEA8F" } as const;

let n = 0;
const ids: string[] = [];
async function deployedCampaign(owner: TestUser, orgId: string, on: { factory: string; implementation: string } | null, isDemo = false) {
  const offchain = randomBytes(32);
  const address = on
    ? predictCampaignAddress(on.factory as Hex, on.implementation as Hex, `0x${offchain.toString("hex")}` as Hex).toLowerCase()
    : null;
  const [row] = await getDb()
    .insert(campaigns)
    .values({
      orgId, starterUserId: owner.id, beneficiaryType: "ORGANIZATION", title: `Redeploy test ${++n}`,
      slug: `redeploy-test-${orgId}-${n}`, story: { format: "plain", text: "x".repeat(60) }, cause: "animals",
      country: "SI", goalAmountMinor: "1200000", durationDays: 30, status: address ? "DEPLOYED" : "APPROVED",
      submittedAt: new Date(), targetUsdc: 14_080_800_000n, beneficiaryAddress: PAYOUT_ADDRESS.toLowerCase(),
      offchainId: offchain, isDemo, onchainAddress: address, deadline: address ? new Date("2026-12-01T00:00:00Z") : null,
      deployedAt: address ? new Date("2026-11-01T00:00:00Z") : null, publishTxHash: address ? `0x${"ab".repeat(32)}` : null,
    })
    .returning({ id: campaigns.id });
  ids.push(row!.id);
  return { id: row!.id, address };
}
const row = async (id: string) => (await getDb().select().from(campaigns).where(eq(campaigns.id, id)))[0]!;

describe("campaigns from an earlier testnet deployment (Postgres)", () => {
  let owner: TestUser;
  let orgId: string;
  let old1: { id: string; address: string | null };
  let oldDemo: { id: string; address: string | null };
  let current: { id: string; address: string | null };
  let approved: { id: string; address: string | null };

  beforeAll(async () => {
    owner = await createUser();
    const admin = await createUser({ admin: true });
    orgId = (await createOrganization(admin)).id;
    old1 = await deployedCampaign(owner, orgId, OLD);
    // A round-0 evidence bundle made for the old contract (unique per campaign and round).
    await getDb().insert(evidenceBundles).values({ campaignId: old1.id, round: 0, note: "old contract" });
    oldDemo = await deployedCampaign(owner, orgId, OLD, true);
    current = await deployedCampaign(owner, orgId, CURRENT);
    approved = await deployedCampaign(owner, orgId, null);
  });
  afterAll(async () => {
    await getDb().delete(auditLog).where(inArray(auditLog.entityId, ids));
    await getDb().delete(campaigns).where(inArray(campaigns.id, ids));
    await cleanUp();
  });

  it("a dry run lists only the campaigns on the old factory and changes nothing", async () => {
    const { found, reset } = await resetCampaignsFromEarlierDeployment(getDb(), "dev", CURRENT, { apply: false });
    const mine = found.filter((c) => ids.includes(c.id));
    expect(mine.map((c) => c.id).sort()).toEqual([old1.id, oldDemo.id].sort());
    expect(mine.find((c) => c.id === oldDemo.id)?.isDemo).toBe(true);
    expect(reset).toBe(0);
    expect((await row(old1.id)).status).toBe("DEPLOYED");
  });

  it("--apply puts them back to APPROVED, clears the chain fields and writes the audit log", async () => {
    const now = new Date("2026-11-25T10:00:00Z");
    await resetCampaignsFromEarlierDeployment(getDb(), "dev", CURRENT, { apply: true, now });
    for (const c of [old1, oldDemo]) {
      const r = await row(c.id);
      expect(r).toMatchObject({ status: "APPROVED", onchainAddress: null, publishTxHash: null, deadline: null, deployedAt: null });
      expect(r.offchainId).not.toBeNull(); // the same id is published again on the new factory
      const [audit] = await getDb().select().from(auditLog)
        .where(and(eq(auditLog.entityId, c.id), eq(auditLog.action, "campaign.reset_after_redeploy")));
      expect(audit?.data).toEqual({
        previousAddress: c.address, factory: CURRENT.factory.toLowerCase(), evidenceBundlesRemoved: c.id === old1.id ? 1 : 0,
      });
    }
    expect(await getDb().select().from(evidenceBundles).where(eq(evidenceBundles.campaignId, old1.id))).toEqual([]);
    expect(await row(current.id)).toMatchObject({ status: "DEPLOYED", onchainAddress: current.address });
    expect((await row(approved.id)).status).toBe("APPROVED");
  });

  it("running it again finds nothing of these", async () => {
    const { found } = await resetCampaignsFromEarlierDeployment(getDb(), "dev", CURRENT, { apply: true });
    expect(found.filter((c) => ids.includes(c.id))).toEqual([]);
  });

  it("is refused on prod and without contracts", async () => {
    await expect(resetCampaignsFromEarlierDeployment(getDb(), "prod", CURRENT, { apply: false })).rejects.toBeInstanceOf(RedeployResetRefusedError);
    await expect(resetCampaignsFromEarlierDeployment(getDb(), "dev", null, { apply: false })).rejects.toBeInstanceOf(RedeployResetRefusedError);
    await expect(resetCampaignsFromEarlierDeployment(getDb(), "dev", { ...CURRENT, chainId: 137 }, { apply: false })).rejects.toBeInstanceOf(RedeployResetRefusedError);
  });
});
