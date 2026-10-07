# Vote points with a watermark — feedback
Status: DONE

Ad-hoc follow-up (HANDOFF open item "`awardVotePoints` scans every indexed vote each minute — add a watermark if `chain.vote` grows large"; David 2026-10-07: "ok štima, gremo").

## What I implemented
- `apps/worker/src/points.ts`:
  - **Cursor** (`VoteCursor`, `newVoteCursor()`): the highest `chain.vote.block_number` seen. With a cursor a tick reads only votes from `maxBlock − OVERLAP_BLOCKS` (2,000 blocks, ~1 h on Polygon) on. The overlap re-reads votes a running indexer cycle may still be committing; the unique index `points_ledger_auto_uniq` makes re-reading harmless. The head is read before the insert, so a vote committed in between has a higher block and lies inside the next range. The cursor never moves backwards.
  - **Full pass** at worker start (the cursor lives in memory) and every `FULL_SWEEP_MS` (6 h). It credits votes whose address was linked to a user *after* the vote (the incremental range would never see them again) and rows an indexer rebuild added below the cursor.
  - **No `lower()`**: the hex columns are lower-case (Ponder; check constraints on `app.campaigns.onchain_address` and `app.user_addresses.address`), as in PR #147.
  - **Already credited votes are skipped before the insert** (anti-join on `points_ledger` by user, reason and ref key) instead of one speculative insert per ledger row; `on conflict do nothing` stays as the guarantee.
  - Returns `{ awarded, full }`; `tick()` still reports `points` as a number.
- `apps/worker/src/run.ts`, `src/index.ts`: the worker keeps one cursor for the process and passes it to every tick.
- `apps/indexer/ponder.schema.ts`: index on `vote.block_number` (`blockIdx`). **The indexer rebuilds once on the next deploy** (new `chain_<sha7>`, as for every indexer input change; Ponder's RPC cache makes it cheap).
- `apps/web/src/__tests__/helpers/fake-chain.ts`: the same index on the fake `chain.vote`.

## Files changed
- `apps/worker/src/points.ts`, `apps/worker/src/run.ts`, `apps/worker/src/index.ts` — cursor, full pass, query.
- `apps/worker/test/worker.test.ts` — new test for the cursor and the full pass; the source guard also covers `points.ts`.
- `apps/indexer/ponder.schema.ts` — `blockIdx`.
- `apps/web/src/__tests__/helpers/fake-chain.ts` — index on the fake table.
- `docs/technical/03-data-and-indexer.md`, `docs/technical/09-status-and-roadmap.md`.

## Deviations
- The cursor is in memory, not in a table: no migration, and a restart costs one full pass (~3 s at 1,000,000 votes). A stored cursor would save that pass only.
- Left out on purpose: catching late-linked addresses every minute (would need an index on `user_addresses.created_at` or a scan of all addresses per tick). Voting in the app requires a signed-in user whose address is already linked, so the case is rare; the 6-hour full pass covers it.
- Reorgs: a vote removed by a reorg keeps its points — unchanged from before.

## New dependencies
- none

## How to verify
1. `DATABASE_URL=… pnpm --filter worker test` → 8 passed.
2. Benchmark (scratch script, not committed): perf database seeded with `pnpm --filter web perf:campaigns` (10,000 campaigns), plus 50,000 users each with a linked address and 1,000,000 votes (100 per campaign, blocks 2,020 … 20,002,000), all already credited; the old `points.ts` (from `git show HEAD`) against the new one.

## Test results
Worker tests (local Postgres 16):
```
 ✓ test/worker.test.ts (8 tests) 369ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
```
Deliberate break 1 — the range dropped (`const range = sql\`true\``), so every tick reads all votes:
```
   × vote points > with a cursor a tick reads only votes near the newest block; the periodic full pass catches the rest 44ms
     → expected { awarded: 3, full: false } to deeply equal { awarded: 2, full: false }
      Tests  1 failed | 7 passed (8)
```
Deliberate break 2 — `lower(v.voter)` put back in the address join:
```
   × queries > compare the lower-case hex columns as they are, never through lower() (TASK-047: lower() defeats the indexes) 10ms
     → expected { file: '../src/points.ts', …(1) } to deeply equal { file: '../src/points.ts', lower: [] }
      Tests  1 failed | 7 passed (8)
```
Both restored → 8 passed.

Indexer tests: `Test Files 7 passed (7)`, `Tests 53 passed (53)`. Worker typecheck/lint, indexer typecheck/lint: done, no errors. Worker bundle smoke run: `/health` → `ok`, log `[worker] started; email sending off (no SMTP credentials)`.

Benchmark (1,000,000 votes, all credited — the steady state the worker sees every minute):
```
old, every minute after that : median 13112.5 ms (13339, 13112, 13171, 12943, 13056), awarded 0
new, full pass (start, every 6 h): median 3252.1 ms (3426, 3252, 3181), {"awarded":0,"full":true}
new, every minute (no new votes): median 3.6 ms (5.2, 3.6, 3.1, 3.1, 3.6), {"awarded":0,"full":false}
new, minute with 50 new votes : 12.7 ms, {"awarded":50,"full":false}
Bitmap Heap Scan on vote v  (cost=5.17..371.44 rows=96 width=43)
  Recheck Cond: (block_number >= '20000005'::numeric)
  ->  Bitmap Index Scan on vote_block_number_idx  (cost=0.00..5.14 rows=96 width=0)
```
Before the anti-join the full pass took ~18 s (insert with `on conflict` per row); the selection alone went 2.9 s → 1.1 s without `lower()` (`explain analyze`).

## Open questions / risks
- Measured on the fake tables locally, not on dev (dev has a handful of votes).
- The indexer rebuild on the next deploy is the usual path (Ready → Reconcile → Prune); watch the indexer job.

## Suggested commit message
perf(worker): award vote points from a block watermark instead of the whole vote history

## After the merge
PR #151 merged by David 2026-10-07; Deploy 37664039459 green: web, **Indexer — Build → Deploy → Ready → Reconcile → Prune** (rebuild for the new index) and **Worker — Build → Deploy → Health**.
