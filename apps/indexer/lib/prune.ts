import type postgres from "postgres";

// Removes old per-deploy schemas (ADR-026). `ponder db prune` is not used: it drops
// every schema whose instance has stopped, including the previous one we keep for rollback.

export interface PrunePlan {
  /** Schema the `chain` views read from; undefined before the first backfill finishes. */
  live: string | undefined;
  /** Kept besides `live`: the most recently active other schemas, and any still running. */
  kept: string[];
  drop: string[];
}

interface PruneParams {
  sql: postgres.Sql;
  viewsSchema?: string;
  /** How many schemas to keep besides the live one. */
  keepPrevious?: number;
  dryRun?: boolean;
  now?: number;
}

const DEPLOY_SCHEMA = /^chain_[a-z0-9]+$/;
const PROTECTED = new Set(["app", "chain", "ponder_sync", "public"]);
/**
 * An instance that wrote its heartbeat this recently is treated as running.
 * Ponder 0.17 writes it every 10 s and itself calls an instance dead after 25 s.
 */
const RUNNING_WINDOW_MS = 2 * 60 * 1000;

/** The only names prune may ever drop. */
export function isDeploySchema(name: string): boolean {
  return DEPLOY_SCHEMA.test(name) && !PROTECTED.has(name);
}

export async function planPrune(params: PruneParams): Promise<PrunePlan> {
  const { sql } = params;
  const viewsSchema = params.viewsSchema ?? "chain";
  const keepPrevious = params.keepPrevious ?? 1;
  const now = params.now ?? Date.now();

  // Which schema do the views read from? Taken from the view dependencies, not from names.
  const targets = await sql<{ schema: string }[]>`
    select distinct tn.nspname as schema
    from pg_rewrite r
    join pg_class v on v.oid = r.ev_class
    join pg_namespace vn on vn.oid = v.relnamespace
    join pg_depend d on d.objid = r.oid
      and d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass
    join pg_class t on t.oid = d.refobjid
    join pg_namespace tn on tn.oid = t.relnamespace
    where vn.nspname = ${viewsSchema} and tn.nspname <> ${viewsSchema}`;
  if (targets.length > 1) {
    throw new Error(
      `Refusing to prune: "${viewsSchema}" views read from several schemas (${targets
        .map((t) => t.schema)
        .join(", ")})`
    );
  }
  const live = targets[0]?.schema;

  // Candidates: deploy schemas that really are Ponder instances (have _ponder_meta).
  const schemas = await sql<{ schema: string }[]>`
    select table_schema as schema from information_schema.tables
    where table_name = '_ponder_meta' and table_type = 'BASE TABLE' order by 1`;
  const candidates: { schema: string; heartbeat: number }[] = [];
  for (const { schema } of schemas) {
    if (!isDeploySchema(schema) || schema === live) continue;
    const [meta] = await sql<{ heartbeat: string | null }[]>`
      select value->>'heartbeat_at' as heartbeat from ${sql(schema)}._ponder_meta where key = 'app'`;
    candidates.push({ schema, heartbeat: Number(meta?.heartbeat ?? 0) });
  }
  candidates.sort((a, b) => b.heartbeat - a.heartbeat || a.schema.localeCompare(b.schema));

  const kept: string[] = [];
  const drop: string[] = [];
  candidates.forEach((candidate, position) => {
    const running = now - candidate.heartbeat < RUNNING_WINDOW_MS;
    if (position < keepPrevious || running) kept.push(candidate.schema);
    else drop.push(candidate.schema);
  });
  return { live, kept, drop };
}

export async function prune(params: PruneParams): Promise<PrunePlan> {
  const plan = await planPrune(params);
  if (params.dryRun) return plan;
  for (const schema of plan.drop) {
    // Second line of defence: never trust the plan with a destructive statement.
    if (!isDeploySchema(schema) || schema === plan.live) {
      throw new Error(`Refusing to drop schema "${schema}"`);
    }
    await params.sql`drop schema ${params.sql(schema)} cascade`;
  }
  return plan;
}
