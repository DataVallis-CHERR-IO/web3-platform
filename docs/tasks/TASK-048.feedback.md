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
