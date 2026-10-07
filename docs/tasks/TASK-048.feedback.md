# TASK-048 feedback
Status: DONE — Live on dev (Deploy 37452453763, 2026-10-06: Ready → Reconcile → Prune green through the Infura backup)

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

## Result on dev 2026-10-06 (Deploy 37452453763, after #127)
- All jobs green. Indexer steps: Deploy with Kamal 10:52:48→10:53:25, **Wait for /ready 10:53:25→10:53:41**, **Reconcile 10:53:41→10:54:29**, Prune 10:54:29→10:54:32 (UTC) — with Alchemy still answering every call `HTTP 429 Monthly capacity limit exceeded`, i.e. entirely through the Infura backup.
- Still to confirm with David: Alchemy/Infura usage per day once Alchemy's month resets (expected well under 1 M CU/day on dev).

## Follow-up 2026-10-06: Infura usage — reconcile through multicall
- **Seen:** David's Infura dashboard (2026-10-06 ~13:20): **1,943 requests in 1 hour**, with Alchemy still over its cap (every indexer request on Infura). Expected for the batch indexer alone: ~300–350 an hour.
- **Measured, idle cycles through the backup** (`scripts/rpc-cost.ts`, new switches `SPIKE_PRIMARY_DOWN=1` — the primary answers every call with HTTP 429 "Monthly capacity limit exceeded." and the counting proxy is the backup — and `SPIKE_CAMPAIGNS=5`; Anvil 1 block / 2 s, runner every 30 s, 3,000-block history, cache on):
  ```
  window 1: {"eth_blockNumber":1,"eth_getLogs":37,"eth_chainId":1,"eth_getBlockByNumber":14,"eth_call":35} = 88 calls ≈ 3364 CU; … (primary refused 88)
  window 2: {"eth_blockNumber":1,"eth_getLogs":4,"eth_chainId":1,"eth_getBlockByNumber":5} = 11 calls ≈ 330 CU; getLogs ranges: 2993-3007 ×4 (primary refused 11)
  window 4: {"eth_blockNumber":1,"eth_getLogs":15,"eth_chainId":1,"eth_getBlockByNumber":5,"eth_call":7} = 29 calls ≈ 1172 CU; … 0-25 26-51 … 1948-2932 … (primary refused 29)   ← a new campaign: Ponder reads its history once
  window 5: {"eth_blockNumber":1,"eth_getLogs":4,"eth_chainId":1,"eth_getBlockByNumber":6} = 12 calls ≈ 346 CU (primary refused 12)
  window 6: {"eth_blockNumber":1,"eth_getLogs":4,"eth_chainId":1,"eth_getBlockByNumber":5} = 11 calls ≈ 330 CU (primary refused 11)
  ```
  An idle cycle is **11 requests** on the backup → 30 cycles an hour ≈ **330 an hour**; the fallback adds no extra backup requests (one backup request per refused primary request).
- **Cause of the rest:** the hour contained Deploy 37452453763, whose reconcile made one `eth_call` per read: 26 + 6 + 3 (+3 per vote round) per campaign, 4 per donor, 2 per vote, … — ~1,500 requests for dev's campaigns in ~48 s. 330 + ~1,500 ≈ the 1,943 seen. It also grows linearly with campaigns (10,000 campaigns ≈ 350,000 requests per deploy).
- **Fix:** `scripts/reconcile.ts` creates its client with `batch: { multicall: { deployless: true, batchSize: 4096 } }` and passes `concurrency: 128`; `lib/reconcile.ts` checks rows concurrently (`each()`, the limiter still bounds reads in flight) so the reads of many rows share one call, and sorts mismatches (table, key, field) because their order no longer follows the reads. The summary line now prints `rpc_requests=` (counted with viem's `onFetchRequest`, primary and backup) and `repeated_reads=`; a retry reason is printed once (an empty multicall answer repeats ~100 reads). JSON-RPC batches stay off (#127's reason).
- **First attempt failed:** `concurrency` 256 / `batchSize` 16,384 → `Details: max initcode size exceeded` — a deployless multicall is creation code (EIP-3860: 49,152 bytes) and 4-byte view calls take ~224 bytes each in the aggregate3 encoding, so the read count, not the calldata size, is the limit. 128 reads ≈ 38 KB at most.
- **Tests** (local, Anvil + Ponder + Postgres, `vitest run test/scenario.test.ts`):
  ```
  reconcile: schema=chain block=115 checked=461 rpc_requests=12 repeated_reads=0 mismatches: 0
  reconcile: read repeated in 1 s (Cannot decode zero data ("0x") with ABI parameters.)
  reconcile: schema=chain block=115 checked=461 rpc_requests=19 repeated_reads=128 mismatches: 0
  MISMATCH campaign 0xb2f3418042216b7e35be3e4744d1e06f2b3fa441 total_raised: indexed=1000000001 onchain=1000000000
  reconcile: schema=chain block=115 checked=461 rpc_requests=12 repeated_reads=0 mismatches: 1
   ✓ test/scenario.test.ts (14 tests) 32592ms
  ```
  New assertions: "zero mismatches" also requires `rpc_requests` ≤ 15 for the 461 checks; new test "an empty and a rate-limited multicall answer are repeated, not trusted" (a proxy answers the first `eth_call` with `"0x"`, the second with HTTP 429, then forwards to Anvil).
  `batch-scenario.test.ts` + `prune.test.ts`: `Tests  10 passed (10)`; `pnpm --filter indexer test`: `Tests  48 passed (48)`; lint and typecheck clean.
