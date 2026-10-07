# Worker email queue without `lower()` — feedback
Status: DONE

Ad-hoc follow-up of TASK-047 (HANDOFF "Next 4"; David 2026-10-07: "ja").

## What I implemented
- `apps/worker/src/notify/enqueue.ts`: the four lifecycle queries (vote opened, reminder, result, refund available) compare `chain.*` hex columns, `app.campaigns.onchain_address` and `app.user_addresses.address` as they are. All of them are lower-case: Ponder writes `t.hex()` lower-case, the two app columns have lower-case check constraints, and the fake chain tables in tests enforce the same (`<table>_<column>_lower`). `lower()` on a column defeats its index (TASK-047). Dedupe keys are unchanged (`'vote:' || r.campaign || ':' || r.round` gives the same text as before because the column was already lower-case), so no email is sent twice after the deploy.
- Guard test `queries > compare the lower-case hex columns as they are, never through lower()` in `apps/worker/test/worker.test.ts` (reads the source without comment lines and expects no `lower(`).

## Files changed
- `apps/worker/src/notify/enqueue.ts` — 11 lines without `lower()`, comment on why.
- `apps/worker/test/worker.test.ts` — source guard.
- `docs/technical/03-data-and-indexer.md` — speed paragraph (was "still use `lower()`").
- `docs/technical/09-status-and-roadmap.md` — status row.

## Deviations
- none. Left out on purpose: `awardVotePoints` watermark (separate item); no new indexes (the existing `campaign_donor_donor_idx` and primary keys are enough, see numbers).

## New dependencies
- none

## How to verify
1. `DATABASE_URL=… pnpm --filter worker test` → 7 passed.
2. Benchmark (not committed, scratch script): perf database seeded with `pnpm --filter web perf:campaigns` (10,000 campaigns, ~100,000 donor rows), plus 5,000 donors as users with an email, `settlement_start` = now on the 2,000 failed campaigns and one open vote round on each of the 1,000 succeeded ones; then `enqueueLifecycle` of the old file (from `git show HEAD`) and the new one, 5 runs each, `app.notifications` emptied before each run.

## Test results
Worker tests (local Postgres 16):
```
 Test Files  1 passed (1)
      Tests  7 passed (7)
```
Deliberate break — `lower(cd.donor)` put back in both `user_addresses` joins:
```
   × queries > compare the lower-case hex columns as they are, never through lower() (TASK-047: lower() defeats the indexes) 9ms
     → expected [ 'lower(', 'lower(' ] to deeply equal []
```
Restored (the other six tests passed in the broken run too: the fake chain only stores lower-case values, so the behaviour tests cannot tell the two versions apart — the guard is what catches a regression).

Benchmark (one `enqueueLifecycle` call, local Postgres):
```
with lower()   : median 1393.5 ms  (runs 1338, 1371, 1393, 1431, 4452)  queued {"voteOpened":1420,"voteReminder":0,"voteResult":0,"refundAvailable":2840}
without lower(): median 161.6 ms  (runs 153, 156, 162, 164, 193)  queued {"voteOpened":1420,"voteReminder":0,"voteResult":0,"refundAvailable":2840}
with lower()   : median 1399.4 ms  (runs 1345, 1357, 1399, 1401, 1426)  queued {"voteOpened":1420,"voteReminder":0,"voteResult":0,"refundAvailable":2840}
without lower(): median 174.8 ms  (runs 151, 154, 175, 177, 204)  queued {"voteOpened":1420,"voteReminder":0,"voteResult":0,"refundAvailable":2840}
```
Same rows queued, ~8.5× faster.

## Open questions / risks
- On dev the chain tables are Ponder's views over the `chain_<sha7>` schema; the indexes are Ponder's. Measured locally on the fake tables (same index on `campaign_donor.donor`), not on dev.

## Suggested commit message
perf(worker): compare lower-case hex columns without lower() in the email queue
