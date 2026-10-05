import { and, eq, isNull, sql } from "drizzle-orm";
import { getAddress, type Address, type Hex } from "viem";
import { auditLog, campaigns, orgMembers, type Database } from "@cherrio/db";
import { getChainConfig, parseAppEnv, predictCampaignAddress } from "@cherrio/shared";
import { CampaignReviewRefusedError } from "./review";

// On-chain publishing (TASK-010c, ADR-035). The server prepares the
// CampaignFactory.createCampaign call; the admin signs it in the browser with
// the operator wallet; the server stores the transaction hash and links the
// campaign once the indexer has seen CampaignCreated. The server never holds a key.

/** Where campaigns are created in this environment. */
export interface PublishDeployment {
  chainId: number;
  factory: Address;
  implementation: Address;
  platformConfig: Address;
}

/** The deployment of APP_ENV, or null where no contracts exist (local). */
export function publishDeployment(env: NodeJS.ProcessEnv = process.env): PublishDeployment | null {
  if (!env.APP_ENV) throw new Error("[Campaigns] APP_ENV is not set");
  const config = getChainConfig(parseAppEnv(env.APP_ENV));
  const contracts = config.contracts;
  const factory = contracts?.campaignFactory?.address;
  const implementation = contracts?.campaignImplementation?.address;
  const platformConfig = contracts?.platformConfig?.address;
  if (!factory || !implementation || !platformConfig) return null;
  return { chainId: config.chain.id, factory, implementation, platformConfig };
}

const refuse = (code: ConstructorParameters<typeof CampaignReviewRefusedError>[0]): never => {
  throw new CampaignReviewRefusedError(code);
};
type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

const offchainHex = (id: Buffer): Hex => `0x${id.toString("hex")}`;
const epochSeconds = (date: Date) => BigInt(Math.floor(date.getTime() / 1000));

/** An APPROVED campaign that this admin may publish (not a member of the organisation). */
async function loadForPublish(db: Executor, adminId: string, campaignId: string) {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!campaign?.orgId) return refuse("not_found");
  if (campaign.status !== "APPROVED") refuse("not_approved");
  if (!campaign.offchainId || !campaign.beneficiaryAddress || campaign.targetUsdc === null) refuse("not_approved");
  const [membership] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, campaign.orgId), eq(orgMembers.userId, adminId)))
    .limit(1);
  if (membership || campaign.starterUserId === adminId) refuse("self_review");
  return campaign;
}

export interface PreparedPublish {
  chainId: number;
  factory: Address;
  platformConfig: Address;
  predictedAddress: Address;
  /** CampaignFactory.CreateParams; uint values as decimal strings. */
  params: { offchainId: Hex; beneficiary: Address; target: string; deadline: string; beneficiaryType: 0 };
}

/**
 * Prepares the createCampaign call: deadline = now + duration (whole seconds),
 * stored on the campaign; offchainId, beneficiary and target come from the
 * approval snapshot. Preparing again (after a failed or dropped transaction)
 * gives a new deadline; the offchainId stays, so the contract can never hold two.
 */
export async function preparePublish(
  db: Database,
  adminId: string,
  campaignId: string,
  deployment: PublishDeployment | null,
  now: Date = new Date()
): Promise<PreparedPublish> {
  const campaign = await loadForPublish(db, adminId, campaignId);
  if (!deployment) return refuse("contracts_unavailable");

  const deadline = new Date(Math.floor(now.getTime() / 1000) * 1000 + campaign.durationDays * 86_400_000);
  const updated = await db
    .update(campaigns)
    .set({ deadline })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, "APPROVED")))
    .returning({ id: campaigns.id });
  if (updated.length === 0) refuse("not_approved");

  const offchainId = offchainHex(campaign.offchainId!);
  return {
    chainId: deployment.chainId,
    factory: getAddress(deployment.factory),
    platformConfig: getAddress(deployment.platformConfig),
    predictedAddress: predictCampaignAddress(deployment.factory, deployment.implementation, offchainId),
    params: {
      offchainId,
      beneficiary: getAddress(campaign.beneficiaryAddress!),
      target: campaign.targetUsdc!.toString(),
      deadline: epochSeconds(deadline).toString(),
      beneficiaryType: 0,
    },
  };
}

/** The browser sent the transaction: store its hash ("publishing"). */
export async function recordPublishTx(
  db: Database,
  adminId: string,
  campaignId: string,
  txHash: string,
  ip?: string
): Promise<{ campaignId: string; txHash: string }> {
  const hash = txHash.toLowerCase();
  return db.transaction(async (tx) => {
    const campaign = await loadForPublish(tx, adminId, campaignId);
    if (!campaign.deadline) refuse("not_prepared");
    await tx.update(campaigns).set({ publishTxHash: hash }).where(eq(campaigns.id, campaignId));
    await tx.insert(auditLog).values({
      actorUserId: adminId,
      action: "campaign.publish_sent",
      entityType: "campaign",
      entityId: campaignId,
      data: { organizationId: campaign.orgId, txHash: hash },
      ip,
    });
    return { campaignId, txHash: hash };
  });
}

