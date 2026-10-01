/**
 * Prune against a real Postgres (throwaway database from DATABASE_URL_DIRECT).
 * A missing or unreachable database fails the suite.
 */
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isDeploySchema, planPrune, prune } from "../lib/prune";

let admin: postgres.Sql;
let sql: postgres.Sql;
let testDb: string;

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

/** A schema that looks like a stopped Ponder instance. */
async function ponderSchema(name: string, heartbeatAgoMs: number) {
  await sql`create schema ${sql(name)}`;
  await sql`create table ${sql(name)}._ponder_meta (key text primary key, value jsonb not null)`;
  await sql`insert into ${sql(name)}._ponder_meta values ('app', ${sql.json({
    is_locked: 0,
    heartbeat_at: NOW - heartbeatAgoMs,
  })})`;
  await sql`create table ${sql(name)}.campaign (address text primary key)`;
}

async function pointViewsAt(name: string) {
  await sql`drop schema if exists chain cascade`;
  await sql`create schema chain`;
  await sql`create view chain.campaign as select * from ${sql(name)}.campaign`;
}

async function schemas() {
  const rows = await sql<{ nspname: string }[]>`
    select nspname from pg_namespace
    where nspname not like 'pg\\_%' and nspname not in ('information_schema', 'public') order by 1`;
  return rows.map((r) => r.nspname);
}

beforeAll(async () => {
  const directUrl = process.env.DATABASE_URL_DIRECT;
  if (!directUrl) throw new Error("prune test needs DATABASE_URL_DIRECT (direct Postgres)");
  admin = postgres(directUrl, { max: 1, onnotice: () => {} });
  testDb = `cherrio_indexer_test_${Math.random().toString(36).slice(2, 10)}`;
  await admin`create database ${admin(testDb)}`;
  const url = new URL(directUrl);
  url.pathname = `/${testDb}`;
  sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end();
  if (admin) {
    await admin`drop database if exists ${admin(testDb)} with (force)`;
    await admin.end();
  }
});

beforeEach(async () => {
  for (const name of await schemas()) await sql`drop schema ${sql(name)} cascade`;
  await ponderSchema("chain_aaa0001", 30 * HOUR); // oldest
  await ponderSchema("chain_bbb0002", 20 * HOUR);
  await ponderSchema("chain_ccc0003", 10 * HOUR); // previous
  await ponderSchema("chain_ddd0004", 1 * HOUR); // live
  await pointViewsAt("chain_ddd0004");
  // Things prune must never touch:
  await sql`create schema app`;
  await sql`create table app.users (id int primary key)`;
  await sql`create schema ponder_sync`;
  await sql`create table ponder_sync._ponder_meta (key text primary key, value jsonb)`;
  await sql`create schema chain_notponder`; // matches the name, is not a Ponder instance
  await sql`create table chain_notponder.t (id int)`;
  await ponderSchema("chainx_1", 40 * HOUR); // is a Ponder instance, wrong name
  await ponderSchema("other_chain_abc", 40 * HOUR);
});

describe("prune", () => {
  it("keeps the live schema and the most recent other one, drops older ones", async () => {
    const plan = await prune({ sql, now: NOW });
    expect(plan).toEqual({
      live: "chain_ddd0004",
      kept: ["chain_ccc0003"],
      drop: ["chain_bbb0002", "chain_aaa0001"], // most recent first
    });
    expect(await schemas()).toEqual(
      ["app", "chain", "chain_ccc0003", "chain_ddd0004", "chain_notponder", "chainx_1", "other_chain_abc", "ponder_sync"].sort()
    );
    // The views still work.
    expect(await sql`select * from chain.campaign`).toEqual([]);
  });

  it("dry run drops nothing", async () => {
    const before = await schemas();
    const plan = await prune({ sql, now: NOW, dryRun: true });
    expect(plan.drop).toHaveLength(2);
    expect(await schemas()).toEqual(before);
  });

  it("never drops the live schema, even when it is the oldest", async () => {
    await pointViewsAt("chain_aaa0001");
    const plan = await prune({ sql, now: NOW });
    expect(plan.live).toBe("chain_aaa0001");
    expect(plan.kept).toEqual(["chain_ddd0004"]);
    expect(plan.drop.sort()).toEqual(["chain_bbb0002", "chain_ccc0003"]);
    expect(await schemas()).toContain("chain_aaa0001");
  });

  it("keeps a schema whose instance is still running (new deploy still backfilling)", async () => {
    await ponderSchema("chain_eee0005", 30_000); // heartbeat 30 s ago
    await ponderSchema("chain_fff0006", 60_000);
    const plan = await planPrune({ sql, now: NOW });
    expect(plan.live).toBe("chain_ddd0004");
    expect(plan.kept).toEqual(["chain_eee0005", "chain_fff0006"]);
    expect(plan.drop.sort()).toEqual(["chain_aaa0001", "chain_bbb0002", "chain_ccc0003"]);
  });

  it("without views yet, keeps the most recent schema", async () => {
    await sql`drop schema chain cascade`;
    const plan = await planPrune({ sql, now: NOW });
    expect(plan.live).toBeUndefined();
    expect(plan.kept).toEqual(["chain_ddd0004"]);
  });

  it("refuses to prune when the views read from two schemas", async () => {
    await sql`create view chain.mixed as select * from chain_ccc0003.campaign`;
    await expect(prune({ sql, now: NOW })).rejects.toThrow("Refusing to prune");
    expect(await schemas()).toContain("chain_aaa0001");
  });

  it("only chain_<id> names can ever be dropped", () => {
    for (const name of ["chain_ab12cd3", "chain_t1"]) expect(isDeploySchema(name)).toBe(true);
    for (const name of ["app", "chain", "ponder_sync", "public", "chainx_1", "other_chain_abc", "chain_", 'chain_a"; drop', "CHAIN_ABC"]) {
      expect(isDeploySchema(name)).toBe(false);
    }
  });
});
