# TASK-048 feedback
Status: DONE (code, tests, docs) — live effect is visible after the indexer deploy on dev (new schema, then a cycle every 120 s)

## What I implemented
- `INDEXER_MODE` switch in `Dockerfile.indexer` CMD: `realtime` (default, `ponder start` exactly as before) / `batch` (`node dist/batch.mjs`) / anything else → exit 1.
- `apps/indexer/scripts/batch.ts` (bundled to `dist/batch.mjs`) and pure helpers `apps/indexer/lib/batch.ts` (`indexerMode`, `batchIntervalSeconds`, `finalityBlocks`, `nextEndBlock`, `endBlockFromEnv`, `indexedBlockFromStatus`).
- `INDEXER_END_BLOCK` → `env.endBlock` → `endBlock` on all three contracts in `ponder.config.ts`.
- `config/indexer.dev.yml`: `INDEXER_MODE: batch`, `INDEXER_BATCH_INTERVAL_SECONDS: "120"`.
- `scripts/rpc-cost.ts`: the measuring tool used for the decision (local only); `INDEXER_CACHE=1` keeps Ponder's RPC cache on for a local chain, for that tool only.
- `vitest.config.ts`: scenario files run one at a time (each runs forge build + script).

## Files changed
- Dockerfile.indexer, config/indexer.dev.yml — mode switch, dev in batch
- apps/indexer/scripts/batch.ts, apps/indexer/lib/batch.ts, apps/indexer/lib/env.ts, apps/indexer/ponder.config.ts — runner, config
- apps/indexer/scripts/rpc-cost.ts — measuring tool
- apps/indexer/test/batch.test.ts, apps/indexer/test/batch-scenario.test.ts, apps/indexer/package.json, apps/indexer/vitest.config.ts — tests
- docs: `03-DECISIONS.md` (ADR-055), `technical/03` (§4.2 row, §4.13), `technical/05`, `technical/09`, `tasks/README.md`, this feedback, `TASK-048-indexer-batch-mode.md`

## Deviations from the task (and why)
- Found while testing: Ponder 0.17.12 leaves its schema lock (`_ponder_meta.is_locked`) set when stopped with SIGTERM, so each next cycle waited ~20 s ("Schema is locked by a different Ponder app … retry_delay=20048"). The runner now resets the lock after the child has exited; cycles went from 25.1 s to ~5 s in the scenario test.

## New dependencies
- none (`postgres` was already an indexer dependency)

## How to verify
1. `pnpm --filter indexer test` → 33 passed.
2. With anvil/forge: `DATABASE_URL_DIRECT=… pnpm --filter indexer test:scenario` (CI job "Indexer scenario").
3. On dev after the deploy: the indexer log shows `[indexer:batch] … indexed to block N in X s` every ~2 minutes; a donation appears on the campaign page within ~3 minutes; Alchemy daily usage drops from ~3.5–4.5 M CU to well under 1 M.

## Test results
Measurement (`scripts/rpc-cost.ts`, Anvil 1 block/s, counting proxy, Ponder cache on), first run:
```
== realtime: 120s, blocks 5→133 (128), donations made: 2
{ eth_chainId: 1, eth_getBlockByNumber: 132, eth_getLogs: 125, eth_call: 21 } ≈ 10158 CU, 79.4 CU/block
```
Later run with the build-id bypass:
```
== realtime: 60s, blocks 5→69 (64) … ≈ 4472 CU, 69.9 CU/block
cycle 2: target 133 reached 133 in 5.1s, crash recovery: true, stopped, donation from this cycle indexed: 1 { eth_chainId: 1, eth_getBlockByNumber: 9, eth_getLogs: 12, eth_call: 7 } ≈ 1046 CU
cycle 5: target 281 reached 281 in 5.1s, crash recovery: true, stopped, donation from this cycle indexed: 1 … ≈ 1334 CU
```
Idle cycles (`SPIKE_IDLE=1`):
```
cycle 3: target 115 reached 115 in 4.1s, IDLE crash recovery: true, stopped … { eth_chainId: 1, eth_getBlockByNumber: 7, eth_getLogs: 12 } ≈ 832 CU
cycle 4: … ≈ 952 CU
cycle 5: … ≈ 832 CU
```
Without the bypass every cycle after the first failed: `MigrationError: Schema "chain_b" was previously used by a different Ponder app` (Ponder hashes `contracts` incl. the end block into its build id — `build/index.js` line 130).

