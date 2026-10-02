# TASK-004 feedback
Status: DONE

## What I implemented
- **EmergencyPool.sol**: sub-pools (pool 0 = general, always exists), checkpointed contribution tracking via OZ `Checkpoints.Trace256` (block-number keyed, `upperLookup(proposalBlock - 1)` for vote-buying protection), `donate()` with minDonation gate, `receiveFromCampaign()` for campaign inflows (settleToPool / sweepUnclaimed), allocation proposal → voting → close → resolve lifecycle with ADR-008 cross-multiplication quorum/approval, try/catch delivery failure handling, `forceApprove` zeroing, permissionless `reclaimFromCampaign` for failed/rejected campaigns, `nonReentrant` on all state-changing external functions. `quorumBase == 0` → `NEEDS_REVIEW` (no votes cast = Guardian decides).
- **IEmergencyPool.sol**: minimal interface (`receiveFromCampaign`).
- **Campaign.sol changes**: `donateFromPool()` (pool-only, clips to remaining target, sets REFUND preference, nonReentrant), `poolDonated` storage, `closeVote()` quorum base = `totalRaised - poolDonated` (change B, fully pool-funded → always NEEDS_REVIEW), `_sendToPool()` now calls `IEmergencyPool.receiveFromCampaign()` with donor address (address(0) for sweeps = no contributor credit).
- **DeployAmoy.s.sol / DeployPolygon.s.sol**: deploy PlatformConfig → Campaign impl → CampaignFactory → EmergencyPool → TimelockController (48h, Safe proposer+executor), grant OPERATOR/GUARDIAN to Safe, grant DEFAULT_ADMIN to Timelock, renounce deployer admin. Chain ID guards (`require(block.chainid == ...)`). Writes `deployments/<chain>.json` with exact schema (address + startBlock per contract, deployedAt, commitSha, deployer).
- **deployments/index.ts**: updated schema with `ContractEntry`, `campaignImplementation`, `startBlock`, `deployer`, `blockNumber`.
- **README.md**: deploy + verify commands, deployments JSON schema documentation.
- **MockEmergencyPool.sol**: test mock implementing `IEmergencyPool` for Campaign unit/invariant tests.

## Files changed
- `src/EmergencyPool.sol` — new, core pool contract
- `src/IEmergencyPool.sol` — new, interface for Campaign → Pool communication
- `src/Campaign.sol` — added donateFromPool, poolDonated, quorum base change, _sendToPool wiring
- `script/DeployAmoy.s.sol` — new, Amoy deployment script with chain ID guard
- `script/DeployPolygon.s.sol` — new, Polygon mainnet deployment script with chain ID guard
- `deployments/index.ts` — updated schema types
- `README.md` — new, deploy/verify documentation
- `abis/export.sh` — added EmergencyPool
- `test/EmergencyPool.t.sol` — new, 43 tests (incl. quorumBase==0, reentrancy, allowance-zero)
- `test/Deploy.t.sol` — new, 14 deploy layout tests
- `test/Campaign.t.sol` — added donateFromPool/poolDonated tests, updated to MockEmergencyPool
- `test/CampaignFuzz.t.sol` — updated to MockEmergencyPool
- `test/invariant/CampaignHandler.sol` — updated to MockEmergencyPool
- `test/invariant/CampaignInvariant.t.sol` — updated to MockEmergencyPool
- `test/invariant/PoolHandler.sol` — new, handler for pool invariant suite
- `test/invariant/PoolInvariant.t.sol` — new, balance conservation + all-counters-positive
- `test/mocks/MockEmergencyPool.sol` — new, minimal mock

## Deviations from the task (and why)
- **Slither**: installed in `.venv-slither`, ran analysis. See findings below.

## Slither findings

**Command**: `source .venv-slither/bin/activate && slither src/ --solc-remaps "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/" --filter-paths "lib/|test/|script/"`

**Totals**: High 0 · Medium 4 · Low 14 · Informational 16

### Medium findings (4)

| # | Detector | Contract.function | Description | Fix / Justification |
|---|----------|-------------------|-------------|---------------------|
| 1 | `reentrancy-no-eth` | `EmergencyPool._deliverAllocation` | State (`a.state`) written after external call to `Campaign.donateFromPool` | False positive — `_deliverAllocation` is `internal` and only called from `closeAllocation` which is `nonReentrant`. Reentrancy is blocked at the caller level. |
| 2 | `reentrancy-no-eth` | `EmergencyPool._deliverAllocationResolve` | State (`a.state`) written after external call to `Campaign.donateFromPool` | False positive — `_deliverAllocationResolve` is `internal` and only called from `resolveAllocation` which is `nonReentrant`. Same reasoning as #1. |
| 3 | `unused-return` | `EmergencyPool._pushContributed` | Ignores return value of `donorCkpt.push(block.number, oldVal + amount)` | By design — OZ `Checkpoints.Trace256.push` returns `(uint256 oldValue, uint256 newValue)` which we don't need; the checkpoint is stored internally. |
| 4 | `unused-return` | `EmergencyPool._pushContributed` | Ignores return value of `totalCkpt.push(block.number, oldTotal + amount)` | Same as #3. |

