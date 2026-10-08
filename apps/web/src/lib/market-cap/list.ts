import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@cherrio/db";
import { ORGANIZATION_CAUSES, type OrganizationCause } from "@cherrio/shared/organizations";
import { TRUST_SCORE_VERSION } from "@cherrio/shared/trust";

// Charity Market Cap list (TASK-017b, ADR-059). Reads the worker's current
// Trust Score rows (one per organisation and version, `listed` only) and pages
// with a keyset cursor: the page after "score 61.00, org X, 25 shown" is
// (score, org_id) < (61.00, X), read backwards from a one-direction index, so a
// deep page costs the same as the first one on ~1 M organisations. The cursor
// also carries how many rows came before, which is the "#" of the next row.

export const MARKET_CAP_SORTS = ["score", "raised", "name"] as const;
export type MarketCapSort = (typeof MARKET_CAP_SORTS)[number];
export const MARKET_CAP_ON = ["cherrio", "other"] as const;
export type MarketCapOn = (typeof MARKET_CAP_ON)[number];
export const MARKET_CAP_PAGE = 25;

export interface MarketCapQuery {
  sort: MarketCapSort;
  country?: string;
  cause?: OrganizationCause;
  on?: MarketCapOn;
  q?: string;
  /** Opaque cursor from the previous page (`next`). */
  after?: string;
}

export interface MarketCapRow {
  orgId: string;
  position: number;
  name: string;
  country: string | null;
  causes: string[];
  score: string;
  /** USDC, 6 decimals. */
  raised: bigint;
  registered: boolean;
}

interface Cursor {
  value: string;
  id: string;
  shown: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.value, c.id, c.shown])).toString("base64url");
}

/** A cursor from the URL, or null when it is not one we made for this order. */
export function decodeCursor(raw: string | undefined, sort: MarketCapSort): Cursor | null {
  if (!raw || raw.length > 600) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [value, id, shown] = parsed as unknown[];
    if (typeof value !== "string" || typeof id !== "string" || !UUID.test(id)) return null;
    if (typeof shown !== "number" || !Number.isSafeInteger(shown) || shown < 0) return null;
    if (sort === "score" && !/^\d{1,3}(\.\d{1,2})?$/.test(value)) return null;
    if (sort === "raised" && !/^\d{1,78}$/.test(value)) return null;
    if (sort === "name" && value.length > 300) return null;
    return { value, id, shown };
  } catch {
    return null;
  }
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

/** The list state from the URL; unknown values are dropped. */
export function parseMarketCapQuery(params: Record<string, string | string[] | undefined>): MarketCapQuery {
  const sort = first(params.sort);
  const country = first(params.country)?.toUpperCase();
  const cause = first(params.cause);
  const on = first(params.on);
  const q = first(params.q)?.slice(0, 100);
  return {
    sort: (MARKET_CAP_SORTS as readonly string[]).includes(sort ?? "") ? (sort as MarketCapSort) : "score",
    country: country && /^[A-Z]{2}$/.test(country) ? country : undefined,
    cause: (ORGANIZATION_CAUSES as readonly string[]).includes(cause ?? "") ? (cause as OrganizationCause) : undefined,
    on: (MARKET_CAP_ON as readonly string[]).includes(on ?? "") ? (on as MarketCapOn) : undefined,
    q: q || undefined,
    after: first(params.after),
  };
}

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listMarketCap(
  db: Database,
  query: MarketCapQuery,
  limit = MARKET_CAP_PAGE,
  /** Below this many rows a filter is narrowed first (tests set it to 0 or Infinity). */
  rare = RARE
): Promise<{ rows: MarketCapRow[]; next: string | null }> {
  const conditions: { sql: SQL; size: (f: MarketCapFacets) => number }[] = [];
  if (query.country) {
    const country = query.country;
    conditions.push({ sql: sql`country = ${country}`, size: (f) => f.countries.find((c) => c.value === country)?.count ?? 0 });
  }
  if (query.cause) {
    const cause = query.cause;
    conditions.push({ sql: sql`causes @> array[${cause}]::text[]`, size: (f) => f.causes.find((c) => c.value === cause)?.count ?? 0 });
  }
  if (query.on) {
    const on = query.on === "cherrio";
    conditions.push({ sql: sql`registered = ${on}`, size: (f) => (on ? f.registered : f.listed - f.registered) });
  }
  const where: SQL[] = [sql`t.version = ${TRUST_SCORE_VERSION}`, sql`t.listed`, ...conditions.map((c) => sql`t.${c.sql}`)];
  if (query.q) where.push(sql`o.name ilike ${likePattern(query.q)}`);

  // A filter that keeps few organisations (a small country, a rare cause, the few
  // on CHERR.IO): walking an order index for it would read most of the index to
  // fill a page, and the planner cannot tell how rare the value is. Those rows are
  // taken from the filter's own index first and sorted (at most RARE of them).
  let prefix = sql``;
  if (conditions.length > 0) {
    const facets = await marketCapFacets(db);
    const smallest = conditions.reduce((a, b) => (b.size(facets) < a.size(facets) ? b : a));
    if (smallest.size(facets) < rare) {
      prefix = sql`with narrowed as materialized (
        select org_id from app.trust_scores where version = ${TRUST_SCORE_VERSION} and listed and ${smallest.sql}
      ) `;
      where.push(sql`t.org_id in (select org_id from narrowed)`);
    }
  }

  const cursor = decodeCursor(query.after, query.sort);
  let order: SQL;
  if (query.sort === "name") {
    if (cursor) where.push(sql`(o.name, o.id) > (${cursor.value}, ${cursor.id}::uuid)`);
    order = sql`o.name asc, o.id asc`;
  } else if (query.sort === "raised") {
    if (cursor) where.push(sql`(t.raised, t.org_id) < (${cursor.value}::numeric, ${cursor.id}::uuid)`);
    order = sql`t.raised desc, t.org_id desc`;
  } else {
    if (cursor) where.push(sql`(t.score, t.org_id) < (${cursor.value}::numeric, ${cursor.id}::uuid)`);
    order = sql`t.score desc, t.org_id desc`;
  }

  const rows = (await db.execute(sql`
    ${prefix}select t.org_id, o.name, t.country, t.causes, t.score::text as score, t.raised::text as raised, t.registered
    from app.trust_scores t join app.organizations o on o.id = t.org_id
    where ${sql.join(where, sql` and `)}
    order by ${order}
    limit ${limit + 1}
  `)) as unknown as {
    org_id: string;
    name: string;
    country: string | null;
    causes: string[];
    score: string;
    raised: string;
    registered: boolean;
  }[];

  const shown = cursor?.shown ?? 0;
  const page = rows.slice(0, limit).map((r, i) => ({
    orgId: r.org_id,
    position: shown + i + 1,
    name: r.name,
    country: r.country?.trim() || null,
    causes: r.causes,
    score: r.score,
    raised: BigInt(r.raised),
    registered: r.registered,
  }));
  const last = page.at(-1);
  const next =
    rows.length > limit && last
      ? encodeCursor({
          value: query.sort === "name" ? last.name : query.sort === "raised" ? last.raised.toString() : last.score,
          id: last.orgId,
          shown: shown + page.length,
        })
      : null;
  return { rows: page, next };
}

