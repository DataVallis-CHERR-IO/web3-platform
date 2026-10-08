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
      // Lifecycle columns (TASK-033b): same names as the indexer's campaign table.
      sql`prev_state text not null default 'LIVE'`,
      sql`released numeric(78,0) not null default 0`,
      sql`fee_paid numeric(78,0) not null default 0`,
      sql`tranches_released integer not null default 0`,
      sql`current_round integer not null default 0`,
      sql`vote_end numeric(78,0) not null default 0`,
      sql`total_refunded numeric(78,0) not null default 0`,
      sql`total_sent_to_pool numeric(78,0) not null default 0`,
      sql`pool_donated numeric(78,0) not null default 0`,
      sql`swept boolean not null default false`,
      sql`frozen_at numeric(78,0) not null default 0`,
      sql`settlement_start numeric(78,0) not null default 0`,
      sql`rejected_remainder numeric(78,0) not null default 0`,
      // Not null in the indexer; nullable here so a test can stand for a view
      // that does not have them yet (the web app must cope).
      sql`snap_vote_window integer`,
      sql`snap_quorum_bps integer`,
      sql`snap_approval_bps integer`,
      sql`snap_release_delay integer`,
      sql`snap_refund_sweep_delay integer`,
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
      create table if not exists chain.vote_round (
        campaign text not null, round integer not null, bundle_hash text not null, vote_end numeric(78,0) not null,
        yes_votes numeric(78,0) not null, no_votes numeric(78,0) not null, outcome text, closed_at numeric(78,0),
        tx_hash text not null, log_index integer not null, block_number numeric(78,0) not null, block_time numeric(78,0) not null,
        primary key (campaign, round)
      )
    `);
    await tx.execute(sql`
      create table if not exists chain.vote (
        campaign text not null, round integer not null, voter text not null, approve boolean not null, weight numeric(78,0) not null,
        tx_hash text not null, log_index integer not null, block_number numeric(78,0) not null, block_time numeric(78,0) not null,
        primary key (campaign, round, voter)
      )
    `);
    await tx.execute(sql`
      create table if not exists chain.tranche_release (
        id text primary key, campaign text not null, tranche_index integer not null, beneficiary text not null,
        amount numeric(78,0) not null, fee numeric(78,0) not null,
        tx_hash text not null, log_index integer not null, block_number numeric(78,0) not null, block_time numeric(78,0) not null
      )
    `);
    // The indexer's secondary indexes (apps/indexer/ponder.schema.ts), so query
    // plans here match the real views (TASK-047).
    for (const index of [
      sql`create index if not exists campaign_donor_donor_idx on chain.campaign_donor (donor)`,
      sql`create index if not exists donation_campaign_idx on chain.donation (campaign)`,
      sql`create index if not exists donation_donor_idx on chain.donation (donor)`,
      sql`create index if not exists vote_block_number_idx on chain.vote (block_number)`,
      sql`create index if not exists donation_block_number_idx on chain.donation (block_number)`,
      sql`create index if not exists tranche_release_campaign_idx on chain.tranche_release (campaign)`,
    ]) {
      await tx.execute(index);
    }
    // Ponder writes hex columns lower-case and the app compares them without
    // lower() (TASK-047): a test row in another case would model something the
    // indexer never writes, so the fake tables refuse it.
    for (const [table, column] of [
      ["campaign", "address"], ["campaign", "offchain_id"], ["campaign_donor", "campaign"], ["campaign_donor", "donor"],
      ["donation", "campaign"], ["donation", "donor"], ["vote_round", "campaign"], ["vote", "campaign"], ["vote", "voter"], ["tranche_release", "campaign"],
    ] as const) {
      const name = `${table}_${column}_lower`;
      await tx.execute(sql.raw(`
        do $$ begin
          if not exists (select 1 from pg_constraint where conname = '${name}') then
            alter table chain.${table} add constraint ${name} check (${column} = lower(${column}));
          end if;
        end $$
      `));
    }
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
  await db.execute(sql`delete from chain.tranche_release where campaign = ${a}`);
  await db.execute(sql`delete from chain.vote where campaign = ${a}`);
  await db.execute(sql`delete from chain.vote_round where campaign = ${a}`);
  await db.execute(sql`delete from chain.donation where campaign = ${a}`);
  await db.execute(sql`delete from chain.campaign_donor where campaign = ${a}`);
  await db.execute(sql`delete from chain.campaign where address = ${a}`);
}