/** A row of the indexer's `chain.campaign` view, as text (no versioned enum types referenced). */
interface ChainCampaignRow {
  address: string;
  beneficiary: string;
  beneficiary_type: number;
  target: string;
  deadline: string;
  state: string;
  tx_hash: string;
  block_time: string;
  [key: string]: unknown;
}

export type LinkResult =
  | { status: "DEPLOYED"; address: Address }
  | { status: "APPROVED"; onChain: "not_found" | "mismatch" | "indexer_unavailable"; publishing: boolean }
  | { status: Exclude<string, "APPROVED" | "DEPLOYED"> };

/** Postgres: relation or schema does not exist — no indexer views in this database. */
export const isMissingRelation = (e: unknown) => {
  const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === "42P01" || code === "3F000";
};

/**
 * Links an APPROVED campaign to its contract once the indexer has seen it:
 * the row with our offchain id must match the predicted address, the
 * beneficiary, the target and the deadline — otherwise nothing is linked and
 * the mismatch is audited once. Read-only towards `chain`; no RPC.
 */
export async function linkDeployedCampaign(
  db: Database,
  actorId: string | null,
  campaignId: string,
  deployment: PublishDeployment | null
): Promise<LinkResult> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!campaign) throw new CampaignReviewRefusedError("not_found");
  if (campaign.status === "DEPLOYED") return { status: "DEPLOYED", address: getAddress(campaign.onchainAddress!) };
  if (campaign.status !== "APPROVED" || !campaign.offchainId) return { status: campaign.status };
  const publishing = campaign.publishTxHash !== null;
  if (!deployment) return { status: "APPROVED", onChain: "indexer_unavailable", publishing };

  const offchainId = offchainHex(campaign.offchainId);
  let rows: ChainCampaignRow[];
  try {
    rows = (await db.execute(sql`
      select address, beneficiary, beneficiary_type, target::text as target, deadline::text as deadline,
             state::text as state, tx_hash, block_time::text as block_time
      from chain.campaign
      where offchain_id = ${offchainId}
      limit 1
    `)) as unknown as ChainCampaignRow[];
  } catch (e) {
    if (!isMissingRelation(e)) throw e;
    return { status: "APPROVED", onChain: "indexer_unavailable", publishing };
  }
  const row = rows[0];
  if (!row) return { status: "APPROVED", onChain: "not_found", publishing };

  const predicted = predictCampaignAddress(deployment.factory, deployment.implementation, offchainId).toLowerCase();
  const matches =
    row.address.toLowerCase() === predicted &&
    row.beneficiary.toLowerCase() === campaign.beneficiaryAddress?.toLowerCase() &&
    Number(row.beneficiary_type) === 0 &&
    row.target === campaign.targetUsdc?.toString() &&
    campaign.deadline !== null &&
    row.deadline === epochSeconds(campaign.deadline).toString();

  if (!matches) {
    const [seen] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, campaignId), eq(auditLog.action, "campaign.link_mismatch")))
      .limit(1);
    if (!seen) {
      console.error(`[campaign.link] on-chain campaign does not match the approved one: ${campaignId}`);
      await db.insert(auditLog).values({
        actorUserId: actorId,
        action: "campaign.link_mismatch",
        entityType: "campaign",
        entityId: campaignId,
        data: {
          organizationId: campaign.orgId,
          onchainAddress: row.address.toLowerCase(),
          predictedAddress: predicted,
          onchain: { beneficiary: row.beneficiary.toLowerCase(), target: row.target, deadline: row.deadline },
        },
      });
    }
    return { status: "APPROVED", onChain: "mismatch", publishing };
  }

  const address = row.address.toLowerCase();
  const txHash = row.tx_hash.toLowerCase();
  return db.transaction(async (tx) => {
    const linked = await tx
      .update(campaigns)
      .set({
        status: "DEPLOYED",
        onchainAddress: address,
        deployedAt: new Date(Number(row.block_time) * 1000),
        publishTxHash: txHash,
      })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, "APPROVED"), isNull(campaigns.onchainAddress)))
      .returning({ id: campaigns.id });
    if (linked.length > 0) {
      await tx.insert(auditLog).values({
        actorUserId: actorId,
        action: "campaign.deployed",
        entityType: "campaign",
        entityId: campaignId,
        data: { organizationId: campaign.orgId, onchainAddress: address, txHash },
      });
    }
    return { status: "DEPLOYED" as const, address: getAddress(address) };
  });
}