- **Deliberate breaks:**
  - multicall batching commented out → `reconcile: … checked=461 rpc_requests=403 … mismatches: 0` and `AssertionError: expected 403 to be less than or equal to 15`; restored.
  - `isRetryableRead` no longer repeating empty answers → the reconcile dies on `AbiDecodingZeroDataError` and the new test fails (`expected 2 to be greater than 2`); restored.
- **Expected on dev after the deploy:** the deploy log line `reconcile: … rpc_requests=<about 10–20> …` (a few more when Alchemy is capped: its refusals are counted too), and Infura at ~330 requests in an hour without a deploy.
- **Live on dev:** PR #129 merged by David (2026-10-06 12:01 UTC), Deploy 37460302512 green (schema `chain_9177277`).

## Follow-up 2026-10-06: ~36 eth_getLogs per idle cycle on Infura — one backfill range per cycle
- **Seen:** Infura dashboard, the hour 13:28–14:28 UTC without a deploy: **1,330 requests — `eth_getLogs` 1,081**, the rest `eth_getBlockByNumber`, `eth_blockNumber`, `eth_chainId`; bars of ~35–55 requests every 2 minutes (one per cycle). The local measurement above (11 per idle cycle) did not show it.
- **Dev log** (David, `docker logs --since 6m`, 15:08–15:10 UTC; shortened):
  ```
  15:08:11.821 INFO  Started backfill indexing chain=cherrio block_range=[49476699,49476818]
  15:08:11.823 INFO  Started fetching backfill JSON-RPC data chain=cherrio cached_block=49476699 cache_rate=100%
  15:08:13.654 WARN  All JSON-RPC providers are inactive action=fetch_block_data chain=cherrio
  … HttpRequestError: HTTP request failed. Status: 429 URL: https://polygon-amoy.infura.io/v3/*** … "fromBlock":"0x2f2f490","toBlock":"0x2f2f4b6" … Details: Too Many Requests
  … "fromBlock":"0x2f2f4b7","toBlock":"0x2f2f4d2" … Details: Too Many Requests
  15:08:20.669 INFO  Indexed block range chain=cherrio event_count=0 block_range=[49476791,49476818] (30ms)
  [indexer:batch] 2026-10-06T15:08:20.957Z indexed to block 49476818 in 16.7 s (9 campaigns)
  15:10:10.953 INFO  Detected crash recovery build_id=1cf9ac780c last_active=1m 59ss schema=chain_9177277
  15:10:11.811 INFO  Started backfill indexing chain=cherrio block_range=[49476818,49476939]
  … three more 429s on eth_getLogs …
  [indexer:batch] 2026-10-06T15:10:18.948Z indexed to block 49476939 in 14.7 s (9 campaigns)
  ```
  No history is re-read (`cache_rate=100%`, ~120 new blocks per cycle), but the requested ranges are 39 and 28 blocks wide.
