import { sql } from "drizzle-orm";
import type { Database } from "@cherrio/db";
import { TRUST_SCORE_VERSION } from "@cherrio/shared/trust";

// Organisation profile on the Charity Market Cap (TASK-017c, ADR-059): the
// public facts of one listed organisation, its current Trust Score with the
// parts it is made of, and what its register says. Not listed (in review,
// rejected, demo, removed from its register, no score yet) → null, a 404.

export interface MarketCapProfile {
  id: string;
  name: string;
  country: string;
  causes: string[];
  website: string | null;
  description: string | null;
  /** Verified on CHERR.IO (KYB approved). */
  registered: boolean;
  /** An imported organisation nobody has claimed (a rejected claim puts it back to NONE). */
  claimable: boolean;
  registry: string;
  registryId: string | null;
  score: string;
  components: Record<string, unknown>;
  /** USDC, 6 decimals, raised on CHERR.IO. */
  raised: bigint;
  computedAt: Date;
  /** What we keep from the register (never contact details), or null. */
  registryRecord: Record<string, unknown> | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getMarketCapProfile(db: Database, id: string): Promise<MarketCapProfile | null> {
  if (!UUID.test(id)) return null;
  const [row] = (await db.execute(sql`
    select o.id, o.name, o.country, o.causes, o.website, o.description, o.source, o.kyb_status, o.claimed_by_user_id,
           o.registry, o.registry_id, t.score::text as score, t.components, t.raised::text as raised, t.registered, t.computed_at,
           r.raw
    from app.organizations o
    join app.trust_scores t on t.org_id = o.id and t.version = ${TRUST_SCORE_VERSION} and t.listed
    left join app.registry_records r on r.registry = o.registry and r.registry_id = o.registry_id
    where o.id = ${id}::uuid and not o.is_demo
  `)) as unknown as {
    id: string;
    name: string;
    country: string;
    causes: string[];
    website: string | null;
    description: string | null;
    source: string;
    kyb_status: string;
    claimed_by_user_id: string | null;
    registry: string;
    registry_id: string | null;
    score: string;
    components: Record<string, unknown>;
    raised: string;
    registered: boolean;
    computed_at: Date | string;
    raw: Record<string, unknown> | null;
  }[];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    country: row.country.trim(),
    causes: row.causes,
    website: row.website,
    description: row.description,
    registered: row.registered,
    claimable: row.source === "IMPORTED" && row.claimed_by_user_id === null && row.kyb_status === "NONE",
    registry: row.registry,
    registryId: row.registry_id,
    score: row.score,
    components: row.components ?? {},
    raised: BigInt(row.raised),
    computedAt: new Date(row.computed_at),
    registryRecord: row.raw,
  };
}

/** An imported organisation that can be claimed: the prefill of the KYB form. */
export async function getClaimableOrganization(db: Database, id: string) {
  if (!UUID.test(id)) return null;
  const [row] = (await db.execute(sql`
    select id, name, country, registry, registry_id, website, description, causes
    from app.organizations
    where id = ${id}::uuid and source = 'IMPORTED' and claimed_by_user_id is null and kyb_status = 'NONE' and not is_demo
  `)) as unknown as {
    id: string;
    name: string;
    country: string;
    registry: string;
    registry_id: string | null;
    website: string | null;
    description: string | null;
    causes: string[];
  }[];
  return row ? { ...row, country: row.country.trim() } : null;
}
