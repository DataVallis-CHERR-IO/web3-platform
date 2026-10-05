# TASK-048 — Indexer batch mode (RPC cost)

Status: Built (PR pending) · Owner: cloud session (CTO + implementer) · Requested by David, 2026-10-05 (Alchemy usage limit hit; "ja, se strinjam s tabo, uredi") · ADR-055
Depends on: TASK-006 (Ponder indexer), TASK-026 (indexer deploy), ADR-026 (per-deploy schemas).

## Why
On 5 Oct Alchemy stopped serving at David's 19 M CU monthly limit with almost no campaigns and one user. His charts: `eth_getLogs` 64–65 %, `eth_getBlockByNumber` 34 %. Ponder's realtime sync costs per block (~70–80 CU measured), ~3.5–4.5 M CU a day per indexer on Amoy.

## Scope
1. `INDEXER_MODE=realtime|batch` (container CMD switch; unknown values stop the container). Realtime is unchanged and stays the default (prod).
2. `scripts/batch.ts` runner (bundled to `dist/batch.mjs`): cycle = head − finality → `ponder start` with `INDEXER_END_BLOCK` + `PONDER_EXPERIMENTAL_DB=platform` → wait for the end block → stop → release the schema lock → sleep `INDEXER_BATCH_INTERVAL_SECONDS` (default 120). Serves /health, /ready, /status on 42069.
3. `INDEXER_END_BLOCK` in `lib/env.ts` / `ponder.config.ts` (all three contracts).
4. dev: `INDEXER_MODE=batch`, 120 s in `config/indexer.dev.yml`.
5. Tests: unit (`test/batch.test.ts`), scenario (`test/batch-scenario.test.ts`, CI "Indexer scenario"); measuring tool `scripts/rpc-cost.ts`.
6. Docs: ADR-055, technical 03 §4.2/§4.13, 05, 09, this spec, feedback, HANDOFF.

## Out of scope
Prod in batch mode (one env var later if wanted), replacing Ponder (webhooks, HyperSync), a free public RPC.