- **Cause:** Ponder 0.17.12 `runtime/historical.js`: `let estimateRange = 25;`, then `estimate({ …, min: 25, maxIncrease: 1.5 })` — every backfill starts at 25 blocks and grows by 1.5× per interval. The batch runner starts a fresh `ponder start` per cycle, so ~120 blocks become 4–5 intervals × 3 filters = 12–15 `eth_getLogs` (+ the runner's scan), sent in bursts; Infura's free tier limits credits per second (`eth_getLogs` is the expensive call), answers 429 and every repeat is another request. Locally (15 blocks per cycle) a cycle fits in the first 25-block interval, so the measurement could not show it.
- **Fix:** a pnpm patch of Ponder (`patches/ponder@0.17.12.patch`, `patchedDependencies` in the root `package.json`, made with `pnpm patch` / `pnpm patch-commit`): `let estimateRange = Math.max(25, Number(process.env.PONDER_INITIAL_BLOCK_RANGE) || 25);` (dist and src). The runner passes `PONDER_INITIAL_BLOCK_RANGE = INDEXER_GETLOGS_RANGE` (10,000) to each `ponder start`; realtime mode never sets it. Dockerfile, Dockerfile.indexer and Dockerfile.worker copy `patches/` before `pnpm install` (pnpm needs the file); Dockerfile.indexer greps the installed Ponder for the patch and fails the build without it. `patches/` added to the indexer change filters (ci.yml, deploy.yml). `scripts/rpc-cost.ts`: mines in steps of 5,000 (one `anvil_mine` of 100,000 timed out), `SPIKE_RUNNER_LOG=<file>` keeps the runner's output.
- **Expected on dev:** per cycle 3 `eth_getLogs` from Ponder + 1 scan + ~2 `eth_getBlockByNumber` + `eth_blockNumber` + `eth_chainId`, fewer bursts → ~8–10 requests a cycle, ~250–300 an hour (instead of 1,330), `eth_getLogs` ~120 an hour.
- **Tests** (local):
  - `vitest run test/batch-scenario.test.ts`: `✓ … a cycle over hundreds of new blocks reads them in one range, not in growing small steps 4828ms`, `Tests  4 passed (4)`.
  - Deliberate break (runner without `PONDER_INITIAL_BLOCK_RANGE`): `AssertionError: 2091-2116 2117-2142 2143-2181 2182-2219 2220-2400 2220-2245 2246-2271 2272-2310 2311-2368 2369-2400 2401-2405: expected 11 to be less than or equal to 3`; restored.
  - `pnpm --filter indexer test`: `Tests  48 passed (48)`; lint and typecheck clean; `pnpm install --frozen-lockfile` clean with the patch.
- **Note for a Ponder upgrade:** the patch is tied to 0.17.12; re-create it (`pnpm patch ponder@<new>`) or drop it if Ponder gains an option for the start range.
- **Live on dev:** PR #130 merged 2026-10-06, Deploy 37489605961 green (web, indexer Build → Deploy → Ready → Reconcile → Prune, worker). The Infura count an hour after it is still to be read from the dashboard.

## Follow-up 2026-10-07: 538 Infura requests an hour — 429 retries; backup RPC paced
- **David's numbers** (one hour without a deploy, after PR #130): total **538** — `eth_getLogs` 320, `eth_getBlockByNumber` 156, `eth_chainId` 35, `eth_blockNumber` 27 (was 1,330 before #130; expected ~250). ~27 cycles an hour → ~12 `eth_getLogs` per cycle, while the local measurement (no rate limit) showed 4.
- **David's dev log** (`docker logs --since 6m`, 08:03–08:04 UTC): one 120-block `eth_getLogs` of the Campaign source (`fromBlock 0x2f3e253 … toBlock 0x2f3e2cb`) answered `Status: 429 … Too Many Requests` from Infura at `retry_count=4` … `retry_count=9`, `retry_delay` 1 s → 32 s, plus `All JSON-RPC providers are inactive` and `Fetching backfill JSON-RPC data is taking longer than expected … block_range=[49537619,49537739] (50s)`. So the extra requests are **Ponder repeating refused calls**: it sends its `eth_getLogs` together, Infura's per-second credit limit refuses them, and every repeat is billed.
- **Fix:** `lib/throttle.ts` — a token bucket (`INDEXER_RPC_FALLBACK_CREDITS_PER_SECOND`, default 400; Infura weights `eth_getLogs` 255, most others 80, `eth_chainId` 5) wrapped around the backup transport in `ponder.config.ts` only; one bucket shared by every client Ponder creates; requests wait, none is dropped. Pacing costs ~0.6 s per extra `eth_getLogs` per cycle — nothing against the 120 s interval. The primary (Alchemy) is not paced.
- **Expected on dev:** ~3–4 `eth_getLogs` per cycle instead of ~12 → roughly 250–300 requests an hour; check the Infura dashboard again an hour after the deploy without another deploy.
- **Not done on purpose:** a longer batch interval (would make donations show later), pacing the runner scan / reconcile (they already wait on 429 and are a few calls per cycle).

`pnpm --filter indexer test` (2026-10-07):
```
 Test Files  7 passed (7)
      Tests  53 passed (53)
```
Deliberate breaks (restored with the reverse `sed`, then `Tests  5 passed (5)`):
1. No waiting in the bucket: `× creditPacer > lets three eth_getLogs (255 credits) through at 400 credits/s spaced, in order` … `Tests  3 failed | 2 passed (5)`.
2. One bucket per client instead of one shared: `× paced transport > passes every request through, paced, and shares one bucket between clients` — `Tests  1 failed | 4 passed (5)`.
