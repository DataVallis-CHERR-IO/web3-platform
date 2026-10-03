import { sql } from "drizzle-orm";
import { fxRates, type Database } from "@cherrio/db";
import { RATE_SCALE, parseScaled18 } from "@cherrio/shared";
import { fetchCryptoRates, fetchEcbRates, type SourceRate } from "./sources";

// Display-only exchange rates (ADR-040), kept in app.fx_rates and refreshed
// lazily: when a page needs rates and the last fetch of a source is old, the
// fetch runs after the response (pages never wait), except on the very first
// use when the table is empty. Failures are logged and old values stay.

export type FxSource = "ECB" | "COINGECKO";

export interface DisplayRate {
  /** USD per one unit × 10^18. */
  usdPerUnit18: bigint;
  source: FxSource | "FIXED";
  rateAt: Date;
}

export const FX_POLICY = {
  /** How often a source is fetched at most. */
  refreshMs: { ECB: 60 * 60_000, COINGECKO: 5 * 60_000 } as Record<FxSource, number>,
  /** After a failed fetch, wait this long before the next try (per container). */
  retryMs: 60_000,
  /** A fiat rate is used while its ECB date is at most this old (holidays included). */
  fiatMaxAgeMs: 7 * 24 * 60 * 60_000,
  /** A crypto price is used while its fetch is at most this old. */
  cryptoMaxAgeMs: 60 * 60_000,
  /** Rows read from the DB are reused for this long within one container. */
  memoryMs: 30_000,
};

export interface FxDeps {
  fetchEcb: () => Promise<SourceRate[]>;
  fetchCrypto: () => Promise<SourceRate[]>;
  now: () => Date;
  /** Runs work after the response (Next.js `after`); tests run it at once. */
  schedule: (work: () => Promise<void>) => void;
}

const defaultDeps: FxDeps = {
  fetchEcb: () => fetchEcbRates(),
  fetchCrypto: () => fetchCryptoRates(),
  now: () => new Date(),
  schedule: (work) => void work(),
};

type Row = { currency: string; usdPerUnit: string; source: string; rateAt: Date; fetchedAt: Date };

let memory: { at: number; rows: Row[] } | null = null;
const lastAttempt: Record<FxSource, number> = { ECB: 0, COINGECKO: 0 };
const running = new Set<FxSource>();

/** For tests: forget the in-memory copy and the retry timers. */
export function resetFxMemory() {
  memory = null;
  lastAttempt.ECB = 0;
  lastAttempt.COINGECKO = 0;
  running.clear();
}

async function readRows(db: Database): Promise<Row[]> {
  return db
    .select({
      currency: fxRates.currency,
      usdPerUnit: fxRates.usdPerUnit,
      source: fxRates.source,
      rateAt: fxRates.rateAt,
      fetchedAt: fxRates.fetchedAt,
    })
    .from(fxRates);
}

/** Fetches one source and stores its rates. Never throws (logged). */
export async function refreshSource(db: Database, source: FxSource, deps: FxDeps = defaultDeps): Promise<boolean> {
  if (running.has(source)) return false;
  running.add(source);
  lastAttempt[source] = deps.now().getTime();
  try {
    const rates = await (source === "ECB" ? deps.fetchEcb() : deps.fetchCrypto());
    if (rates.length === 0) return false;
    const fetchedAt = deps.now();
    await db
      .insert(fxRates)
      .values(
        rates.map((r) => ({
          currency: r.currency,
          usdPerUnit: formatScaled18(r.usdPerUnit18),
          source,
          rateAt: r.rateAt,
          fetchedAt,
        }))
      )
      .onConflictDoUpdate({
        target: fxRates.currency,
        set: {
          usdPerUnit: sql`excluded.usd_per_unit`,
          source: sql`excluded.source`,
          rateAt: sql`excluded.rate_at`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
    memory = null;
    return true;
  } catch (error) {
    // Message only: an error object could carry request details.
    console.error(`[fx] ${source} refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    running.delete(source);
  }
}

function formatScaled18(value: bigint): string {
  const whole = value / RATE_SCALE;
  const fraction = (value % RATE_SCALE).toString().padStart(18, "0");
  return `${whole}.${fraction}`;
}

function due(rows: Row[], source: FxSource, now: number): boolean {
  const newest = rows.filter((r) => r.source === source).reduce((max, r) => Math.max(max, r.fetchedAt.getTime()), 0);
  return now - newest > FX_POLICY.refreshMs[source] && now - lastAttempt[source] > FX_POLICY.retryMs;
}

/** The rates that may be shown now, by currency code. USD and USDC are always 1 USD. */
export function usableRates(rows: Row[], now: Date): Map<string, DisplayRate> {
  const result = new Map<string, DisplayRate>([
    ["USD", { usdPerUnit18: RATE_SCALE, source: "FIXED", rateAt: now }],
    ["USDC", { usdPerUnit18: RATE_SCALE, source: "FIXED", rateAt: now }],
  ]);
  for (const row of rows) {
    if (result.has(row.currency)) continue;
    const fresh =
      row.source === "ECB"
        ? now.getTime() - row.rateAt.getTime() <= FX_POLICY.fiatMaxAgeMs
        : now.getTime() - row.fetchedAt.getTime() <= FX_POLICY.cryptoMaxAgeMs;
    const value = parseScaled18(row.usdPerUnit);
    if (fresh && value !== null) result.set(row.currency, { usdPerUnit18: value, source: row.source as FxSource, rateAt: row.rateAt });
  }
  return result;
}

/** Rates for display. Starts a refresh of old sources (after the response, or at once when nothing is stored yet). */
export async function getDisplayRates(db: Database, deps: FxDeps = defaultDeps): Promise<Map<string, DisplayRate>> {
  const now = deps.now();
  let rows: Row[];
  if (memory && now.getTime() - memory.at < FX_POLICY.memoryMs) rows = memory.rows;
  else {
    rows = await readRows(db);
    // An empty table is not kept: the next request reads again.
    memory = rows.length > 0 ? { at: now.getTime(), rows } : null;
  }

  const stale = (["ECB", "COINGECKO"] as const).filter((source) => due(rows, source, now.getTime()));
  if (stale.length > 0) {
    if (rows.length === 0) {
      // First use: wait for the fetches (each has a 5 s timeout).
      await Promise.all(stale.map((source) => refreshSource(db, source, deps)));
      rows = await readRows(db);
      memory = rows.length > 0 ? { at: now.getTime(), rows } : null;
    } else {
      deps.schedule(async () => {
        for (const source of stale) await refreshSource(db, source, deps);
      });
    }
  }
  return usableRates(rows, now);
}
