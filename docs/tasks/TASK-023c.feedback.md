# TASK-023c feedback — security-review contract batch, fee per tranche, three Safes
Status: DONE — Built (PR pending). The Amoy contracts change only after David redeploys them (see "Next for David").

Decision: David, 2026-10-10: "vse se strinjam s ta bo in potrjujem". He approved all three: (1) the contract batch, (2) A, fee per tranche, (3) three Safes. Recorded as **ADR-061**.

## What I implemented
**Contracts** (`packages/contracts/src`):
- **L-01** `Campaign.sweepUnclaimed`: the Emergency Pool's own unreclaimed share goes to the pool first. It is the full donation in a FAILED campaign and the pro-rata share in a REJECTED one, sent with `donor = pool`. `EmergencyPool.receiveFromCampaign` credits that to `fundingPool[campaign]` without voting weight and emits `ReclaimedFromCampaign`. The rest is swept to pool 0 as before. `settled[pool]` prevents double counting after a reclaim.
- **L-02** `EmergencyPool`: `hasFundingPool` / `fundingPool` are set only on delivery (PASSED or RESOLVED_PASS, `_bindFundingPool`). While proposals are open, the new `reservedPool` / `openAllocations` mappings stop another sub-pool from proposing to the same campaign. Every final state releases the reservation (`_closeOpen`); NEEDS_REVIEW keeps it.
- **L-03** `Campaign._releaseNextTranche`: each tranche pays a third of the fee, and T3 absorbs the dust of both the net amount and the fee. A rejection after T1 or T2 refunds the unpaid fee to donors.
- **L-06** `Campaign.resolve(true)` on a campaign frozen while LIVE: `deadline += frozenDuration`.
- **I-01**: new error `AllocationDoesNotExist` in `getAllocation`, `voteAllocation`, `closeAllocation` and `resolveAllocation`.
- **I-07**: `PlatformConfig.MAX_MIN_DONATION = 1000e6`, enforced by the new `MinDonationTooHigh` revert.
- **M-01** `script/DeployPolygon.s.sol`: three Safes, `OPERATOR_SAFE`, `GUARDIAN_SAFE` and `TIMELOCK_SAFE`. Each must be a contract, and the new `SafesMustDiffer` revert refuses a shared one. `run()` returns the deployed contracts so the tests can check the real role layout. `DeployAmoy` keeps `SAFE_ADDRESS`, one testnet wallet.

**Tests:**
- 11 old assertions failed on the new code, as expected. They are updated to the new rules:
  - unit tests (fee thirds, refund remainders);
  - the `testFuzz_trancheMath` fuzz test, which now checks fee thirds that sum to the whole fee;
  - the invariant handler, which now has ghost fees per tranche.
- `test/audit/ReviewFindings.t.sol` has 10 tests that pin the fixed behaviour.
- `Deploy.t.sol` has its three-Safe mirror and one sequential `test_DeployPolygon_guards`, because `vm.setEnv` is shared by parallel tests.

**ABIs:** re-exported with `pnpm run export-abis`.

**Indexer:** `funding_pool_id` is set on delivery (AllocationClosed PASSED, AllocationResolved RESOLVED_PASS) instead of on proposal. The scenario expectations are updated for fee thirds and binding on delivery.

**Web:** Admin → Contracts caps the minimum donation at 1,000 USDC. The campaign page "protection" text for milestones and Terms §5 now describe the fee per payment.

**Docs:**
- ADR-061, technical 02 and 09, Product Spec fee line, fundraisers guide;
- owner guide **v1.13** with the PDF rebuilt, prod-launch runbook (B.3 three Safes, C.2 env), contracts README;
- security review **v1.1** (29 pages, resolutions for each finding; PDF v1.0 replaced by v1.1);
- tasks README, TASK-023 spec; TASK-023a labels flipped to Live on dev.

## Deviations from the task (and why)
- L-06: no 90-day cap on the deadline extension. The campaign does not store its start time, and the extension equals the time the Guardian kept the campaign frozen. The report says so.
- M-01: the optional contract-level rule (a minimum turnout for Guardian approval of pool allocations) is **not** added. Three Safes already address the risk, and the rule would change the product rule of ADR-045.
- The indexer scenario covers the reclaim path, not the new sweep-with-pool-share path. That path is covered by Foundry (`test_L01_*`); the indexer handler (`ReclaimedFromCampaign`) is unchanged.

## New dependencies
- none

