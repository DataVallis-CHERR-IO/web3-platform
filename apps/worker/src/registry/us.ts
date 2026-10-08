import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Database } from "@cherrio/db";
import type { OrganizationCause } from "@cherrio/shared/organizations";
import { emptyResult, lastImport, markImported, writeRegistryBatch, type ImportResult, type RegistryEntry } from "./common.js";

// US registry import (TASK-016b, David 2026-10-08: "samo organizacije 501(c)(3)"):
// the IRS Exempt Organizations Business Master File, four regional CSV files.
// Only 501(c)(3) organisations (SUBSECTION 03) that reported revenue on their
// latest return (REVENUE_AMT > 0 — David agreed to "501(c)(3) with revenue";
// US_MIN_REVENUE changes the floor). Street, ZIP and the "in care of" name are
// never kept; city and state are.

export const US_EXTRACT_URLS = [
  "https://www.irs.gov/pub/irs-soi/eo1.csv",
  "https://www.irs.gov/pub/irs-soi/eo2.csv",
  "https://www.irs.gov/pub/irs-soi/eo3.csv",
  "https://www.irs.gov/pub/irs-soi/eo4.csv",
] as const;

const US = { registry: "US_IRS", country: "US" } as const;
const BATCH = 500;

/** One CSV line → fields (double quotes, "" inside quotes). The BMF has no line breaks inside fields. */
export function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** NTEE major group (first letter) → our causes. */
const NTEE: Record<string, OrganizationCause[]> = {
  A: ["community"], B: ["education"], C: ["climate"], D: ["animals"], E: ["medical"], F: ["medical"], G: ["medical"], H: ["medical"],
  I: ["community"], J: ["community"], K: ["poverty"], L: ["poverty"], M: ["disasters"], N: ["community"], O: ["children"],
  P: ["poverty"], Q: ["humanitarian"], R: ["humanitarian"], S: ["community"], T: ["community"], U: ["education"], V: ["education"],
  W: ["community"], X: ["community"],
};

export function causesFromNtee(code: string): OrganizationCause[] {
  return NTEE[(code.trim()[0] ?? "").toUpperCase()] ?? [];
}

const SMALL = new Set(["a", "an", "and", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);
/** "AMERICAN RED CROSS OF THE USA" → "American Red Cross of the USA" (all-caps short words such as USA, YMCA, NY are kept). */
export function titleCase(name: string): string {
  return name
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w, i) => {
      if (i > 0 && SMALL.has(w.toLowerCase())) return w.toLowerCase();
      if (/^(INC|LTD)[.,]?$/.test(w)) return w[0] + w.slice(1).toLowerCase();
      if (/^(USA|UK|YMCA|YWCA|UNICEF|NAACP|LLC|CIO|CIC|NHS|RSPCA|RNLI|PTA|PTFA|UCL)[.,]?$/.test(w)) return w;
      if (/^[A-Z]{2,4}$/.test(w) && !/[AEIOU]/.test(w.slice(1))) return w; // likely an acronym: NY, CTR
      return w.toLowerCase().replace(/(^|[-/(&])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
    })
    .join(" ");
}

const num = (v: string | undefined) => (v && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : null);

/** One BMF row (by header name) → an entry, or null when it is not a 501(c)(3) with enough revenue. */
export function parseUsOrganisation(row: Record<string, string>, minRevenue = 1): RegistryEntry | null {
  const ein = (row.EIN ?? "").trim();
  if (!/^\d{9}$/.test(ein) || (row.SUBSECTION ?? "").trim() !== "03") return null;
  const revenue = num(row.REVENUE_AMT);
  if (revenue === null || revenue < minRevenue) return null;
  const name = titleCase(row.NAME ?? "");
  if (!name) return null;
  const ntee = (row.NTEE_CD ?? "").trim();
  return {
    registryId: ein,
    active: true,
    name,
    website: null,
    description: null,
    causes: causesFromNtee(ntee),
    raw: {
      name,
      city: titleCase(row.CITY ?? "") || null,
      state: (row.STATE ?? "").trim() || null,
      subsection: "03",
      classification: (row.CLASSIFICATION ?? "").trim() || null,
      ruling: (row.RULING ?? "").trim() || null,
      deductibility: (row.DEDUCTIBILITY ?? "").trim() || null,
      foundation: (row.FOUNDATION ?? "").trim() || null,
      status: (row.STATUS ?? "").trim() || null,
      taxPeriod: (row.TAX_PERIOD ?? "").trim() || null,
      assets: num(row.ASSET_AMT),
      income: num(row.INCOME_AMT),
      revenue,
      ntee: ntee || null,
    },
  };
}

/** Rows of one BMF CSV stream as objects keyed by the header. */
export async function* bmfRows(input: Readable): AsyncGenerator<Record<string, string>> {
  let header: string[] | null = null;
  for await (const line of createInterface({ input, crlfDelay: Infinity }) as AsyncIterable<string>) {
    if (!line) continue;
    const fields = csvFields(line);
    if (header === null) {
      header = fields.map((h) => h.replace(/^\uFEFF/, "").trim().toUpperCase());
      continue;
    }
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = fields[i] ?? ""));
    yield row;
  }
}

/** Imports CSV streams (one per regional file), in batches. */
export async function importUsFromStreams(db: Database, streams: AsyncIterable<Readable> | Readable[], minRevenue = 1): Promise<ImportResult> {
  const result = emptyResult();
  let batch: RegistryEntry[] = [];
  for await (const stream of streams) {
    for await (const row of bmfRows(stream)) {
      const entry = parseUsOrganisation(row, minRevenue);
      if (!entry) {
        result.skipped++;
        continue;
      }
      batch.push(entry);
      if (batch.length >= BATCH) {
        await writeRegistryBatch(db, US, batch, result);
        batch = [];
      }
    }
  }
  if (batch.length > 0) await writeRegistryBatch(db, US, batch, result);
  await markImported(db, "US_IRS", result);
  return result;
}

async function* downloads(urls: readonly string[]): AsyncGenerator<Readable> {
  for (const url of urls) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
    yield Readable.fromWeb(res.body as WebReadableStream);
  }
}

/** Streams the four regional files from the IRS and imports them (no temporary files). */
export async function importUs(db: Database, urls: readonly string[] = US_EXTRACT_URLS, minRevenue = 1): Promise<ImportResult> {
  return importUsFromStreams(db, downloads(urls), minRevenue);
}

export const lastUsImport = (db: Database) => lastImport(db, "US_IRS");
