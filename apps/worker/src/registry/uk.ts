import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { sql } from "drizzle-orm";
import type { Database } from "@cherrio/db";
import { ORGANIZATION_CAUSES, type OrganizationCause } from "@cherrio/shared/organizations";
import { openZippedText, tsvRows } from "./tsv.js";

// UK registry import (TASK-016a, ADR-013): the Charity Commission for England
// and Wales publishes its whole register daily (Open Government Licence v3.0).
// We import the main charities (not linked subsidiaries):
//   app.registry_records — every main charity, registered or removed, with a
//     small selection of fields (no phone, e-mail or postal address);
//   app.organizations — the registered ones, source IMPORTED, shown later on
//     the Charity Market Cap as "Not on CHERR.IO" with "Claim this organization".
// An organisation that was claimed (source REGISTERED after KYB) is never
// changed by the import. Re-running is safe: rows only change when the data does.

export const UK_EXTRACT_URLS = {
  charity: "https://ccewuksprdoneregsadata1.blob.core.windows.net/data/txt/publicextract.charity.zip",
  classification: "https://ccewuksprdoneregsadata1.blob.core.windows.net/data/txt/publicextract.charity_classification.zip",
} as const;

/** What the Commission's "What" / "Who" classification says → our causes (by description, robust to code changes). */
const CAUSE_RULES: [RegExp, OrganizationCause][] = [
  [/education|training/i, "education"],
  [/health|saving of lives|disab/i, "medical"],
  [/poverty|accommodation|housing/i, "poverty"],
  [/overseas aid|famine|human rights|equality|diversity|racial harmony/i, "humanitarian"],
  [/animal/i, "animals"],
  [/environment|conservation/i, "climate"],
  [/emergency service|armed forces|disaster/i, "disasters"],
  [/children|young people/i, "children"],
  [/community|economic|employment|arts|culture|heritage|sport|recreation|religio/i, "community"],
];

export function causesFrom(descriptions: string[]): OrganizationCause[] {
  const out = new Set<OrganizationCause>();
  for (const d of descriptions) for (const [re, cause] of CAUSE_RULES) if (re.test(d)) out.add(cause);
  return [...out].sort();
}

const CAUSE_BITS = ORGANIZATION_CAUSES;
const causeMask = (causes: OrganizationCause[]) => causes.reduce((m, c) => m | (1 << CAUSE_BITS.indexOf(c)), 0);
const causesOfMask = (mask: number): OrganizationCause[] => CAUSE_BITS.filter((_, i) => mask & (1 << i)).slice().sort();

