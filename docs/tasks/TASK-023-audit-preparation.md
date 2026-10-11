# TASK-023 — Audit preparation, Slither, mainnet runbook

Status: In progress. 023a live on dev (PR #209). 023c contract batch merged 2026-10-10 (PR #210, #211; ADR-061, David: "vse se strinjam … in potrjujem"). Decision: David, 2026-10-10: "pri tasku TASK-023 želim obsežno audit poročilo smart contractov v pdf".
Depends on: all contract tasks (002–004, 046), `docs/runbooks/prod-launch.md`, Architecture §6.

## Parts
### 023a — security review report + Slither in CI
- An internal security review of `packages/contracts/src` with:
  - manual review;
  - Slither, every result triaged;
  - test and coverage figures;
  - a property checklist;
  - the trust model;
  - findings with severities and recommendations;
  - a mainnet checklist.
- Source: `docs/audit/SMART-CONTRACT-SECURITY-REVIEW.md`. PDF: `docs/audit/dist/`, built with `cd docs/whitepaper && npm run audit-report`.
- Evidence tests `packages/contracts/test/audit/ReviewFindings.t.sol`: each finding that can be shown in code has a test that pins today's behaviour.
- CI: Slither 0.11.6 in the contracts job, failing on High (`slither.config.json`).
- The report says clearly that it is internal and AI-assisted, **not** an independent audit.

### 023b — Safe proposal flow (mainnet)
- Publishing a campaign, the payout mode, the Guardian decisions and the pool actions create Safe transactions when the role belongs to a Safe (the Safe Transaction Service API, or a Transaction Builder JSON). Planned.

### 023c — mainnet runbook and contract batch
- **Built (ADR-061):** the contract batch L-01, L-02, L-06, I-01, I-07, plus L-03 fee per tranche and three Safes in `DeployPolygon.s.sol` (M-01). Tests, indexer, Admin → Contracts bound, terms text and docs are updated; the report is now v1.1. Next: David redeploys Amoy-dev.
- Separate Safes (M-01), a timelock watcher (M-02 → 023d), prompt reclaims (L-01), the USDC-blacklist screen (L-04), bytecode verification, indexer finality on Polygon. Planned.
- External audit by a firm: budget (David).

### 023d — timelock watcher (review M-02)
Goal: no change to PlatformConfig (Emergency Pool address, treasury, fees, roles, the timelock delay) can take effect without being public and without the admins being told, whoever scheduled it — the admin console or anything else holding the proposer role.
- **023d-1 indexer** (Built, PR pending): the indexer reads the TimelockController's `CallScheduled`, `CallSalt`, `CallExecuted` and `Cancelled` into `chain.timelock_operation` + `chain.timelock_call`. Reconcile compares every operation with `getTimestamp(id)` (ready time / done / unset).
- **023d-2 web** (Planned): a public page listing every scheduled operation in plain words (decoded setter, old → new where known, ready time, state); calls that redirect money (`setEmergencyPool`, `setTreasury`) or change roles are marked; a notice on the Emergency Pool page while such a change waits. Admin → Contracts marks operations that were not scheduled from the console.
- **023d-3 worker** (Planned): one email to every admin per newly scheduled operation, once (a watermark row per operation id).
- Left out on purpose: `RoleGranted` / `RoleRevoked` of PlatformConfig itself (only the timelock holds `DEFAULT_ADMIN_ROLE`, so every role change is a timelock call first); Telegram/SMS alerts; restricting `setEmergencyPool` on chain (a contract change, mainnet checklist).

## Not in scope
- Fixing contract findings in 023a. The contracts are non-upgradeable, so fixes ship as one reviewed batch (023c).
