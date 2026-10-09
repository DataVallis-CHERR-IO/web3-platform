import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, campaigns, poolAllocationReasons, type Database } from "@cherrio/db";
import { isMissingRelation } from "@/lib/campaigns/publish";

// Admin → Emergency Pool → "Propose an allocation" (TASK-014c). The public
// reason is stored here and only its SHA-256 goes on chain (reasonHash), so
// anyone can re-hash the text shown on the public page and compare it with the
// AllocationProposed event. The Operator signs proposeAllocation in the browser.

export const REASON_MAX = 1000;

/** reasonHash of a reason: 0x + SHA-256 of the exact UTF-8 text, lower-case hex. */
export function reasonHash(text: string): `0x${string}` {
  return `0x${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** The reason as stored and hashed: trimmed, Windows line ends unified. Empty → null; longer than REASON_MAX → null. */
export function normalizeReason(text: string): string | null {
  const t = text.replace(/\r\n?/g, "\n").trim();
  return t.length === 0 || t.length > REASON_MAX ? null : t;
}

export interface ProposableCampaign {
  id: string;
  title: string;
  /** Lower-case campaign contract address. */
  address: string;
  deadline: Date;
}

/**
 * Campaigns an allocation can go to: published, LIVE on chain and before the
 * deadline (the contract also needs the deadline after the vote end — it refuses
 * with CampaignDeadlineTooSoon, shown to the admin). Null while the views are missing.
 */
export async function proposableCampaigns(db: Database): Promise<ProposableCampaign[] | null> {
  try {
    const rows = (await db.execute(sql`
      select c.id, c.title, c.onchain_address as address, ch.deadline::text as deadline
      from app.campaigns c
      join chain.campaign ch on ch.address = c.onchain_address
      where c.status = 'DEPLOYED' and ch.state::text = 'LIVE' and ch.deadline > extract(epoch from now())
      order by ch.deadline asc
      limit 200
    `)) as unknown as { id: string; title: string; address: string; deadline: string }[];
    return rows.map((r) => ({ id: r.id, title: r.title, address: r.address, deadline: new Date(Number(r.deadline) * 1000) }));
  } catch (e) {
    if (!isMissingRelation(e)) throw e;
    return null;
  }
}

export type SaveReasonResult =
  | { ok: true; reasonHash: `0x${string}`; campaignAddress: string }
  | { ok: false; error: "invalid_reason" | "campaign_not_published" };

/**
 * Stores the reason before the Operator signs (idempotent: the same text gives
 * the same hash and keeps its first row). The campaign must be published with a
 * contract address; the chain checks the rest (LIVE, deadline, pool balance).
 */
export async function saveAllocationReason(
  db: Database,
  adminId: string,
  input: { poolId: number; campaignId: string; amountUsdc: bigint; text: string },
  ip?: string
): Promise<SaveReasonResult> {
  const text = normalizeReason(input.text);
  if (text === null) return { ok: false, error: "invalid_reason" };
  const [campaign] = await db
    .select({ address: campaigns.onchainAddress })
    .from(campaigns)
    .where(and(eq(campaigns.id, input.campaignId), eq(campaigns.status, "DEPLOYED")));
  if (!campaign?.address) return { ok: false, error: "campaign_not_published" };
  const hash = reasonHash(text);
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(poolAllocationReasons)
      .values({ reasonHash: hash, text, poolId: input.poolId, campaignId: input.campaignId, amountUsdc: input.amountUsdc.toString(), createdBy: adminId })
      .onConflictDoNothing({ target: poolAllocationReasons.reasonHash })
      .returning({ id: poolAllocationReasons.id });
    await tx.insert(auditLog).values({
      actorUserId: adminId, action: "pool.allocation_reason_saved", entityType: "campaign", entityId: input.campaignId,
      data: { poolId: input.poolId, amountUsdc: input.amountUsdc.toString(), reasonHash: hash, reused: inserted.length === 0 }, ip,
    });
  });
  return { ok: true, reasonHash: hash, campaignAddress: campaign.address };
}

/** Records the proposeAllocation transaction an admin's wallet sent; false when the reason is unknown. */
export async function recordAllocationSent(
  db: Database, adminId: string, input: { reasonHash: string; txHash: string }, ip?: string
): Promise<boolean> {
  const [row] = await db
    .select({ campaignId: poolAllocationReasons.campaignId, poolId: poolAllocationReasons.poolId })
    .from(poolAllocationReasons)
    .where(eq(poolAllocationReasons.reasonHash, input.reasonHash.toLowerCase()));
  if (!row) return false;
  await db.insert(auditLog).values({
    actorUserId: adminId, action: "pool.allocation_propose.sent", entityType: "campaign", entityId: row.campaignId,
    data: { poolId: row.poolId, reasonHash: input.reasonHash.toLowerCase(), txHash: input.txHash.toLowerCase() }, ip,
  });
  return true;
}