### Low findings (14) — all `reentrancy-benign` or `timestamp`
- `reentrancy-benign` × 3: `_deliverAllocation`, `_deliverAllocationResolve`, `reclaimFromCampaign` — `poolBalance` written after external calls. All callers are `nonReentrant`; benign even if reached.
- `timestamp` × 11: Vote windows, deadlines, sweep delays all rely on `block.timestamp` comparisons. This is inherent to the design; miners have ±15s influence which is negligible for 24h+ vote windows and 180-day sweep delays.

### Informational findings (16) — all `naming-convention`
- Underscore-prefixed parameter names (`_config`, `_treasury`, etc.) in `Campaign.initialize` and `PlatformConfig` setters. This is our project convention for constructor/initializer params to avoid shadowing storage variables.

`.venv-slither` added to `.gitignore`.

## New dependencies
- none (all from existing OpenZeppelin v5)

## How to verify
1. `cd packages/contracts && forge fmt --check` — clean
2. `forge build` — clean (informational warnings only)
3. `forge test -vv` — 234/234 passing, 0 failed
4. `forge coverage --report summary` — all src/ files ≥95% lines
5. `forge snapshot` — written
6. `bash abis/export.sh && pnpm run typecheck` — pass

## Test results
- 234 tests, 0 failures, 0 skips
- Campaign invariant suite: 32,768 calls, 0 reverts, all 17 counters > 0
- Pool invariant suite: 32,768 calls, 0 reverts, balance conservation holds
- Pool deterministic test: all 14 execution counters > 0 (PASSED, REJECTED, NEEDS_REVIEW, RESOLVED_PASS, RESOLVED_REJECT, DELIVERY_FAILED, clipped delivery, receiveFromCampaign settle + sweep, reclaim from FAILED + REJECTED)
- Coverage:
  - Campaign.sol: 100.00% lines, 98.06% branches, 92.68% branch, 100.00% functions
  - EmergencyPool.sol: 98.52% lines, 95.15% stmts, 80.49% branches, 100.00% functions
  - CampaignFactory.sol: 100% all
  - PlatformConfig.sol: 100% all

## Open questions / risks
1. EmergencyPool's `reclaimFromCampaign` calls `Campaign.claimRefund()` which requires the pool address to be recorded as a donor. This works because `donateFromPool` records `donated[msg.sender] += actual`. If a campaign never received pool allocation, reclaimFromCampaign will revert with `NothingToRefund` — this is correct behavior.
2. The `poolDonated` adjustment to quorum base means campaigns with significant pool funding require fewer human votes for quorum. If `poolDonated == totalRaised`, closeVote always goes to NEEDS_REVIEW (Guardian decides).
3. **Risk: sweepUnclaimed before reclaimFromCampaign** — if nobody calls `reclaimFromCampaign` before `sweepUnclaimed`, the pool's unreclaimed share is swept to the general pool (pool 0) via `sweepUnclaimed` → `_sendToPool(address(0), ...)`, not to the original `fundingPool`. The funds still end up in the EmergencyPool but without contributor credit (donor=address(0)).
4. **quorumBase == 0** — when no pool contributors have voting weight for an allocation (e.g., all donations came after the proposal block), `closeAllocation` routes to `NEEDS_REVIEW` rather than auto-passing. This prevents zero-vote allocations from passing.

## Suggested commit message
feat(contracts): EmergencyPool, deploy scripts, Campaign pool integration (TASK-004)

## Correction (TASK-027, 2026-10-02)

This file is kept as written on the day of TASK-004. These statements are outdated:

- **Timelock delay:** 48 h applies to mainnet only (`DeployPolygon.s.sol`, no override). On Amoy the delay comes from env `TIMELOCK_DELAY`, default 300 s (ADR-025, DEPLOY-AMOY).
- **Chain guard:** the scripts revert with the custom error `WrongChain`, not `require(block.chainid == …)`.
- **Deployment file:** Amoy writes `deployments/amoy-<DEPLOY_NAME>.json`, mainnet writes `deployments/polygon.json`, and only on a real broadcast.
- **Open question 1:** there is no `NothingToRefund` error. `reclaimFromCampaign` on a campaign the pool never donated to reverts with `Campaign.NotDonor`.

Current truth: `packages/contracts/script/`, `packages/contracts/src/EmergencyPool.sol`, `docs/tasks/DEPLOY-AMOY.feedback.md` and `docs/technical/02-smart-contracts.md`.
