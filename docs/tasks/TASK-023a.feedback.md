# TASK-023a feedback — smart-contract security review (PDF) + Slither in CI
Status: DONE — Built (PR pending)

## What I implemented
- **Security review report** `docs/audit/SMART-CONTRACT-SECURITY-REVIEW.md`, published as a 28-page PDF `docs/audit/dist/CHERR.IO-Smart-Contract-Security-Review-v1.0.pdf` (same design as the whitepaper and owner guide; new script `npm run audit-report` in `docs/whitepaper`).
  - Scope: commit `a70d53d`, five files, with nSLOC and SHA-256 prefixes.
  - Contents: method, money flows, roles and trust model, severity scale, 18 findings (0 Critical, 0 High, 2 Medium, 6 Low, 10 Informational), Slither triage, tests and coverage, property checklist, centralisation, mainnet checklist, commands to reproduce, access-control matrix.
  - Labelled clearly as an **internal, AI-assisted review, not an independent audit**.
- **Evidence tests** `packages/contracts/test/audit/ReviewFindings.t.sol` (6 tests): L-01 (both the sweep path and the reclaim path), L-02, L-06, I-01, I-10 (gas-griefing sweep).
- **Slither in CI:** `actions/setup-python` + `slither-analyzer==0.11.6` + `slither . --config-file slither.config.json --fail-high` in the "Smart Contracts (Foundry)" job; `packages/contracts/slither.config.json`.
- Spec `docs/tasks/TASK-023-audit-preparation.md` (023a/b/c).
- Docs updated: technical 02, 06, 07, 09 and 10 (investor FAQ Q24), Architecture §6, prod-launch runbook 0.5, tasks README.
- TASK-014c-3 labels flipped to Live on dev.

## Findings in short
- **M-01:** one Safe holds Operator, Guardian and timelock proposer/executor (`DeployPolygon.s.sol`).
- **M-02:** `emergencyPool` and `treasury` are read live, so the timelock can redirect future pool and fee flows.
- **L-01:** sub-pool money in a failed campaign returns to the general pool if the campaign is swept before it is reclaimed.
- **L-02:** a campaign stays bound to the sub-pool of its first proposal, even if that proposal was rejected.
- **L-03:** the whole fee is paid with the first milestone and is not refunded after a rejection.
- **L-04:** a USDC-blacklisted beneficiary or treasury blocks payouts until the Guardian steps in.
- **L-05:** a donor's last donation sets the failure preference for all of their money in the campaign.
- **L-06:** freezing a live campaign does not extend its deadline.
- **I-01 … I-10:** informational; the details are in the report.
- No contract code changed: the recommended fixes are one batch before mainnet (023c, David decides).

## Deviations from the task (and why)
- The report is not an external audit. It cannot be one: the external audit stays on the checklist and needs a budget.
- The Amoy bytecode was not compared with the commit (Polygonscan is unreachable from the sandbox). This is written in the report and on the checklist.

## New dependencies
- CI only: `slither-analyzer==0.11.6` (pip, in the CI job; not a package dependency).

## How to verify
1. Open the PDF in `docs/audit/dist/`.
2. In `packages/contracts`, run `forge test --match-path test/audit/ReviewFindings.t.sol -vv`. Expect 6 passed.
3. Run `slither . --config-file slither.config.json --fail-high`. Expect exit 0 and 34 results.

## Test results
`forge test` (all suites): `Ran 10 test suites in 28.30s (46.58s CPU time): 260 tests passed, 0 failed, 0 skipped (260 total tests)`. The new suite alone:
```
Ran 6 tests for test/audit/ReviewFindings.t.sol:ReviewFindingsTest
[PASS] test_I01_unknownAllocationReadsAsVotingAndPanicsOnClose() (gas: 36069)
[PASS] test_I10_limitedGasCannotForceDeliveryFailed() (gas: 21732452)
[PASS] test_L01_reclaimBeforeSweepCreditsTheSubpool() (gas: 981439)
[PASS] test_L01_sweepSendsSubpoolMoneyToGeneralPool() (gas: 997819)
[PASS] test_L02_fundingPoolBindingSurvivesRejectedProposal() (gas: 968549)
[PASS] test_L06_freezeDoesNotExtendLiveDeadline() (gas: 359947)
Suite result: ok. 6 passed; 0 failed; 0 skipped
```
Deliberate break: `_deliverAllocation` was changed to cap the inner call at 20,000 gas when gas is low.
```
[FAIL: a gas-limited close must not end in DELIVERY_FAILED: 6 != 1] test_I10_limitedGasCannotForceDeliveryFailed()
```
Restored (`git diff --stat src/` empty), and the test passed again.

Coverage (`forge coverage --ir-minimum`): lines 98.19 %, statements 96.61 %, branches 90.07 %, functions 100 %. This is a lower bound, because IR source maps show zero hits on lines that tests do cover.

Slither:
- `. analyzed (25 contracts with 102 detectors), 34 result(s) found`: High 0, Medium 4, Low 14, Informational 16;
- `--fail-high`: exit 0;
- `--fail-medium`: exit 255 (the CI gate can fail).

Also passed: `forge fmt --check` (exit 0) and `actionlint .github/workflows/ci.yml` (no output).

## Open questions / risks (for David)
- **Contract batch before mainnet** (L-01, L-02, L-06, I-01, I-07): yes or no? It means a redeploy on Amoy.
- **L-03 fee rule:** charge the fee per tranche, or keep it and state it?
- **M-01:** three Safes (Operator, Guardian, timelock) with separate signers?
- **External audit:** budget and choice of firm.

## Suggested commit message
docs(audit): smart-contract security review PDF, evidence tests, Slither in CI (TASK-023a)
