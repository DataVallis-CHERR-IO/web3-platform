import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLog, campaigns, organizations, orgMembers, type Database } from "@cherrio/db";
import { campaignGoal, eurCentsToUsdc, isSanctionedCountry, MIN_CAMPAIGN_TARGET_USDC, rateToNumeric8, usdCentsToUsdc } from "@cherrio/shared";
import { fetchEcbUsdRate, type EcbRate } from "./ecb";

// Campaign review (TASK-010b): a platform admin approves a PENDING_REVIEW
// campaign with the ECB EUR→USDC snapshot (ADR-036) — or 1:1 for a USD goal
// (ADR-060) — or rejects it with a note.
// Each decision is one transaction and is written to audit_log.

export type CampaignReviewRefusal =
  | "not_found"
  | "not_pending"
  | "self_review"
  | "organization_not_approved"
  | "rate_unavailable"
  | "target_below_minimum"
  /** ADR-054: campaign or organisation country under EU/US/UN sanctions. */
  | "sanctioned_country"
  // publishing (TASK-010c)
  | "not_approved"
  | "not_prepared"
  | "contracts_unavailable"
  // admin chain actions (TASK-033d)
  | "not_deployed"
  | "chain_unavailable"
  | "wrong_state";

/** The review cannot be done; nothing was written. */
export class CampaignReviewRefusedError extends Error {
  constructor(public readonly code: CampaignReviewRefusal) {
    super(code);
    this.name = "CampaignReviewRefusedError";
  }
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
const refuse = (code: CampaignReviewRefusal): never => {
  throw new CampaignReviewRefusedError(code);
};


/** Locks the campaign and its organisation and checks that this reviewer may decide it. */
async function lockForReview(tx: Tx, reviewerId: string, campaignId: string) {
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId)).for("update");
  if (!campaign?.orgId) return refuse("not_found");
  const [organization] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, campaign.orgId))
    .for("share");
  if (!organization) return refuse("not_found");
  if (campaign.status !== "PENDING_REVIEW") refuse("not_pending");

  // Same rule as KYB: nobody reviews a campaign of an organisation they belong to (any role),
  // nor one they started.
  const [membership] = await tx
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, organization.id), eq(orgMembers.userId, reviewerId)))
    .limit(1);
  if (membership || campaign.starterUserId === reviewerId) refuse("self_review");
  return { campaign, organization };
}

/** How the goal became the USDC target: the ECB EUR rate, or 1 USD = 1 USDC (ADR-060). */
export type RateSource = "ECB" | "USD_PEG";

export interface ApproveResult {
  campaignId: string;
  goalCurrency: string;
  rateSource: RateSource;
  /** USD per EUR, only for EUR goals. */
  eurUsdRate: string | null;
  rateAt: string;
  targetUsdc: string;
}

/**
 * Approve: fetch the ECB rate first (outside the transaction, so no lock is held
 * during a network call), then convert the EUR target, copy the organisation's
 * verified payout address, create the 32-byte offchain id and set APPROVED.
 */
export async function approveCampaign(
  db: Database,
  reviewerId: string,
  campaignId: string,
  options: { getRate?: () => Promise<EcbRate>; ip?: string } = {}
): Promise<ApproveResult> {
  // Cheap checks first, so a decided or unknown campaign never costs an ECB request.
  const [current] = await db
    .select({ status: campaigns.status, orgId: campaigns.orgId, goalCurrency: campaigns.goalCurrency })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!current?.orgId) refuse("not_found");
  if (current!.status !== "PENDING_REVIEW") refuse("not_pending");

  // A USD goal needs no rate (1 USD = 1 USDC); EUR goals use the day's ECB rate.
  let ecb: EcbRate | null = null;
  if (current!.goalCurrency !== "USD") {
    try {
      ecb = await (options.getRate ?? (() => fetchEcbUsdRate()))();
    } catch (e) {
      console.error("[campaign.approve] ECB rate unavailable:", e instanceof Error ? e.message : e);
      return refuse("rate_unavailable");
    }
  }

  return db.transaction(async (tx) => {
    const { campaign, organization } = await lockForReview(tx, reviewerId, campaignId);
    if (organization.kybStatus !== "APPROVED" || !organization.payoutAddress) refuse("organization_not_approved");
    if (isSanctionedCountry(campaign.country) || (organization.country && isSanctionedCountry(organization.country))) {
      refuse("sanctioned_country");
    }

    // The currency is read again under the lock: the cheap read above only decided whether to fetch a rate.
    const goal = campaignGoal(campaign.goalCurrency, campaign.goalAmountMinor);
    let targetUsdc: bigint;
    let eurUsdRate: string | null = null;
    let rateSource: RateSource;
    let rateAt: Date;
    if (goal.currency === "USD") {
      targetUsdc = usdCentsToUsdc(goal.minor);
      rateSource = "USD_PEG";
      rateAt = new Date();
    } else {
      if (!ecb) return refuse("rate_unavailable"); // the currency changed between the two reads
      targetUsdc = eurCentsToUsdc(goal.minor, ecb.rate);
      eurUsdRate = rateToNumeric8(ecb.rate);
      rateSource = "ECB";
      rateAt = ecb.date;
    }
    if (targetUsdc < MIN_CAMPAIGN_TARGET_USDC) refuse("target_below_minimum");

    await tx
      .update(campaigns)
      .set({
        status: "APPROVED",
        eurUsdRate,
        rateSource,
        rateAt,
        targetUsdc,
        beneficiaryAddress: organization.payoutAddress!.toLowerCase(),
        offchainId: campaign.offchainId ?? randomBytes(32),
        reviewNote: null,
        reviewedAt: new Date(),
        reviewerId,
      })
      .where(eq(campaigns.id, campaign.id));

    const result: ApproveResult = {
      campaignId: campaign.id,
      goalCurrency: goal.currency,
      rateSource,
      eurUsdRate,
      rateAt: rateAt.toISOString().slice(0, 10),
      targetUsdc: targetUsdc.toString(),
    };
    await tx.insert(auditLog).values({
      actorUserId: reviewerId,
      action: "campaign.approve",
      entityType: "campaign",
      entityId: campaign.id,
      data: { organizationId: organization.id, ...result },
      ip: options.ip,
    });
    return result;
  });
}

/** Reject with a note for the organisation (the note is not copied to audit_log). */
export async function rejectCampaign(
  db: Database,
  reviewerId: string,
  campaignId: string,
  note: string,
  ip?: string
): Promise<{ campaignId: string }> {
  return db.transaction(async (tx) => {
    const { campaign, organization } = await lockForReview(tx, reviewerId, campaignId);
    await tx
      .update(campaigns)
      .set({ status: "REJECTED", reviewNote: note, reviewedAt: new Date(), reviewerId })
      .where(eq(campaigns.id, campaign.id));
    await tx.insert(auditLog).values({
      actorUserId: reviewerId,
      action: "campaign.reject",
      entityType: "campaign",
      entityId: campaign.id,
      data: { organizationId: organization.id },
      ip,
    });
    return { campaignId: campaign.id };
  });
}