/** A website as a URL we can link to, or null. */
export function normaliseWebsite(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return url.hostname.includes(".") ? url.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

const num = (v: string | undefined) => (v && /^-?\d+(\.\d+)?$/.test(v) ? Math.round(Number(v)) : null);
const date = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

export interface UkCharity {
  registryId: string;
  registered: boolean;
  name: string;
  website: string | null;
  description: string | null;
  /** The fields kept in registry_records.raw — no contact details. */
  raw: Record<string, string | number | boolean | null>;
}

/** One row of the charity extract → what we keep; null for linked (subsidiary) charities and bad rows. */
export function parseUkCharity(row: Record<string, string>): UkCharity | null {
  const regno = row.registered_charity_number;
  if (!regno || !/^\d+$/.test(regno)) return null;
  if ((row.linked_charity_number ?? "0") !== "0") return null;
  const name = (row.charity_name ?? "").replace(/\s+/g, " ").trim();
  if (!name) return null;
  const status = row.charity_registration_status ?? "";
  const activities = (row.charity_activities ?? "").replace(/\s+/g, " ").trim();
  return {
    registryId: regno,
    registered: status === "Registered",
    name,
    website: normaliseWebsite(row.charity_contact_web ?? ""),
    description: activities ? activities.slice(0, 1000) : null,
    raw: {
      name,
      status,
      type: row.charity_type || null,
      registeredOn: date(row.date_of_registration),
      removedOn: date(row.date_of_removal),
      reportingStatus: row.charity_reporting_status || null,
      financialYearEnd: date(row.latest_acc_fin_period_end_date),
      income: num(row.latest_income),
      expenditure: num(row.latest_expenditure),
      companyNumber: row.charity_company_registration_number || null,
      insolvent: row.charity_insolvent === "True",
      inAdministration: row.charity_in_administration === "True",
      extractDate: date(row.date_of_extract),
    },
  };
}

export interface ImportResult {
  records: number;
  organizations: { inserted: number; updated: number };
  skipped: number;
}

const BATCH = 500;

/** Writes one batch to registry_records and (registered only) organizations. */
async function writeBatch(db: Database, batch: (UkCharity & { causes: OrganizationCause[] })[], result: ImportResult) {
  const records = JSON.stringify(batch.map((c) => ({ registry_id: c.registryId, raw: c.raw })));
  await db.execute(sql`
    insert into app.registry_records (id, registry, registry_id, raw, fetched_at)
    select gen_random_uuid(), 'UK_CC', r.registry_id, r.raw, now()
    from jsonb_to_recordset(${records}::jsonb) as r(registry_id text, raw jsonb)
    on conflict (registry, registry_id) do update set raw = excluded.raw, fetched_at = now(), updated_at = now()
  `);
  result.records += batch.length;
  const orgs = batch.filter((c) => c.registered);
  if (orgs.length === 0) return;
  const rows = JSON.stringify(orgs.map((c) => ({ registry_id: c.registryId, name: c.name, website: c.website, description: c.description, causes: c.causes })));
  const changed = (await db.execute(sql`
    insert into app.organizations (id, source, name, country, registry, registry_id, website, description, causes, kyb_status)
    select gen_random_uuid(), 'IMPORTED', r.name, 'GB', 'UK_CC', r.registry_id, r.website, r.description,
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

/** Imports from two local zip files (the classification first: it decides the causes). */
export async function importUkFromFiles(db: Database, files: { charity: string; classification: string }): Promise<ImportResult> {
  // Charity number → causes from its "What" and "Who" classifications, as a bit
  // mask per number: ~390,000 entries in a few MB (the worker has 128 MB of heap).
  const classes = new Map<number, number>();
  for await (const row of tsvRows(await openZippedText(files.classification))) {
    if ((row.linked_charity_number ?? "0") !== "0") continue;
    const regno = Number(row.registered_charity_number);
    if (!Number.isSafeInteger(regno) || (row.classification_type !== "What" && row.classification_type !== "Who")) continue;
    const mask = causeMask(causesFrom([row.classification_description ?? ""]));
    if (mask !== 0) classes.set(regno, (classes.get(regno) ?? 0) | mask);
  }
  const result: ImportResult = { records: 0, organizations: { inserted: 0, updated: 0 }, skipped: 0 };
  let batch: (UkCharity & { causes: OrganizationCause[] })[] = [];
  for await (const row of tsvRows(await openZippedText(files.charity))) {
    const c = parseUkCharity(row);
    if (!c) {
      result.skipped++;
      continue;
    }
    batch.push({ ...c, causes: causesOfMask(classes.get(Number(c.registryId)) ?? 0) });
    if (batch.length >= BATCH) {
      await writeBatch(db, batch, result);
      batch = [];
    }
  }
  if (batch.length > 0) await writeBatch(db, batch, result);
  return result;
}

async function download(url: string, path: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(path));
}

/** Downloads today's extract and imports it; the temporary files are removed afterwards. */
export async function importUk(db: Database, urls: { charity: string; classification: string } = UK_EXTRACT_URLS): Promise<ImportResult> {
  const dir = await mkdtemp(join(tmpdir(), "cherrio-uk-"));
  try {
    const files = { charity: join(dir, "charity.zip"), classification: join(dir, "classification.zip") };
    await download(urls.classification, files.classification);
    await download(urls.charity, files.charity);
    return await importUkFromFiles(db, files);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** When the last UK import finished (newest registry record), or null. */
export async function lastUkImport(db: Database): Promise<Date | null> {
  const [row] = (await db.execute(sql`select max(fetched_at) as at from app.registry_records where registry = 'UK_CC'`)) as unknown as {
    at: Date | string | null;
  }[];
  return row?.at ? new Date(row.at) : null;
}