Tests:
- `pnpm --filter indexer test`: `Tests  33 passed (33)` (26 + 7 new).
- `vitest run test/batch-scenario.test.ts`: first run `1 failed | 1 passed` — a race in the test (the views showed a cycle's rows before the runner recorded its end block); fixed by waiting for both. Then `✓ test/batch-scenario.test.ts (2 tests) 213629ms`, and after the lock fix `✓ … (2 tests) 126055ms`; runner log: `indexed to block 2 in 6.1 s`, `indexed to block 9 in 5.1 s`, `… 14 in 5.1 s` …, 7× "Detected crash recovery".
- Deliberate break: `PONDER_EXPERIMENTAL_DB` removed from the runner → `cycle failed (1/5): ponder exited with 1 before block 7` … `(5/5)` → `× … runner exited with 1`; restored.
- lint / typecheck (indexer): no errors.
- Bundle like the Dockerfile (`esbuild scripts/reconcile.ts scripts/prune.ts scripts/batch.ts …`): `dist/batch.mjs` builds; without `GIT_SHA7` → `Error: [Indexer] GIT_SHA7 (or INDEXER_SCHEMA) is not set`, exit 1.
- CMD switch checked with `sh -n` and for `""`/`realtime`/`batch`/`bogus` → RT, RT, BATCH, BAD (exit 1).
- The full indexer scenario (`scenario.test.ts`) and the Docker image: NOT RUN locally — CI runs both.

## Open questions / risks
- `PONDER_EXPERIMENTAL_DB=platform` is an undocumented Ponder switch; the scenario test fails if a Ponder upgrade changes it.
- The first cycle after each indexer deploy is a full backfill (as today); the deploy's 20-minute /ready wait still applies.
- Latency on dev is now up to ~3 minutes (interval + 30 finality blocks).

## Suggested commit message
feat(indexer): batch mode — catch up every 2 min with ranged getLogs on dev (ADR-055, TASK-048)

## Incident 2026-10-06 and fix (PR #122 → this PR)
- **What happened:** after #120 David's Alchemy chart showed `eth_getLogs` rising from ~2,500 to ~14,000 an hour (from ~18:00 on 5 Oct); overnight the indexer used about half of what realtime had used in several days. `eth_getBlockByNumber` fell as expected.
- **Why the tests did not catch it:** the measurement and the scenario ran on chains of a few hundred blocks, where the whole history fits in one `eth_getLogs`, so "re-read everything" and "read only the new blocks" cost the same. Also the scenario ran with Ponder's cache off (APP_ENV=local), so it could not show cache behaviour at all.
- **Cause:** Ponder 0.17.12 keys its cache of `factory()` scans by the end block — `factory_log_${chainId}_${address}_${eventSelector}_${childAddressLocation}_${fromBlock}_${toBlock}` (`ponder/dist/esm/runtime/fragments.js`, line 235); plain log filters are keyed without block bounds. A new end block every cycle = a cache miss = the factory's history again. Reproduced with 3,000 mined blocks: every cycle asked `0-25 26-51 … 1948-2932 …` again.
- **Immediate action:** PR #122 put dev back to realtime (merged as soon as CI was green).
- **Fix:** batch mode passes the campaigns as an address list (`INDEXER_CAMPAIGNS_FILE`, found by the runner from `CampaignCreated`); realtime keeps `factory()`.
- **Measured after the fix** (`scripts/rpc-cost.ts`, real runner every 20 s, 3,000-block history, cache on):
```
window 2: {"eth_blockNumber":1,"eth_getLogs":4,"eth_chainId":1,"eth_getBlockByNumber":5} ≈ 330 CU; getLogs ranges: 2980-2999 2980-2999 2980-2999 2980-2999
window 4: {"eth_chainId":1,"eth_getBlockByNumber":5,"eth_getLogs":4,"eth_blockNumber":1} ≈ 330 CU; getLogs ranges: 3020-3039 3020-3039 3020-3039 3040-3059
window 5: … "eth_getLogs":16 … ≈ 1248 CU; getLogs ranges: 0-25 … 2763-2932 3040-3059 …   ← a new campaign: its address is read from the start once
window 6: … ≈ 330 CU; getLogs ranges: 3060-3079 3060-3079 3060-3079 3080-3099
```
  At 120 s on Amoy: ~720 cycles a day × ~330 CU ≈ 0.24 M CU a day (+ ~1,250 CU per new campaign), against ~3.5–4.5 M in realtime.
- **New guard:** `batch-scenario.test.ts` mines 2,000 blocks first, runs with the cache on behind a counting proxy and asserts that a cycle without new campaigns only asks for blocks after the previous end (≤ 8 requests). Deliberate break — `factory()` back in batch mode: `× a cycle without new campaigns reads only the new blocks …  → [{"from":0,"to":25,…},{"from":26,"to":51,…}…]`, `Tests 1 failed | 2 passed (3)`; restored → `✓ test/batch-scenario.test.ts (3 tests) 141811ms`.
- `pnpm --filter indexer test`: `Tests  36 passed (36)`; lint and typecheck clean.
- **What to watch on Alchemy after the deploy:** `eth_getLogs` ~120 an hour and `eth_getBlockByNumber` ~150 an hour on dev (instead of ~2,500 / ~3,600 in realtime).

## Follow-up 2026-10-06: first cycle on dev did not finish (Deploy 37419279104)
- After #123 the new batch container passed "Deploy with Kamal" but `/ready` was not reached within 20 minutes. The job log (last 100 indexer lines) cannot be read from the cloud session; asked David for it.
- Likely cause (reproduced, not yet confirmed on dev): the runner's factory scan asked for 50,000 blocks per `eth_getLogs` and failed when the provider refuses wide ranges; 5 failed cycles stop the runner, the container restarts, the first cycle never completes. With the scenario proxy refusing ranges over 1,000 blocks and the narrowing disabled: `cycle failed (1/5): eth_getLogs failed: eth_getLogs is limited to a 1,000 block range` … `(5/5)` → `× … runner exited with 1`.
- Fix: the scan halves a refused range down to 10 blocks (`nextScanRange`), and starts from the campaigns the live `chain.campaign` view already knows (only blocks after the newest of them are scanned), so a new schema no longer scans the factory's whole history. Scenario test (proxy refusing > 1,000-block ranges): `✓ test/batch-scenario.test.ts (3 tests) 140826ms`, with "refused" in the runner log and refused ranges counted.
- Unit tests: `Tests  11 passed (11)` in `test/batch.test.ts`.

## Follow-up 2026-10-06: backup RPC rate-limited (Deploy 37431137092, after #125)
- **Seen on dev** (indexer log pasted by David; the GitHub log blob is unreachable from the cloud session): the backup was used — Alchemy answered 429 (monthly cap), Infura answered — but the first cycle never completed:
```
factory scan 49370956-49420955 refused (eth_getLogs failed: range 49999 exceeds limit of 10000); retrying with 25000 blocks
…retrying with 6250 blocks
factory scan 49383456-49389705 refused (eth_getLogs failed: 429); retrying with 3125 blocks
… retrying with 10 blocks
cycle failed (5/5): eth_getLogs failed: 429
Error: [Indexer] too many failed batch cycles
```
- **Causes:** (1) Infura accepts at most 10,000 blocks per `eth_getLogs`; the runner started at 50,000, and Ponder 0.17's range helper (`@ponder/utils` `getLogsRetryHelper`) does not recognise Infura's message, so Ponder's own backfill would also stop once its adaptive range grew past 10,000. (2) The runner treated Infura's per-second limit (HTTP 429) as a refused range: it halved and fired again at once — more requests, more 429s, down to 10 blocks, cycle failed. (3) The error showed only the last provider's status, and every failed cycle started the scan again from the first block.
- **Fix:** `INDEXER_GETLOGS_RANGE` (default 10,000) for the runner's scan and Ponder's `ethGetLogsBlockRange`; `isRateLimited()` tells "slow down" (HTTP/code 429, "too many requests", "rate limit", "capacity limit") from a refused range (checked first: "exceeds limit of", "block range", … — JSON-RPC `-32005` is used for both, so the message decides); `rpc()` repeats a rate-limited request after 1, 2, 4, 8, 16 s; errors name both providers (`primary: …; backup: …`); the scan keeps every completed range across failed cycles.
- **Scenario test** (backup proxy like Infura: ranges ≥ 1,000 refused with `range N exceeds limit of 1000`, every 4th `eth_getLogs` HTTP 429 without JSON; `INDEXER_GETLOGS_RANGE=1000`): `✓ test/batch-scenario.test.ts (3 tests) 148213ms`, runner log 8× `eth_getLogs failed — primary: Monthly capacity limit exceeded.; backup: HTTP 429 Too Many Requests; rate limited, retrying in 1 s`, 0 "cycle failed", 0 "refused".
- **Deliberate breaks:** (a) retry disabled → `× a cycle without new campaigns … → expected '…' to contain 'rate limited, retrying'`, `Tests 1 failed | 2 passed (3)`, runner log 7× `cycle failed (1/5): eth_getLogs failed — primary: Monthly capacity limit exceeded.; backup: HTTP 429 Too Many Requests`; restored. (b) `INDEXER_GETLOGS_RANGE` removed from the scenario → the runner's 10,000-block scan is refused 4× and halved (`factory scan 0-1973 refused (… backup: range 1973 exceeds limit of 1000); retrying with 5000 blocks` …), `Tests 1 failed | 2 passed (3)`; restored. The first run of (b) also exposed a bug in the first version of `isRateLimited` (it treated code `-32005` as a rate limit, so a refused range was retried instead of narrowed → runner exited with 1); fixed and unit-tested.
- Not proven by the scenario: Ponder's own backfill with Infura's range message — the scenario's history (2,000 blocks) is too short for Ponder's adaptive range (starts at 500, +5 % per success) to pass 1,000. The cap is a plain Ponder option (`ethGetLogsBlockRange`, `ponder/dist/esm/sync-historical/index.js`).
- `pnpm --filter indexer test`: `Tests  41 passed (41)`; lint and typecheck clean.

## Follow-up 2026-10-06: reconcile failed through the backup (Deploy 37443324215, after #126)
- **Seen on dev:** the first cycle completed through Infura ("Wait for /ready" green — first green batch deploy), then "Reconcile against the chain" exited 1: `ContractFunctionExecutionError: The contract function "hasFundingPool" returned no data ("0x")` (EmergencyPool `0xFa7F…9517`, arg campaign `0x2ea0…e033`). Run again by hand (David, 12:35): same error, this time for `Campaign.state()` of the same campaign — a different read each time.
- **Checked on the server (David, read-only script):** checkpoint block 49460153, head 49460272 (119 behind — the block is right); Alchemy answers every call `HTTP 429 Monthly capacity limit exceeded`; Infura at that block: `eth_getCode` = the pool's bytecode, `eth_call hasFundingPool` = `0x…0000` (false — a valid answer). So the contract and block are fine and Infura answers single requests correctly.
- **Cause (most likely; not reproduced against Infura itself — the cloud session cannot reach it):** reconcile sent its reads as JSON-RPC batches (`http(url, { batch: true })`), ~20 at once per campaign, to a free-tier backup with a per-second limit. Locally, a batch answer whose rate-limited items carry no matching id made viem hand *other items' results* to those reads (`fulfilled 0` for all four, half of them answers to different requests) — batching against a rate-limiting provider can give empty or wrong values, which for a check like reconcile is worse than an error.
- **Fix:** reconcile sends one request per read (no batches), at most 4 at a time (`limiter`, `READ_CONCURRENCY`), and repeats a read that is rate limited or comes back empty (`"0x"` — no view of our contracts at a block where they exist returns that) after 1, 2, 4, 8, 16 s (`withReadRetry`, `lib/rpc-read.ts`); each repeat is printed (`reconcile: read repeated in 1 s (…)`). Values are never retried or adjusted: a mismatch is still a mismatch, a revert or other error fails at once, an empty answer that persists fails after ~31 s.
- **Tests** (`test/rpc-read.test.ts`, real viem clients against local JSON-RPC servers: primary = HTTP 429 "Monthly capacity limit exceeded.", backup = answers "0x" twice then the value / HTTP 429 once / always "0x" / reverts): `✓ test/rpc-read.test.ts (7 tests)`; `pnpm --filter indexer test`: `Tests  48 passed (48)`; lint and typecheck clean; the image's esbuild bundle of `scripts/reconcile.ts` builds.
- **Deliberate break:** empty results not treated as retryable → `× an empty answer from the backup is repeated and the real value used` (`returned no data ("0x")`), `× an empty answer that persists still fails, after the last pause` (`expected 1 to be 3`), `Tests 2 failed | 5 passed (7)`; restored → `7 passed`. A break of the limiter's slot hand-over was not caught by its test (the race needs a caller arriving between release and wake-up, which the test does not produce); the hand-over is kept because it is the correct version.
- The full reconcile against Anvil (`scenario.test.ts`, "reconcile: zero mismatches …") runs in CI ("Indexer scenario"); NOT RUN locally — Anvil/Foundry are not installed in this session.
