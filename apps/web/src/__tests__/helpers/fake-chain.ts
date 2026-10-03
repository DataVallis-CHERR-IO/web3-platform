import { sql } from "drizzle-orm";
import type { Database } from "@cherrio/db";

// The test database has no indexer. These tables stand in for the `chain.*`
// views Ponder publishes (ADR-026), with the columns the web app reads
// (apps/indexer/ponder.schema.ts, snake_case). Shared by every test that needs
// chain data so that test files running in parallel agree on one shape.
// Unit (vitest) and E2E (Playwright) use the same helper.

export async function ensureFakeChain(db: Database): Promise<void> {
  const [kind] = (await db.execute(sql`
    select c.relkind from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'chain' and c.relname = 'campaign'
  `)) as unknown as { relkind: string }[];
  if (kind && kind.relkind !== "r") {
    throw new Error("chain.campaign is a real indexer view here; run these tests on a database without the indexer");
  }
  await db.transaction(async (tx) => {
    // Parallel test files: one creator at a time.
    await tx.execute(sql`select pg_advisory_xact_lock(4711011)`);
    await tx.execute(sql`create schema if not exists chain`);
    await tx.execute(sql`
      create table if not exists chain.campaign (
        address text primary key, offchain_id text not null, beneficiary text not null, beneficiary_type integer not null,
        target numeric(78,0) not null, deadline numeric(78,0) not null, state text not null,
        tx_hash text not null, log_index integer not null, block_number numeric(78,0) not null, block_time numeric(78,0) not null
      )
    `);
    for (const column of [
      sql`total_raised numeric(78,0) not null default 0`,
      sql`payout_mode integer`,
      sql`end_time numeric(78,0) not null default 0`,
    ]) {
      await tx.execute(sql`alter table chain.campaign add column if not exists ${column}`);
    }
    await tx.execute(sql`
      create table if not exists chain.campaign_donor (
        campaign text not null, donor text not null, donated numeric(78,0) not null, preference integer not null,
        sub_pool_id integer not null, settled boolean not null default false, primary key (campaign, donor)
      )
    `);
    await tx.execute(sql`
      create table if not exists chain.donation (
        id text primary key, campaign text not null, donor text not null, amount numeric(78,0) not null,
        preference integer not null, sub_pool_id integer not null,
        tx_hash text not null, log_index integer not null, block_number numeric(78,0) not null, block_time numeric(78,0) not null
      )
    `);
    await tx.execute(sql`
      create table if not exists chain.pool (
        id integer primary key, balance numeric(78,0) not null, total_contributed numeric(78,0) not null
      )
    `);
  });
}

/** Removes the fake chain rows of one campaign contract. */
export async function deleteFakeChainRows(db: Database, address: string): Promise<void> {
  const a = address.toLowerCase();
  await db.execute(sql`delete from chain.donation where campaign = ${a}`);
  await db.execute(sql`delete from chain.campaign_donor where campaign = ${a}`);
  await db.execute(sql`delete from chain.campaign where address = ${a}`);
}
