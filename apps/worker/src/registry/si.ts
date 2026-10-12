import type { Database } from "@cherrio/db";
import { sql } from "drizzle-orm";
import type { OrganizationCause } from "@cherrio/shared/organizations";
import { emptyResult, lastImport, markImported, writeRegistryBatch, type ImportResult, type RegistryEntry } from "./common.js";

// Slovenian registry import (TASK-016c, ADR-062; David 2026-10-12):
// AJPES publishes the Evidenca nevladnih organizacij v javnem interesu (ENO) —
// every NGO a ministry has granted public-interest status — monthly as XML
// (ZNOrg Art. 22(5): free and unlimited re-use). Political parties, churches,
// trade unions and chambers cannot be NGOs (ZNOrg Art. 2), so they are never in it.
//
// Only the public-interest *field* the state granted decides, never the name or
// the activity code:
//   ACCEPT  — a valid status in an accepted field → imported organisation;
//   REVIEW  — accepted, but either the only accepted field is disaster
//             protection and the name is not a fire/rescue/Red Cross body
//             (radio, scout, caving, flying, alpine clubs…), or the organisation
//             also holds a status in an excluded field (sport, culture…) →
//             kept as a record for a manual review, not shown;
//   EXCLUDE — no accepted field (sport, culture, agriculture, veterans…);
//   REMOVED — deleted from ENO, every status withdrawn, or missing from the
//             newest extract. An earlier imported organisation is then taken
//             off the Charity Market Cap (trust score `listed` = false).
// registry_records.raw.status carries the decision ("Registered" for ACCEPT),
// which is what the trust score reads.

/** Raise when the rules change: the worker then imports again at once. */
export const SI_PARSER_VERSION = 1;

const SI = { registry: "SI_AJPES", country: "SI" } as const;

/** The monthly extract for a month (1–12). */
export const enoUrl = (year: number, month: number) =>
  `https://www.ajpes.si/Doc/Registri/Drugi_registri/ENO/ENO_${year}_${String(month).padStart(2, "0")}.xml`;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Accepted public-interest fields (exact ENO names, whitespace-normalised) → our causes. */
export const SI_ACCEPTED_FIELDS: Readonly<Record<string, OrganizationCause[]>> = {
  "Socialno varstvo": ["poverty"],
  "Zdravstveno varstvo": ["medical"],
  "Invalidsko varstvo": ["medical"],
  "Družina": ["children"],
  "Mladinski sektor": ["children"],
  "Izobraževanje - vzgoja in izobraževanje": ["education"],
  "Varstvo pred diskriminacijo ali varstvo človekovih pravic": ["humanitarian"],
  "Enake možnosti žensk in moških": ["humanitarian"],
  "Mednarodno razvojno sodelovanje in humanitarna pomoč": ["humanitarian"],
  "Žrtve vojnega nasilja": ["humanitarian"],
  "Vojni invalidi": ["medical"],
  "Okolje": ["climate"],
  "Narava": ["climate"],
  "Kmetijstvo, gozdarstvo in prehrana - varstvo in zaščita živali": ["animals"],
  "Varstvo pred naravnimi in drugimi nesrečami": ["disasters"],
};

/** "Humanitarna dejavnost - …": every sub-field is accepted (former humanitarian-organisation status). */
const HUMANITARIAN = "Humanitarna dejavnost";
export const DISASTER_FIELD = "Varstvo pred naravnimi in drugimi nesrečami";
/** In the disaster field only these are accepted without a review. */
const RESCUE_NAME = /GASILS|RE[ŠS]EVAL|RDE[ČC]\p{L}* KRI[ŽZ]|\bGRS\b|PO[ŽZ]ARN/iu;

/** Causes of an accepted field, or null when the field is not accepted. */
export function fieldCauses(field: string): OrganizationCause[] | null {
  const f = norm(field);
  if (f.startsWith(HUMANITARIAN)) return /zdravstven/i.test(f) ? ["medical"] : ["poverty"];
  return SI_ACCEPTED_FIELDS[f] ?? null;
}

export interface EnoStatus {
  field: string;
  grantedOn: string | null;
  withdrawnOn: string | null;
}
export interface EnoOrganisation {
  registrationNumber: string;
  taxNumber: string | null;
  name: string;
  seat: string | null;
  municipality: string | null;
  legalForm: string | null;
  ministry: string | null;
  deletedOn: string | null;
  statuses: EnoStatus[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()]!,
  );
