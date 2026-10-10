# TASK-023 — Audit preparation, Slither, mainnet runbook

Status: In progress. 023a was built 2026-10-10 (PR pending). Decision: David, 2026-10-10: "pri tasku TASK-023 želim obsežno audit poročilo smart contractov v pdf".
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
- Decide and implement the contract batch from the review §10 (L-01, L-02, L-06, I-01, I-07) together with its tests, then redeploy on Amoy. Needs David's decision.
- Separate Safes (M-01), a timelock watcher (M-02), prompt reclaims (L-01), the USDC-blacklist screen (L-04), bytecode verification, indexer finality on Polygon. Planned.
- External audit by a firm: budget (David).

## Not in scope
- Fixing contract findings in 023a. The contracts are non-upgradeable, so fixes ship as one reviewed batch (023c).
