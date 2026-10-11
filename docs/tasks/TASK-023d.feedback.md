# TASK-023d feedback — timelock watcher (review M-02)
Status: PARTIAL — 023d-1 (indexer, PR #213) and 023d-2 (public page) built; 023d-3 (admin email) follows in its own PR.

Prompt: David 2026-10-11 ("Ja") to the proposed next step from HANDOFF — TASK-023 timelock watcher (M-02) without David.

## 023d-1 — indexer

### What I implemented
- The indexer indexes the TimelockController (`Timelock` in `ponder.config.ts`, address + start block from the deployment's `timelockController`; required — an indexer without it does not start).
- `src/timelock.ts`: `CallScheduled` (one per call of a batch) → `timelock_operation` (WAITING, `ready_at` = block time + delay) + `timelock_call`; `CallSalt` → `salt`; `CallExecuted` → EXECUTED; `Cancelled` → CANCELLED. An operation cancelled and scheduled again keeps its id; the row starts over.
- Reconcile compares every operation with `getTimestamp(id)`: `ready_at` (WAITING), 1 (EXECUTED), 0 (CANCELLED).
- Events only from a hand-written ABI subset (`lib/timelock-abi.ts`); `export.sh` only exports our own contracts.

### Files changed
- `apps/indexer/lib/timelock-abi.ts` — events + `getTimestamp`, `DONE_TIMESTAMP`.
- `apps/indexer/ponder.schema.ts` — `scheduled_change_state` enum, `timelock_operation`, `timelock_call`.
- `apps/indexer/src/timelock.ts` — handlers.
- `apps/indexer/ponder.config.ts`, `lib/env.ts` — the contract and its env entry.
- `apps/indexer/lib/reconcile.ts`, `scripts/reconcile.ts` — the `getTimestamp` check.
- `apps/indexer/test/env.test.ts`, `test/scenario.test.ts` — tests below.
- Docs: `docs/technical/03-data-and-indexer.md` (§4.2, §4.3, §4.4, §4.7), `docs/tasks/TASK-023-audit-preparation.md` (023d), `docs/tasks/README.md`.

### Deviations
- Column `op_id`, not `operation_id`: Ponder 0.17 refuses `operation`, `operation_id` and `checkpoint` ("reserved column name").
- Enum type `scheduled_change_state`, not `timelock_operation_state`: Ponder 0.17's SQL generator treats a type name starting with a native type name (`time…`) as native and leaves out the schema, so the migration failed with `error: type "timelock_operation_state" does not exist` (seen in this session; found by generating the SQL with Ponder's `getSql`: the column was written as `"state" timelock_operation_state` while the other enums were `"chain_x"."campaign_state"`).

### Scenario (Anvil + Ponder + Postgres)
- Phase 1 (backfill): batch A — two PlatformConfig calls (`setTreasury` and `setEmergencyPool` with today's values, harmless) with a salt, executed after the 48-hour delay; operation B — one call `setEmergencyPool(d3)`, salt zero, cancelled.
- Phase 2 (realtime): B scheduled again with the same id → WAITING again.
- Expected rows: `timelock_operation` 2, `timelock_call` 3.

### Test results (this session, 2026-10-11)
- `pnpm --filter indexer typecheck` / `lint`: clean.
- `pnpm --filter indexer test`: `Test Files  7 passed (7)`, `Tests  54 passed (54)` (53 before + "throws when the deployment has no timelock").
- Scenario `vitest run test/scenario.test.ts`: `✓ test/scenario.test.ts (16 tests) 37626ms`, `Tests  16 passed (16)`; reconcile line `reconcile: schema=chain block=120 checked=477 rpc_requests=13 repeated_reads=0 mismatches: 0`; new test output:
  `MISMATCH timelock_operation 0xa8d46b5b791c8edae38912f7772e1c44e4fbfbb235ab6e8b2404c426522cfa2b getTimestamp: indexed=0 onchain=1809888192` / `mismatches: 1` (the corrupted row is caught).

### Deliberate break
- `src/timelock.ts`: re-scheduling with `.onConflictDoNothing()` instead of `.onConflictDoUpdate(scheduled)` (a cancelled operation would stay CANCELLED after it is scheduled again). Result: `Tests  4 failed | 12 passed (16)` — "timelock: batch with salt executed, cancelled operation scheduled again" failed and reconcile printed `MISMATCH timelock_operation 0xa8d4…fa2b getTimestamp: indexed=0 onchain=1809888240` / `mismatches: 1`. Restored with the reverse `sed`; 16/16 again above.

### Open questions / risks
- The first dev deploy re-indexes into a new schema anyway (every code change does, ADR-026); the timelock adds one address from block 49,017,092 (about 100 extra `eth_getLogs` ranges of 10,000 blocks, cached in `ponder_sync` afterwards).
- When David redeploys Amoy-dev (ADR-061), the switch PR brings the new timelock address with the rest.

### Suggested commit message
feat(indexer): index TimelockController operations for the timelock watcher (TASK-023d-1)

## 023d-2 — public page, notices

### What I implemented
- `lib/contracts/scheduled.ts`: `describeCall` (PlatformConfig setters through the console's `decodeSetter`; `grantRole` / `revokeRole` with role names; `updateDelay`; anything else stays "unknown" with selector and target — also a known setter sent to another contract, or one with an out-of-bounds value), `callRisk` / `worstRisk` (money > roles > unknown > setting; a delay change counts as roles), `changePhase`, `loadScheduledChanges` (newest 50, or every WAITING one with `pendingOnly`; null while the views are missing), `pendingMoneyChanges`.
- Public page `/en/contract-changes` (server-rendered, no JavaScript needed): state chip, risk chip, every call in words with the console's units, times, transaction links, "Scheduled from". Footer link "Contract changes", sitemap, `llms.txt`.
- Emergency Pool page: a notice with a link to the newest waiting/ready change of where pool money goes.
- Admin → Contracts: "N waiting changes on the timelock were not scheduled from this console" (after `requireRole`).
- Owner guide **v1.14** (§1, §6 "A change you did not schedule here"; PDF rebuilt, 21 pages), donors guide, technical 04, 06, 09.

### Files changed
- `apps/web/src/lib/contracts/scheduled.ts`, `apps/web/src/app/[locale]/contract-changes/page.tsx` (new).
- `apps/web/src/app/[locale]/emergency-pool/page.tsx`, `apps/web/src/app/[locale]/admin/contracts/page.tsx`, `apps/web/src/components/AppFooter.tsx`, `apps/web/src/lib/seo/sitemap.ts`, `apps/web/src/lib/seo/llms.ts`, `apps/web/messages/en.json`.
- Tests: `apps/web/src/__tests__/scheduled-changes.test.ts` (9), fake chain tables `chain.timelock_operation` / `timelock_call` in `src/__tests__/helpers/fake-chain.ts`, `apps/web/e2e/contract-changes.spec.ts` (2 × 2 projects).
- Docs: owner guide + README change log + PDF v1.14 (v1.13 removed), `docs/guides/donors.md`, `docs/technical/04`, `06`, `09`, spec, tasks README.

### Deviations
- Values before a change ("from") are not shown on the public page: the indexer has only the new value; the console's record keeps the old one for changes made there. Left out on purpose — the current value is on Admin → Contracts and on the block explorer.
- No email yet (023d-3).

### Test results (this session, 2026-10-11)
- `pnpm --filter web test`: `Test Files  78 passed (78)`, `Tests  623 passed (623)` (614 at the start of the session + 9).
- `pnpm --filter web typecheck`, `lint`: clean. `pnpm check:design`: "Design check passed — no violations found."
- `pnpm build`: exit 0.
- E2E `contract-changes.spec.ts` + `emergency-pool.spec.ts` + `contract-console.spec.ts`: first run 2 failed / 20 passed (my spec looked for the chip text "Waiting" exactly — the chip renders "○Waiting"), second run axe failed with JavaScript disabled (axe needs it: moved to a normal page), then `contract-changes.spec.ts` `4 passed (14.3s)`; the other two specs passed (20) in the earlier run.
- Screenshots 1440 and 390 (temporary spec, not committed): card, risk chip and the long address wrap; the Emergency Pool notice sits under the intro.

### Deliberate break
- `MONEY_KEYS = ["treasury"]` (Emergency Pool address no longer a money change): `Tests  3 failed | 6 passed (9)` — `expected 'setting' to be 'money'`, the list's risks differ, and the Emergency Pool notice list is `[]` instead of the waiting change. Restored with the reverse `sed`: `Tests  9 passed (9)`.

