import { and, eq, sql } from "drizzle-orm";
import { auditLog, type Database } from "@cherrio/db";
import { isMissingRelation } from "@/lib/campaigns/publish";

// Admin → Chain actions → Emergency Pool allocations (TASK-014c-3). A vote that
// ended without quorum, or in a sub-pool where nobody had voting weight, stays
// NEEDS_REVIEW until the Guardian decides with EmergencyPool.resolveAllocation(id,
// approve): approve sends the money to the campaign (RESOLVED_PASS, or
// DELIVERY_FAILED when the campaign no longer accepts it), reject returns it to
// the sub-pool (RESOLVED_REJECT). The Guardian signs in their own wallet
// (ADR-035); this module checks the indexed state and writes the note and the
// transaction to audit_log, like the campaign resolves (TASK-033d).

export const RESOLVE_NOTE_MIN = 10;
export const RESOLVE_NOTE_MAX = 2000;

export type ResolveRefusal = "not_found" | "wrong_state" | "chain_unavailable";

export class AllocationResolveRefusedError extends Error {
  constructor(public readonly code: ResolveRefusal) {
    super(code);
    this.name = "AllocationResolveRefusedError";
  }
}

interface IndexedAllocation {
  state: string;
  poolId: number;
  campaign: string;
  amount: string;
  /** The campaign's row in app.campaigns, when it was published here. */
  campaignId: string | null;
}

async function indexedAllocation(db: Database, allocationId: bigint): Promise<IndexedAllocation> {
  let rows: { state: string; pool_id: number; campaign: string; amount: string; campaign_id: string | null }[];
  try {
    rows = (await db.execute(sql`
      select a.state::text as state, a.pool_id, a.campaign, a.amount::text as amount, c.id as campaign_id
      from chain.allocation a
      left join app.campaigns c on c.onchain_address = a.campaign
      where a.id = ${allocationId.toString()}
    `)) as unknown as typeof rows;
  } catch (e) {
    if (isMissingRelation(e)) throw new AllocationResolveRefusedError("chain_unavailable");
    throw e;
  }
  const row = rows[0];
  if (!row) throw new AllocationResolveRefusedError("not_found");
  return { state: row.state, poolId: Number(row.pool_id), campaign: row.campaign, amount: row.amount, campaignId: row.campaign_id };
}

/**
 * Step 1, before the Guardian's wallet opens: the allocation must be
 * NEEDS_REVIEW in the indexed state; the decision and the note are written to
 * audit_log (`pool.allocation_resolve.requested`) and kept even if the wallet is
 * then cancelled. The audit entry hangs on the campaign (entity ids are UUIDs).
 */
export async function recordResolveIntent(
  db: Database,
  adminId: string,
  allocationId: bigint,
  input: { approve: boolean; note: string },
  ip?: string
): Promise<{ requestId: string }> {
  const a = await indexedAllocation(db, allocationId);
  if (a.state !== "NEEDS_REVIEW") throw new AllocationResolveRefusedError("wrong_state");
  const [row] = await db
    .insert(auditLog)
    .values({
      actorUserId: adminId,
      action: "pool.allocation_resolve.requested",
      entityType: "campaign",
      entityId: a.campaignId,
      data: {
        allocationId: allocationId.toString(), approve: input.approve, note: input.note,
        poolId: a.poolId, campaign: a.campaign, amountUsdc: a.amount,
      },
      ip,
    })
    .returning({ id: auditLog.id });
  return { requestId: row!.id };
}

/**
 * Step 2, after the wallet returned a hash: links the transaction to the
 * request. Not re-checked against the state (the indexer may not have seen it
 * yet); the request must exist and belong to this allocation.
 */
export async function recordResolveSent(
  db: Database,
  adminId: string,
  allocationId: bigint,
  input: { requestId: string; txHash: string },
  ip?: string
): Promise<void> {
  const [request] = await db
    .select({ entityId: auditLog.entityId, data: auditLog.data })
    .from(auditLog)
    .where(and(eq(auditLog.id, input.requestId), eq(auditLog.action, "pool.allocation_resolve.requested")));
  const data = (request?.data ?? {}) as { allocationId?: unknown; approve?: unknown };
  if (!request || data.allocationId !== allocationId.toString()) throw new AllocationResolveRefusedError("not_found");
  await db.insert(auditLog).values({
    actorUserId: adminId,
    action: "pool.allocation_resolve.sent",
    entityType: "campaign",
    entityId: request.entityId,
    data: { requestId: input.requestId, allocationId: allocationId.toString(), approve: data.approve, txHash: input.txHash.toLowerCase() },
    ip,
  });
}
