import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { TRUST_SCORE_VERSION } from "@cherrio/shared/trust";
import { getDb } from "@/lib/db";
import {
  decodeCursor,
  encodeCursor,
  listMarketCap,
  marketCapFacets,
  parseMarketCapQuery,
  resetMarketCapFacets,
  type MarketCapQuery,
} from "@/lib/market-cap/list";

// TASK-017b: the Charity Market Cap list against Postgres — order, filters,
// search and keyset pages. Our rows share a unique name prefix (`q`), so other
// test files writing trust scores at the same time do not change the results.

if (!process.env.DATABASE_URL) throw new Error("market cap tests need DATABASE_URL");
const db = getDb();
const { organizations, trustScores } = schema;
const RUN = `Mcap${Date.now().toString(36)}`;
const U = 1_000_000n;
const orgIds: string[] = [];

interface Spec {
  name: string;
  score: string;
  raised?: bigint;
  registered?: boolean;
  country?: string;
  causes?: string[];
  listed?: boolean;
  version?: number;
}

async function add(spec: Spec) {
  const [o] = await db
    .insert(organizations)
    .values({
      source: spec.registered ? "REGISTERED" : "IMPORTED",
      name: `${RUN} ${spec.name}`,
      country: spec.country ?? "GB",
      registry: "NONE",
      causes: [],
      kybStatus: spec.registered ? "APPROVED" : "NONE",
    })
    .returning({ id: organizations.id });
  orgIds.push(o!.id);
  await db.insert(trustScores).values({
    orgId: o!.id,
    version: spec.version ?? TRUST_SCORE_VERSION,
    score: spec.score,
    components: {},
    listed: spec.listed ?? true,
    registered: spec.registered ?? false,
    country: spec.country ?? "GB",
    causes: spec.causes ?? [],
    raised: String(spec.raised ?? 0n),
  });
  return o!.id;
}

/** Every page of a query, two rows at a time. */
async function all(query: Omit<MarketCapQuery, "after">, rare?: number) {
  const out: { name: string; position: number }[] = [];
  let after: string | undefined;
  for (let i = 0; i < 20; i++) {
    const { rows, next } = await listMarketCap(db, { ...query, after }, 2, rare);
    out.push(...rows.map((r) => ({ name: r.name.slice(RUN.length + 1), position: r.position })));
    if (!next) return out;
    after = next;
  }
  throw new Error("too many pages");
}
const names = async (query: Omit<MarketCapQuery, "after">, rare?: number) => (await all({ q: RUN, ...query }, rare)).map((r) => r.name);

beforeAll(async () => {
  await add({ name: "Alpha", score: "88.50", raised: 5_000n * U, registered: true, country: "SI", causes: ["animals"] });
  await add({ name: "Bravo", score: "61.00", raised: 100n * U, registered: true, country: "SI", causes: ["children", "education"] });
  await add({ name: "Charlie", score: "40.00", country: "GB", causes: ["animals"] });
  await add({ name: "Delta", score: "40.00", country: "US", causes: ["medical"] });
  await add({ name: "Echo", score: "40.00", country: "US", causes: [] });
  await add({ name: "Foxtrot 100%_off", score: "24.00", country: "GB" });
  await add({ name: "Golf removed", score: "99.00", listed: false });
  await add({ name: "Hotel old version", score: "99.00", version: TRUST_SCORE_VERSION + 100 });
});

afterAll(async () => {
  await db.delete(trustScores).where(inArray(trustScores.orgId, orgIds));
  await db.delete(organizations).where(inArray(organizations.id, orgIds));
});

describe("Charity Market Cap list", () => {
  it("ranks by score (ties by id, stable across pages), skips unlisted rows and other versions", async () => {
    const rows = await all({ q: RUN, sort: "score" });
    expect(rows.map((r) => r.name).slice(0, 2)).toEqual(["Alpha", "Bravo"]);
    expect(rows.map((r) => r.name).slice(2, 5).sort()).toEqual(["Charlie", "Delta", "Echo"]);
    expect(rows.at(-1)!.name).toBe("Foxtrot 100%_off");
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6]);
    // The tie group pages in one fixed order: the same three on every read.
    expect(await names({ sort: "score" })).toEqual(rows.map((r) => r.name));
  });

  it("orders by raised and by name, with keyset pages", async () => {
    expect((await names({ sort: "raised" })).slice(0, 2)).toEqual(["Alpha", "Bravo"]);
    expect(await names({ sort: "name" })).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot 100%_off"]);
  });

  // Both plans: walking the order index (filter common) and narrowing by the filter first (filter rare).
  it.each([["walking the order index", 0], ["narrowing by the filter first", Infinity]])(
    "filters by country, cause and on / not on CHERR.IO — %s",
    async (_, rare) => {
      expect(await names({ sort: "name", country: "US" }, rare)).toEqual(["Delta", "Echo"]);
      expect(await names({ sort: "name", cause: "animals" }, rare)).toEqual(["Alpha", "Charlie"]);
      expect(await names({ sort: "name", on: "cherrio" }, rare)).toEqual(["Alpha", "Bravo"]);
      expect(await names({ sort: "score", on: "other", country: "GB" }, rare)).toEqual(["Charlie", "Foxtrot 100%_off"]);
      expect(await names({ sort: "raised", cause: "children", country: "SI" }, rare)).toEqual(["Bravo"]);
    }
  );

  it("searches names case-insensitively; % and _ are literal", async () => {
    expect(await names({ sort: "name", q: `${RUN.toLowerCase()} br` })).toEqual(["Bravo"]);
    expect(await names({ sort: "name", q: `${RUN} Foxtrot 100%_` })).toEqual(["Foxtrot 100%_off"]);
    expect(await names({ sort: "name", q: `${RUN} %o` })).toEqual([]);
  });

  it("counts listed organisations per country and cause, and those on CHERR.IO", async () => {
    resetMarketCapFacets();
    const f = await marketCapFacets(db);
    expect(f.countries.find((c) => c.value === "SI")!.count).toBeGreaterThanOrEqual(2);
    expect(f.causes.find((c) => c.value === "animals")!.count).toBeGreaterThanOrEqual(2);
    expect(f.registered).toBeGreaterThanOrEqual(2);
    expect(f.listed).toBeGreaterThanOrEqual(f.registered + 4);
  });
});

describe("Charity Market Cap URL state", () => {
  it("drops unknown values and refuses cursors it did not make", () => {
    expect(parseMarketCapQuery({ sort: "drop table", country: "gb", cause: "nope", on: "x", q: "  " })).toEqual({
      sort: "score",
      country: "GB",
      cause: undefined,
      on: undefined,
      q: undefined,
      after: undefined,
    });
    const id = "0b6e2c1a-1111-4222-8333-444455556666";
    const good = encodeCursor({ value: "61.00", id, shown: 25 });
    expect(decodeCursor(good, "score")).toEqual({ value: "61.00", id, shown: 25 });
    expect(decodeCursor(good, "raised")).toBeNull(); // not a raised value
    expect(decodeCursor(encodeCursor({ value: "1; drop", id, shown: 0 }), "score")).toBeNull();
    expect(decodeCursor(encodeCursor({ value: "61", id: "x", shown: 0 }), "score")).toBeNull();
    expect(decodeCursor("not-base64-json", "score")).toBeNull();
  });
});
