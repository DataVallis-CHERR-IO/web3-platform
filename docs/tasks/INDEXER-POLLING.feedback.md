# Indexer fell behind the chain — polling interval (feedback)
Status: DONE

## What David saw (2026-10-04)
His sponsored donation (block 49272898, an EntryPoint `handleOps` transaction) did not appear on the campaign page after 15+ minutes; the raised amount stayed at 1.12 USDC while the campaign contract held 2.245 USDC.

## Diagnosis (outputs David pasted from the server)
- Indexer container `cherrio-indexer-dev-indexer-dev-sha-7c0241d`: `Up 13 hours (healthy)`, `174MiB / 384MiB` — not crashed, not out of memory.
- `/status`: `{"cherrio":{"id":80002,"block":{"number":49266134,"timestamp":1791088564}}}` → block time 04:36:04 UTC while the server clock was 06:54 UTC: **6,764 blocks (~2 h 20 min) behind**.
- Logs: one poll a minute, each indexing ~49 blocks (`06:54:43 … Indexed block number=49266086 … 49266134`), plus `WARN No new block received within expected time`.
- `reconcile: schema=chain block=49266134 checked=36 mismatches: 0` — the data is correct up to where the indexer is; it is just late.
- Ponder 0.17.12 `dist/esm/sync-realtime/index.js`: `const MAX_QUEUED_BLOCKS = 50;` — realtime fetches at most 50 missing blocks per poll. Amoy: 6,764 blocks in ~115 min ≈ 59 blocks/min. With the 60 s interval (PR #49, 2026-10-03) the indexer could follow ≤ 50 blocks/min and lost ~10 blocks/min since its last deploy (~12.5 h × 10 ≈ the observed gap).
- Not related to the smart account: the handler reads the campaign's `Donated` event, which is the same for a direct transaction and `handleOps`.

## What I changed
- `apps/indexer/lib/env.ts`: default polling **15 s**; allowed range **1–25 s** (was 1–300 s). A slower value stops the indexer at start.
- `apps/indexer/test/env.test.ts`: new default and bounds; a test that the default and the maximum can follow ~60 blocks/min at 50 blocks per poll.
- Docs: `03-data-and-indexer.md` §4.2 (polling row), `05-infrastructure-and-environments.md` (RPC row).
- The change touches `apps/indexer/**`, so the Deploy job redeploys the indexer: a new `chain_<sha7>` schema backfills with `eth_getLogs` ranges (fast, RPC cache in `ponder_sync`) and the `chain` views switch when it is ready — this also catches up the missing donation.

## Test results (this session)
```
$ pnpm exec vitest run test/env.test.ts
      Tests  10 passed (10)
```
Deliberate break — the old values (60 s default, 300 s max):
```
   × resolveIndexerEnv > polls every 15 s by default outside local, configurable within bounds 9ms
   × resolveIndexerEnv > can follow Amoy: 50 blocks per poll must cover ~60 blocks a minute with headroom 1ms
      Tests  2 failed | 8 passed (10)
```
Restored → `Tests  10 passed (10)`.
```
$ pnpm exec vitest run test/env.test.ts test/redact.test.ts test/prune.test.ts test/reconcile.test.ts test/delivered.test.ts
 Test Files  5 passed (5)
      Tests  33 passed (33)
$ pnpm --filter indexer lint / typecheck → ok
```
Scenario test on Anvil: run by CI ("Indexer scenario").

## Open questions / risks
- No alert yet when the indexer lags. Suggested follow-up: a lag check (indexed block time vs. now) in `/api/health` or a Prometheus rule, so a stall is seen before a donor reports it.

## Suggested commit message
fix(indexer): poll every 15 s so the indexer keeps up with Amoy