// How many listed organisations each country and cause has, and how many are on
// CHERR.IO: three passes over the listed rows (~1 s on 1 M), kept for 10 minutes and
// refreshed in the background after that (the counts move with imports and KYB).
const RARE = 20_000;
const FACETS_TTL = 10 * 60_000;

export interface MarketCapFacets {
  countries: { value: string; count: number }[];
  causes: { value: OrganizationCause; count: number }[];
  registered: number;
  listed: number;
}

let facetCache: { at: number; facets: MarketCapFacets } | null = null;
let facetLoad: Promise<MarketCapFacets> | null = null;

async function loadFacets(db: Database): Promise<MarketCapFacets> {
  const rows = (await db.execute(sql`
    select 'country' as kind, country::text as key, count(*)::int as n
      from app.trust_scores where version = ${TRUST_SCORE_VERSION} and listed and country is not null group by country
    union all
    select 'cause', c, count(*)::int from app.trust_scores t, unnest(t.causes) c
      where t.version = ${TRUST_SCORE_VERSION} and t.listed group by c
    union all
    select 'registered', registered::text, count(*)::int from app.trust_scores
      where version = ${TRUST_SCORE_VERSION} and listed group by registered
  `)) as unknown as { kind: string; key: string; n: number }[];
  const known = new Set<string>(ORGANIZATION_CAUSES);
  const facets: MarketCapFacets = { countries: [], causes: [], registered: 0, listed: 0 };
  for (const r of rows) {
    const n = Number(r.n);
    if (r.kind === "country") facets.countries.push({ value: r.key.trim(), count: n });
    else if (r.kind === "cause" && known.has(r.key)) facets.causes.push({ value: r.key as OrganizationCause, count: n });
    else if (r.kind === "registered") {
      facets.listed += n;
      if (r.key === "true") facets.registered = n;
    }
  }
  facetCache = { at: Date.now(), facets };
  return facets;
}

export async function marketCapFacets(db: Database): Promise<MarketCapFacets> {
  if (facetCache && Date.now() - facetCache.at < FACETS_TTL) return facetCache.facets;
  facetLoad ??= loadFacets(db).finally(() => (facetLoad = null));
  // Stale counts are good enough while fresh ones load; only the very first request waits.
  if (facetCache) {
    facetLoad.catch(() => undefined);
    return facetCache.facets;
  }
  return facetLoad;
}

/** Test hook: forget the cached counts. */
export function resetMarketCapFacets(): void {
  facetCache = null;
}

/** The top of the ranking for the landing page. */
export async function topOfMarketCap(db: Database, n = 5): Promise<MarketCapRow[]> {
  return (await listMarketCap(db, { sort: "score" }, n)).rows;
}