const tag = (block: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block);
  return m ? norm(decode(m[1]!)) || null : null;
};
const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/**
 * The organisations of an ENO extract. The file has a fixed, flat structure
 * (no attributes, no CDATA), so a small scanner is enough — no XML dependency.
 */
export function* enoOrganisations(xml: string): Generator<EnoOrganisation> {
  const orgRe = /<NevladnaOrganizacija>([\s\S]*?)<\/NevladnaOrganizacija>/g;
  for (let m = orgRe.exec(xml); m; m = orgRe.exec(xml)) {
    const block = m[1]!;
    const registrationNumber = tag(block, "Maticna");
    const name = tag(block, "NazivOrganizacije");
    if (!registrationNumber || !/^\d{7,10}$/.test(registrationNumber) || !name) continue;
    const statuses: EnoStatus[] = [];
    const statusRe = /<Status>([\s\S]*?)<\/Status>/g;
    for (let s = statusRe.exec(block); s; s = statusRe.exec(block)) {
      const field = tag(s[1]!, "NazivPodrocjaInPodpodrocjaJI");
      if (field) statuses.push({ field, grantedOn: day(tag(s[1]!, "DatumPodelitveStatusaJI")), withdrawnOn: day(tag(s[1]!, "DatumOdvzemaStatusaJI")) });
    }
    yield {
      registrationNumber,
      taxNumber: tag(block, "Davcna"),
      name,
      seat: tag(block, "Sedez"),
      municipality: tag(block, "Obcina"),
      legalForm: tag(block, "PravnoorganizacijskaOblika"),
      ministry: tag(block, "NazivMinistrstva"),
      deletedOn: day(tag(block, "DatumIzbrisaIzEvidenco")),
      statuses,
    };
  }
}

export type SiDecision = "ACCEPT" | "REVIEW" | "EXCLUDE" | "REMOVED";
export interface SiClassification {
  decision: SiDecision;
  reason: string | null;
  /** Fields with a status in force on `today`. */
  fields: string[];
  causes: OrganizationCause[];
}

/** The decision for one organisation (`today` as YYYY-MM-DD: a withdrawal on or before it counts). */
export function classifySi(org: EnoOrganisation, today: string): SiClassification {
  if (org.deletedOn && org.deletedOn <= today) return { decision: "REMOVED", reason: "deleted-from-eno", fields: [], causes: [] };
  const fields = [...new Set(org.statuses.filter((s) => !s.withdrawnOn || s.withdrawnOn > today).map((s) => norm(s.field)))].sort();
  if (fields.length === 0) return { decision: "REMOVED", reason: "status-withdrawn", fields, causes: [] };
  const accepted = fields.filter((f) => fieldCauses(f) !== null);
  if (accepted.length === 0) return { decision: "EXCLUDE", reason: null, fields, causes: [] };
  const causes = [...new Set(accepted.flatMap((f) => fieldCauses(f)!))].sort();
  if (accepted.length === 1 && accepted[0] === DISASTER_FIELD && !RESCUE_NAME.test(org.name)) {
    return { decision: "REVIEW", reason: "disaster-field-not-rescue", fields, causes };
  }
  if (accepted.length < fields.length) return { decision: "REVIEW", reason: "also-excluded-field", fields, causes };
  return { decision: "ACCEPT", reason: null, fields, causes };
}