## How to verify
1. `cd packages/contracts && forge test` → 261 passed; `forge test --match-path test/audit/ReviewFindings.t.sol -vv` → 10 passed.
2. `slither . --config-file slither.config.json` → 34 results, 0 High.
3. Open `docs/audit/dist/CHERR.IO-Smart-Contract-Security-Review-v1.1.pdf` (findings table: Fixed / Open).
4. After the Amoy redeploy, test on dev:
   - a 3-step campaign pays 1/3 of the fee with T1;
   - a rejected proposal does not block another sub-pool;
   - Admin → Contracts refuses a minimum donation of 1,001 USDC.

## Test results
Before the test updates, the new code failed 11 assertions of the old suite:
```
[FAIL: TrancheReleased param mismatch at fee: expected=10000000 [1e7], got=3333333 [3.333e6]] test_milestones_T1_correct()
[FAIL: wrong remainder: 666666667 != 660000000] test_rejected_claimRefund_proRata()
[FAIL: AllocationDoesNotExist()] test_I01_unknownAllocationReadsAsVotingAndPanicsOnClose()
[FAIL: the sub-pool does not get its 50 USDC back: 500000000 != 450000000] test_L01_sweepSendsSubpoolMoneyToGeneralPool()
[FAIL: ghost_feePaid mismatch: 9990210 != 3330070]
Ran 10 test suites …: 249 tests passed, 11 failed, 0 skipped (260 total tests)
```
After the updates: `Ran 10 test suites in 27.69s (46.17s CPU time): 261 tests passed, 0 failed, 0 skipped (261 total tests)`. That includes all invariants (256 runs × 128 depth) and fuzz tests (1,000 runs).

Deliberate break, with the L-01 fix undone (`donor = address(0)` for the pool's share):
```
[FAIL: 100 USDC back to the funding sub-pool: 400000000 != 500000000] test_L01_sweepOfRejectedCampaignReturnsProRataShare()
[FAIL: the funding sub-pool gets its 50 USDC back: 450000000 != 500000000] test_L01_sweepReturnsPoolMoneyToFundingSubpool()
```
Restored afterwards.

Deploy tests: `Suite result: ok. 18 passed` three runs in a row.

Coverage (`--ir-minimum`, lower bound): lines 98.33 %, statements 96.71 %, branches 90.13 %, functions 100 %.

Slither:
- one new `uninitialized-local` appeared during the work and was fixed;
- the final run: `. analyzed (25 contracts with 102 detectors), 34 result(s) found` (High 0, Medium 4, Low 14, Info 16);
- `--fail-high` exit 0.

`forge fmt --check` passes.

Indexer:
- `pnpm test`: `Tests  53 passed (53)`;
- scenario + prune + batch-scenario: `Test Files  3 passed (3)`, `Tests  25 passed (25)`;
- typecheck and lint clean.

Web:
- `pnpm test`: `Test Files  77 passed (77)`, `Tests  614 passed (614)`;
- `contract-config-params` covers 1,000 USDC → ok and 1,000.000001 → `above_max`;
- typecheck and lint clean.

## Next for David (needs you)
1. **Redeploy Amoy-dev**, same procedure as before: technical 02 §9 "Deploy procedure", from `packages/contracts` on `dev` after this PR is merged. The env stays the same (`SAFE_ADDRESS` = the testnet wallet, `DEPLOY_NAME=dev`, `TIMELOCK_DELAY=300`). The script writes `deployments/amoy-dev.json`.
2. Send me the content of `deployments/amoy-dev.json`. It contains only public addresses and block numbers. I will open the PR that switches the web app and the indexer to the new contracts; the indexer re-indexes from the new start block.
3. After the switch, on dev:
   - create sub-pools 1–4 again (Admin → Emergency Pool → "Create on the blockchain");
   - publish the demo campaigns again (Admin → Demo campaigns);
   - campaigns on the old contracts disappear from the lists, which is acceptable on the test network.
4. Mainnet, later: create the three Safes (Operator, Guardian, Timelock) with different signers (runbook B.3).

## Open questions / risks
- Old dev campaigns and test donations stay on the old Amoy contracts. Nothing is lost, but they are no longer shown once the indexer follows the new factory.
- The external audit (budget) should review this v1.1 code.

## Suggested commit message
feat(contracts): security-review batch — sweep to funding sub-pool, bind on delivery, fee per tranche, unfreeze extends deadline, named errors, three mainnet Safes (TASK-023c, ADR-061)
