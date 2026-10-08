import { sql } from "drizzle-orm";
import type { Database } from "@cherrio/db";
import type { OrganizationCause } from "@cherrio/shared/organizations";

// Shared by the registry imports (TASK-016): one batch of entries goes to
// app.registry_records (all) and app.organizations (the active ones, source
// IMPORTED). A claimed organisation (source REGISTERED after KYB) is never
// changed; an imported one only when its data changed.

export interface RegistryEntry {
  registryId: string;
  /** Becomes (or stays) an imported organisation. */
  active: boolean;
  name: string;
  website: string | null;
  description: string | null;
  causes: OrganizationCause[];
  /** Kept in registry_records.raw — never contact details. */
  raw: Record<string, string | number | boolean | null>;
}

export interface ImportResult {
  records: number;
  organizations: { inserted: number; updated: number };
  skipped: number;
}

export const emptyResult = (): ImportResult => ({ records: 0, organizations: { inserted: 0, updated: 0 }, skipped: 0 });

export type RegistrySource = { registry: "UK_CC" | "US_IRS"; country: string };

export async function writeRegistryBatch(db: Database, source: RegistrySource, entries: RegistryEntry[], result: ImportResult): Promise<void> {
  // One row per registry id in a statement (an upsert cannot touch a row twice); the last one wins.
  const batch = [...new Map(entries.map((e) => [e.registryId, e])).values()];
  const records = JSON.stringify(batch.map((c) => ({ registry_id: c.registryId, raw: c.raw })));
  await db.execute(sql`
    insert into app.registry_records (id, registry, registry_id, raw, fetched_at)
    select gen_random_uuid(), ${source.registry}::app.registry_type, r.registry_id, r.raw, now()
    from jsonb_to_recordset(${records}::jsonb) as r(registry_id text, raw jsonb)
    on conflict (registry, registry_id) do update set raw = excluded.raw, fetched_at = now(), updated_at = now()
      -- Unchanged rows are not rewritten: a monthly run would otherwise double the table until vacuum.
      where app.registry_records.raw is distinct from excluded.raw
  `);
  result.records += batch.length;
  const orgs = batch.filter((c) => c.active);
  if (orgs.length === 0) return;
  const rows = JSON.stringify(orgs.map((c) => ({ registry_id: c.registryId, name: c.name, website: c.website, description: c.description, causes: c.causes })));
  const changed = (await db.execute(sql`
    insert into app.organizations (id, source, name, country, registry, registry_id, website, description, causes, kyb_status)
    select gen_random_uuid(), 'IMPORTED', r.name, ${source.country}, ${source.registry}::app.registry_type, r.registry_id, r.website, r.description,
           array(select jsonb_array_elements_text(r.causes)), 'NONE'
    from jsonb_to_recordset(${rows}::jsonb) as r(registry_id text, name text, website text, description text, causes jsonb)
    on conflict (registry, registry_id) do update
      set name = excluded.name, website = excluded.website, description = excluded.description, causes = excluded.causes, updated_at = now()
      where app.organizations.source = 'IMPORTED'
        and (app.organizations.name, app.organizations.website, app.organizations.description, app.organizations.causes)
            is distinct from (excluded.name, excluded.website, excluded.description, excluded.causes)
    returning (xmax = 0) as inserted
  `)) as unknown as { inserted: boolean }[];
  for (const r of changed) {
    if (r.inserted) result.organizations.inserted++;
    else result.organizations.updated++;
  }
}

/**
 * Marks a finished import (audit log, action `registry.imported`, with the
 * counts). Unchanged records are not rewritten, so their `fetched_at` cannot
 * say when the last run was.
 */
export async function markImported(db: Database, registry: RegistrySource["registry"], result: ImportResult): Promise<void> {
  await db.execute(sql`
    insert into app.audit_log (id, actor_user_id, action, entity_type, entity_id, data)
    values (gen_random_uuid(), null, 'registry.imported', 'registry', null, ${JSON.stringify({ registry, ...result })}::jsonb)
  `);
}

/** When the last import of a registry finished, or null. */
export async function lastImport(db: Database, registry: RegistrySource["registry"]): Promise<Date | null> {
  const [row] = (await db.execute(sql`
    select max(created_at) as at from app.audit_log
    where entity_type = 'registry' and action = 'registry.imported' and data->>'registry' = ${registry}
  `)) as unknown as { at: Date | string | null }[];
  return row?.at ? new Date(row.at) : null;
}