const SMALL = new Set(["in", "za", "na", "v", "z", "s", "pri", "ob", "od", "do", "iz", "po", "k", "ter", "pod", "nad", "med", "brez"]);
/** "DRUŠTVO ZA POMOČ OSEBAM Z MOTNJAMI" → "Društvo za Pomoč Osebam z Motnjami": title case like the UK import (proper names such as "Škofja Loka" stay right), carons included. */
export function titleCaseSl(name: string): string {
  if (/\p{Ll}/u.test(name)) return norm(name); // already mixed case
  return norm(name)
    .split(" ")
    .map((w, i) => {
      const lower = w.toLocaleLowerCase("sl");
      if (i > 0 && SMALL.has(lower)) return lower;
      if (/^(RS|SLO|ZPM|KUD|PGD|GRS|ŠOU|NVO|AIDS|HIV|ADHD|IV|II|III|EU|ZDUS|YMCA)[.,]?$/u.test(w)) return w;
      return lower.replace(/(^|[-/("'„])(\p{Ll})/gu, (_, p: string, c: string) => p + c.toLocaleUpperCase("sl"));
    })
    .join(" ");
}

const RAW_STATUS: Record<SiDecision, string> = { ACCEPT: "Registered", REVIEW: "Review", EXCLUDE: "Excluded", REMOVED: "Removed" };

/** One ENO organisation → a registry entry (no street address is kept). */
export function siEntry(org: EnoOrganisation, today: string, extract: string): RegistryEntry & { decision: SiDecision } {
  const c = classifySi(org, today);
  const name = titleCaseSl(org.name);
  const granted = org.statuses.filter((s) => c.fields.includes(norm(s.field)) && s.grantedOn).map((s) => s.grantedOn!).sort();
  return {
    registryId: org.registrationNumber,
    active: c.decision === "ACCEPT",
    decision: c.decision,
    name,
    website: null,
    description: null,
    causes: c.causes,
    raw: {
      name,
      status: RAW_STATUS[c.decision],
      reason: c.reason,
      publicInterestFields: c.fields.join(" | ") || null,
      publicInterestSince: granted[0] ?? null,
      taxNumber: org.taxNumber,
      legalForm: org.legalForm,
      seat: org.seat,
      municipality: org.municipality,
      ministry: org.ministry,
      removedOn: org.deletedOn,
      extract,
    },
  };
}

export type SiImportResult = ImportResult & { decisions: Record<SiDecision, number>; missing: number; extract: string };

const BATCH = 500;
/** An extract with fewer organisations is treated as broken: nothing is imported or removed (6,322 in 2026-09). */
export const SI_MIN_ORGANISATIONS = 3000;

/** Imports one ENO extract (the XML text). `extract` names it, e.g. "2026-09". */
export async function importSiFromXml(
  db: Database,
  xml: string,
  extract: string,
  opts: { today?: string; minOrganisations?: number } = {},
): Promise<SiImportResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const orgs = [...enoOrganisations(xml)];
  const min = opts.minOrganisations ?? SI_MIN_ORGANISATIONS;
  if (orgs.length < min) throw new Error(`ENO extract ${extract} has ${orgs.length} organisations (expected at least ${min}) — not imported`);
  const result: SiImportResult = { ...emptyResult(), decisions: { ACCEPT: 0, REVIEW: 0, EXCLUDE: 0, REMOVED: 0 }, missing: 0, extract };
  const seen: string[] = [];
  let batch: RegistryEntry[] = [];
  for (const org of orgs) {
    const { decision, ...entry } = siEntry(org, today, extract);
    result.decisions[decision]++;
    seen.push(entry.registryId);
    batch.push(entry);
    if (batch.length >= BATCH) {
      await writeRegistryBatch(db, SI, batch, result);
      batch = [];
    }
  }
  if (batch.length > 0) await writeRegistryBatch(db, SI, batch, result);
  // Organisations that left ENO since the last extract: off the Market Cap.
  const missing = (await db.execute(sql`
    update app.registry_records
    set raw = raw || jsonb_build_object('status', 'Removed', 'reason', 'not-in-extract', 'extract', ${extract}::text), updated_at = now()
    where registry = 'SI_AJPES' and raw->>'status' is distinct from 'Removed'
      and registry_id <> all (array(select jsonb_array_elements_text(${JSON.stringify(seen)}::jsonb)))
    returning registry_id
  `)) as unknown as unknown[];
  result.missing = missing.length;
  await markImported(db, "SI_AJPES", result, SI_PARSER_VERSION);
  return result;
}

/** The newest extract: last month's, or the month before when it is not published yet. */
export async function downloadEno(now = new Date(), url = enoUrl): Promise<{ xml: string; extract: string }> {
  let lastStatus = 0;
  for (const back of [1, 2]) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const res = await fetch(url(d.getUTCFullYear(), d.getUTCMonth() + 1), { signal: AbortSignal.timeout(5 * 60_000) });
    if (res.ok) {
      const xml = await res.text();
      if (xml.includes("<NevladneOrganizacije")) return { xml, extract: d.toISOString().slice(0, 7) };
      throw new Error("ENO download is not an ENO extract");
    }
    lastStatus = res.status;
    await res.text().catch(() => "");
  }
  throw new Error(`ENO download failed: ${lastStatus}`);
}

/** Downloads the newest ENO extract and imports it. */
export async function importSi(db: Database, now = new Date(), url = enoUrl): Promise<SiImportResult> {
  const { xml, extract } = await downloadEno(now, url);
  return importSiFromXml(db, xml, extract);
}

export const lastSiImport = (db: Database) => lastImport(db, "SI_AJPES", SI_PARSER_VERSION);
