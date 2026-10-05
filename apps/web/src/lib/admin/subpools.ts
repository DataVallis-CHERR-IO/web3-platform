import { eq, sql } from "drizzle-orm";
import { getAddress, isAddress, type Address } from "viem";
import { auditLog, emergencySubpools, type Database } from "@cherrio/db";
import { getChainConfig, parseAppEnv } from "@cherrio/shared";
import { isMissingRelation } from "@/lib/campaigns/publish";

// Admin → Emergency Pool (TASK-046). The themed sub-pools are reference rows in
// `app.emergency_subpools` (migration 0012) and must also exist on chain
// (`EmergencyPool.createSubPool`, Operator) before the donate panel offers them.
// This page shows both sides and lets the Operator create the missing ones.

export interface SubpoolRow {
  poolId: number;
  slug: string;
  /** The indexer has seen the pool (`chain.pool`). Pool 0 is created by the constructor. */
  onChain: boolean;
  /** USDC units (6 decimals); null when the pool is not on chain yet. */
  balance: bigint | null;
}

/** Every sub-pool row with its on-chain state; null while the indexer views are missing (a deploy). */
export async function loadSubpools(db: Database): Promise<SubpoolRow[] | null> {
  try {
    const rows = (await db.execute(sql`
      select s.pool_id, s.slug, p.id is not null as on_chain, p.balance
      from app.emergency_subpools s
      left join chain.pool p on p.id = s.pool_id
      order by s.pool_id
    `)) as unknown as { pool_id: number; slug: string; on_chain: boolean; balance: string | null }[];
    return rows.map((r) => ({
      poolId: Number(r.pool_id),
      slug: r.slug,
      onChain: Boolean(r.on_chain),
      balance: r.balance === null ? null : BigInt(r.balance),
    }));
  } catch (e) {
    if (!isMissingRelation(e)) throw e;
    return null;
  }
}

/**
 * The EmergencyPool of APP_ENV; null where there is none. On `local` there is no
 * deployment file: `LOCAL_EMERGENCY_POOL_ADDRESS` (a local Anvil deployment or the E2E fake wallet).
 */
export function emergencyPoolAddress(appEnv = process.env.APP_ENV, env: Record<string, string | undefined> = process.env): Address | null {
  const config = getChainConfig(parseAppEnv(appEnv));
  if (config.appEnv === "local") {
    const local = env.LOCAL_EMERGENCY_POOL_ADDRESS;
    return local && isAddress(local) ? getAddress(local) : null;
  }
  return config.contracts?.emergencyPool?.address ?? null;
}

/**
 * Records that an admin sent `createSubPool(poolId)` (audit_log `pool.subpool_create.sent`).
 * Only for a seeded theme (pool > 0); false for anything else. The chain itself
 * refuses non-operators and duplicates.
 */
export async function recordSubpoolSent(
  db: Database, adminId: string, input: { poolId: number; txHash: string }, ip?: string
): Promise<boolean> {
  if (input.poolId <= 0) return false;
  const [row] = await db
    .select({ id: emergencySubpools.id, slug: emergencySubpools.slug })
    .from(emergencySubpools)
    .where(eq(emergencySubpools.poolId, input.poolId));
  if (!row) return false;
  await db.insert(auditLog).values({
    actorUserId: adminId, action: "pool.subpool_create.sent", entityType: "emergency_subpool", entityId: row.id,
    data: { poolId: input.poolId, slug: row.slug, txHash: input.txHash.toLowerCase() }, ip,
  });
  return true;
}
