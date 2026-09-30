# TASK-002 feedback
Status: DONE

## What I implemented

- **`PlatformConfig.sol`** — AccessControl contract holding all platform-wide parameters with strict bounds validation. Roles: `DEFAULT_ADMIN_ROLE` (future 48h Timelock), `OPERATOR_ROLE` (backend hot wallet), `GUARDIAN_ROLE` (pause/freeze in TASK-003). Updatable `emergencyPool` emits `EmergencyPoolUpdated(old, new)`.
- **`CampaignFactory.sol`** — `OPERATOR_ROLE`-gated factory deploying deterministic EIP-1167 minimal proxy clones via `Clones.cloneDeterministic(impl, offchainId)`. Exposes `predictCampaignAddress(offchainId)` and `isCampaign(address)`. Snapshots live config values to the clone upon initialization.
- **`Campaign.sol`** — Per-campaign USDC escrow clone (`Initializable`, `ReentrancyGuard`). Implements `donate` with donation clipping to target, donor preference switching, `finalize` (threshold-based), `setPayoutMode` (mode 0 = SINGLE, mode 1 = MILESTONES; INDIVIDUAL barred from SINGLE), `release` for SINGLE payout (SUCCEEDED → COMPLETED in one atomic tx with fee transfer to treasury), pull-based `claimRefund`, push/pull `settleToPool`, and `sweepUnclaimed` after sweep delay. No USDC can ever be transferred to any address other than beneficiary, treasury, donor, or emergencyPool.
- **ABI Export Pipeline** — `abis/export.sh` extracts ABI JSONs from forge build artifacts and generates `abis/index.ts` with inlined `as const` type assertions for typed viem consumption (`pnpm run export-abis`, `pnpm run typecheck`).

### Review round 1 enhancements

1. **ABI Export (`abis/export.sh`, `abis/index.ts`, `package.json`, `tsconfig.json`)**: Configured automatic ABI extraction from build artifacts into JSON files and `abis/index.ts` with inlined `as const` exports; `pnpm run export-abis` and `pnpm run typecheck` pass cleanly.
2. **CampaignFactory Validation**: Added `beneficiaryType > 1` validation (`revert InvalidBeneficiaryType()`) and unit test `test_createCampaign_invalidBeneficiaryType_reverts`.
3. **PlatformConfig Bounds**: Added boundary validations and custom errors:
   - `successThresholdBps`: `1..10_000` (`_bps == 0 || _bps > 10_000` → `SuccessThresholdOutOfRange`)
   - `quorumBps`: `1..10_000` (`_quorumBps == 0 || _quorumBps > 10_000` → `QuorumOutOfRange`)
   - `approvalBps`: `5001..10_000` (`_approvalBps < 5001 || _approvalBps > 10_000` → `ApprovalTooLow`)
   - `refundSweepDelay`: `30 days..365 days` (`_delay < 30 days || _delay > 365 days` → `RefundSweepDelayOutOfRange`)
   - `minDonation`: `> 0` (`_minDonation == 0` → `MinDonationZero`)
   - Added 20 unit tests in `test/PlatformConfig.t.sol` covering all boundaries.
4. **Reentrancy Guard Selectors**: Updated tests (`test_reentrancy_claimRefund_blocked` and new `test_reentrancy_release_blocked`) to assert `ReentrancyGuard.ReentrancyGuardReentrantCall.selector`.
5. **Invariant Suite Enhancements**:
   - Added `handler_sweepUnclaimed` to `CampaignHandler` and registered its selector in targeted handler calls in `CampaignInvariant.t.sol`.
   - Added `invariant_owedEqualsBalance`: verifies that when `state == FAILED && !swept`, the sum of `donated[d]` for all untruncated handler actors where `!settled[d]` strictly equals `usdc.balanceOf(campaign)`.
   - Added actor and execution tracking in handler verifying non-zero executions across all flows.

### Events table

| Contract | Event | Fields |
|---|---|---|
| PlatformConfig | `TreasuryUpdated` | `address indexed oldTreasury`, `address indexed newTreasury` |
| PlatformConfig | `EmergencyPoolUpdated` | `address indexed oldPool`, `address indexed newPool` |
| PlatformConfig | `FeeBpsUpdated` | `uint16 oldBps`, `uint16 newBps` |
| PlatformConfig | `SuccessThresholdBpsUpdated` | `uint16 oldBps`, `uint16 newBps` |
| PlatformConfig | `VoteWindowUpdated` | `uint32 oldWindow`, `uint32 newWindow` |
| PlatformConfig | `QuorumBpsUpdated` | `uint16 oldBps`, `uint16 newBps` |
| PlatformConfig | `ApprovalBpsUpdated` | `uint16 oldBps`, `uint16 newBps` |
| PlatformConfig | `RefundSweepDelayUpdated` | `uint32 oldDelay`, `uint32 newDelay` |
| PlatformConfig | `MinDonationUpdated` | `uint256 oldMin`, `uint256 newMin` |
| CampaignFactory | `CampaignCreated` | `address indexed campaign`, `bytes32 indexed offchainId`, `address indexed beneficiary`, `uint256 target`, `uint64 deadline`, `uint8 beneficiaryType` |
| Campaign | `Donated` | `address indexed donor`, `uint256 amount`, `uint8 preference`, `uint32 subPoolId` |
| Campaign | `PreferenceSet` | `address indexed donor`, `uint8 preference`, `uint32 subPoolId` |
| Campaign | `Finalized` | `CampaignState indexed newState` |
| Campaign | `PayoutModeSet` | `uint8 mode` |
| Campaign | `TrancheReleased` | `address indexed beneficiary`, `uint256 amount`, `uint256 fee` |
| Campaign | `Refunded` | `address indexed donor`, `uint256 amount` |
| Campaign | `SentToPool` | `address indexed donor`, `uint256 amount`, `uint32 subPoolId` |
| Campaign | `Swept` | `uint256 amount` |

### Custom errors list

| Contract | Error | Trigger |
|---|---|---|
| PlatformConfig | `ZeroAddress()` | Address parameter is `address(0)` |
| PlatformConfig | `FeeTooHigh()` | `_feeBps > 500` (MAX_FEE_BPS = 5%) |
| PlatformConfig | `VoteWindowOutOfRange()` | `_voteWindow < 1 hours` or `> 14 days` |
| PlatformConfig | `SuccessThresholdOutOfRange()` | `_bps == 0` or `> 10000` |
| PlatformConfig | `QuorumOutOfRange()` | `_quorumBps == 0` or `> 10000` |
| PlatformConfig | `ApprovalTooLow()` | `_approvalBps < 5001` or `> 10000` |
| PlatformConfig | `RefundSweepDelayOutOfRange()` | `_delay < 30 days` or `> 365 days` |
| PlatformConfig | `MinDonationZero()` | `_minDonation == 0` |
| CampaignFactory | `Unauthorized()` | Caller does not hold `OPERATOR_ROLE` |
| CampaignFactory | `ZeroAddress()` | Constructor address parameter is `address(0)` |
| CampaignFactory | `InvalidBeneficiary()` | Beneficiary is `address(0)` |
| CampaignFactory | `InvalidBeneficiaryType()` | `beneficiaryType > 1` (valid: 0 = ORG, 1 = INDIVIDUAL) |
| CampaignFactory | `TargetTooLow()` | Target < 100 USDC (`MIN_TARGET = 100e6`) |
| CampaignFactory | `DeadlineOutOfRange()` | Deadline < now + 1 day or > now + 90 days |
| CampaignFactory | `DuplicateOffchainId()` | Clone already exists for `offchainId` |
| Campaign | `NotLive()` | Action requires `state == LIVE` |
| Campaign | `NotFailed()` | Action requires `state == FAILED` |
| Campaign | `NotSucceeded()` | Action requires `state == SUCCEEDED` |
| Campaign | `NotOperator()` | Caller does not hold `OPERATOR_ROLE` |
| Campaign | `PastDeadline()` | `block.timestamp >= deadline` |
| Campaign | `DeadlineNotReached()` | `block.timestamp < deadline` |
| Campaign | `AmountTooLow()` | Donation amount < `config.minDonation()` |
| Campaign | `InvalidPreference()` | `pref > 1` (valid: 0 = REFUND, 1 = EMERGENCY_POOL) |
| Campaign | `NotDonor()` | Caller has `donated[caller] == 0` |
| Campaign | `AlreadySettled()` | Donor already claimed refund or settled to pool |
| Campaign | `AlreadySwept()` | `swept == true` |
| Campaign | `SweepDelayNotReached()` | `block.timestamp < endTime + snapRefundSweepDelay` |
| Campaign | `PoolNotConfigured()` | `config.emergencyPool() == address(0)` |
| Campaign | `TreasuryNotSet()` | `config.treasury() == address(0)` |
| Campaign | `IndividualCannotBeSingle()` | `beneficiaryType == INDIVIDUAL` with `payoutMode == SINGLE` |
| Campaign | `PayoutModeNotSet()` | Release called before `payoutModeSet == true` |
| Campaign | `PayoutModeAlreadySet()` | `setPayoutMode` called when `payoutModeSet == true` |
| Campaign | `InvalidPayoutMode()` | `mode > 1` |
| Campaign | `NotImplemented()` | `payoutMode == 1` (MILESTONES, deferred to TASK-003) |
| Campaign | `ZeroAmount()` | Transfer amount is 0 |
| Campaign | `ZeroAddress()` | Initializer beneficiary is `address(0)` |

### External function access rules

| Function | Visibility | Access / Guard | Description |
|---|---|---|---|
| `PlatformConfig.setTreasury` | external | `onlyRole(DEFAULT_ADMIN_ROLE)` | Update platform treasury address |
| `PlatformConfig.setEmergencyPool` | external | `onlyRole(DEFAULT_ADMIN_ROLE)` | Update emergency pool address |
| `PlatformConfig.setFeeBps` | external | `onlyRole(DEFAULT_ADMIN_ROLE)` | Update platform fee (max 500 BPS / 5%) |
| `PlatformConfig.setSuccessThresholdBps` | external | `onlyRole(DEFAULT_ADMIN_ROLE)` | Update success threshold (1..10000 BPS) |
| `PlatformConfig.setVoteWindow` | external | `onlyRole(DEFAULT_ADMIN_ROLE)` | Update milestone vote window (1h..14d) |
| `PlatformConfig.setQuorumBps` | external | `onlyRole(DEFAULT_ADMIN_ROLE)` | Update milestone quorum (1..10000 BPS) |
| `PlatformConfig.setApprovalBps` | external | `onlyRole(DEFAULT_ADMIN_ROLE)` | Update milestone approval threshold (5001..10000 BPS) |
| `PlatformConfig.setRefundSweepDelay` | external | `onlyRole(DEFAULT_ADMIN_ROLE)` | Update sweep delay (30d..365d) |
| `PlatformConfig.setMinDonation` | external | `onlyRole(DEFAULT_ADMIN_ROLE)` | Update min donation amount (> 0) |
| `CampaignFactory.createCampaign` | external | `OPERATOR_ROLE` | Deploy deterministic Campaign clone |
| `CampaignFactory.predictCampaignAddress` | external view | Anyone | Precompute clone address from `offchainId` |
| `CampaignFactory.isCampaign` | external view | Anyone | Verify if address is a clone from this factory |
| `Campaign.initialize` | external | `initializer` (factory once) | Initialize clone with parameters and snapshot config |
| `Campaign.donate` | external | Anyone, `nonReentrant` | Donate USDC (state=LIVE, before deadline, clipped to target) |
| `Campaign.setPreference` | external | Donor (`donated > 0`) | Update failure preference (state=LIVE) |
| `Campaign.finalize` | external | Anyone | Finalize campaign to SUCCEEDED or FAILED after deadline |
| `Campaign.setPayoutMode` | external | `OPERATOR_ROLE` | Select SINGLE or MILESTONES (state=SUCCEEDED, once) |
| `Campaign.release` | external | Anyone, `nonReentrant` | Execute SINGLE release: fee → treasury, rest → beneficiary (state=SUCCEEDED → COMPLETED) |
| `Campaign.claimRefund` | external | Donor (`donated > 0`), `nonReentrant` | Pull refund for REFUND preference (state=FAILED, !swept, !settled) |
| `Campaign.settleToPool` | external | Anyone for donor, `nonReentrant` | Transfer donation to emergency pool for EMERGENCY_POOL preference (state=FAILED, !swept, !settled) |
| `Campaign.sweepUnclaimed` | external | Anyone, `nonReentrant` | Sweep remaining contract USDC balance to emergency pool (state=FAILED, !swept, after endTime + sweepDelay) |
| `Campaign.preferenceOf` | external view | Anyone | Returns preference for donor |
| `Campaign.remaining` | external view | Anyone | Returns remaining USDC required to reach target |

## Files changed

- `packages/contracts/src/PlatformConfig.sol` — Platform parameters, AccessControl roles, boundary validations
- `packages/contracts/src/CampaignFactory.sol` — Deterministic clone factory with `Clones.cloneDeterministic`
- `packages/contracts/src/Campaign.sol` — Minimal-proxy escrow clone with SINGLE payout and refund/pool mechanics
- `packages/contracts/abis/export.sh` — Script to export ABI JSONs and inlined typed TypeScript definitions
- `packages/contracts/abis/index.ts` — Generated TypeScript ABI exports with `as const`
- `packages/contracts/package.json` — Added `"export-abis"` script
- `packages/contracts/tsconfig.json` — Configured TypeScript compiler options for ABI typechecking
- `packages/contracts/script/DeployCore.s.sol` — Core deployment script
- `packages/contracts/test/PlatformConfig.t.sol` — Unit tests for PlatformConfig roles, setters, and boundary constraints (44 tests)
- `packages/contracts/test/CampaignFactory.t.sol` — Unit tests for factory creation, address prediction, validation (15 tests)
- `packages/contracts/test/Campaign.t.sol` — Unit tests for Campaign lifecycle, SINGLE release, refunds, sweep, reentrancy selectors (55 tests)
- `packages/contracts/test/CampaignFuzz.t.sol` — Fuzz tests for donation clipping, fee math, refund sums, success thresholds (4 tests, 1000 runs each)
- `packages/contracts/test/invariant/CampaignInvariant.t.sol` — Invariant test suite (7 invariants, 256 runs × 128 calls)
- `packages/contracts/test/invariant/CampaignHandler.sol` — Handler with ghost tracking, actor accounting, and sweep handler
- `packages/contracts/test/mocks/MockUSDC.sol` — ERC-20 test mock
- `packages/contracts/test/mocks/MaliciousERC20.sol` — Reentrancy test mock

## Deviations from the task (and why)

- `payoutMode == MILESTONES` in `Campaign.release()` reverts with `NotImplemented()` — full milestone payout and voting logic is deferred to TASK-003 per task specifications.
- `sweepUnclaimed()` sweeps `IERC20.balanceOf(address(this))` directly to the emergency pool once `block.timestamp >= endTime + snapRefundSweepDelay` and sets `swept = true`, avoiding unbounded gas loops.

## New dependencies

- None (OpenZeppelin Contracts v5 and forge-std already present in `lib/`).

## How to verify

1. `cd packages/contracts && forge fmt --check` — returns exit code 0 (clean formatting)
2. `forge build` — compiler run successful (only informational block-timestamp warnings)
3. `pnpm run export-abis && pnpm run typecheck` — ABI export and typecheck pass cleanly
4. `forge test -vv` — **120 tests passed, 0 failed, 0 skipped** across 6 test suites
5. `forge coverage --report summary` — see table below
6. `forge snapshot` — gas snapshot updated

## Test results

**120 tests passed, 0 failed, 0 skipped (6 test suites)**

### Invariant call summary (256 runs × 128 calls = 32,768 calls, 0 reverts)

| Contract | Selector | Calls | Reverts | Discards |
|---|---|---|---|---|
| CampaignHandler | `handler_claimRefund` | 4,632 | 0 | 0 |
| CampaignHandler | `handler_donate` | 4,722 | 0 | 0 |
| CampaignHandler | `handler_finalize` | 4,744 | 0 | 0 |
| CampaignHandler | `handler_release` | 4,683 | 0 | 0 |
| CampaignHandler | `handler_setPayoutMode` | 4,664 | 0 | 0 |
| CampaignHandler | `handler_settleToPool` | 4,824 | 0 | 0 |
| CampaignHandler | `handler_sweepUnclaimed` | 4,499 | 0 | 0 |

Invariants verified:
- `invariant_balanceEquality`: Escrow USDC balance matches `totalRaised - (released + feePaid + totalRefunded + totalSentToPool)`
- `invariant_completedBalanceIsZero`: Balance is 0 on `COMPLETED` campaigns
- `invariant_sweptBalanceIsZero`: Balance is 0 on swept campaigns
- `invariant_ghostMatchesOnChain`: Ghost tracking matches contract state
- `invariant_owedEqualsBalance`: When `state == FAILED && !swept`, balance equals sum of unsettled donor balances
- `invariant_raisedNeverExceedsTarget`: `totalRaised <= target`
- `invariant_singlePayoutExact`: `released + feePaid == totalRaised` on SINGLE release

### Coverage summary

| File | % Lines | % Statements | % Branches | % Funcs |
|---|---|---|---|---|
| `src/Campaign.sol` | 100.00% (119/119) | 98.03% (149/152) | 92.50% (37/40) | 100.00% (13/13) |
| `src/CampaignFactory.sol` | 100.00% (22/22) | 100.00% (31/31) | 100.00% (7/7) | 100.00% (4/4) |
| `src/PlatformConfig.sol` | 100.00% (40/40) | 100.00% (52/52) | 100.00% (10/10) | 100.00% (10/10) |
| `test/invariant/CampaignHandler.sol` | 95.00% (76/80) | 95.97% (119/124) | 90.32% (28/31) | 80.00% (8/10) |
| `test/mocks/MaliciousERC20.sol` | 83.33% (10/12) | 75.00% (9/12) | 100.00% (3/3) | 100.00% (3/3) |
| `test/mocks/MockUSDC.sol` | 60.00% (3/5) | 50.00% (1/2) | N/A (0/0) | 66.67% (2/3) |
| **Total** | **92.15% (270/293)** | **91.86% (361/393)** | **93.41% (85/91)** | **90.91% (40/44)** |

*(Campaign.sol 3 uncovered branches correspond to the `payoutMode == MILESTONES` branch in `release()`, implemented in TASK-003)*

## Open questions / risks

- **USDC blacklist on beneficiary**: If Circle blacklists the beneficiary address, `release()` transfer will revert and escrowed funds remain temporarily locked. TASK-003 Guardian freeze → reject path provides the recovery mechanism (allowing the campaign to be rejected and routed to the emergency pool).
- **Stray USDC sent directly to COMPLETED campaign**: Direct ERC-20 transfers sent to a clone after it reaches `COMPLETED` cannot be extracted via contract functions; donations must be routed through `donate()`.
- **emergencyPool unconfigured before first campaign**: If `emergencyPool` is not configured in `PlatformConfig` before creating campaigns, calls to `settleToPool` or `sweepUnclaimed` on failed campaigns will revert with `PoolNotConfigured` until the admin sets the pool address.

## Suggested commit message

```
feat(contracts): PlatformConfig, CampaignFactory, Campaign escrow core (TASK-002)

- PlatformConfig: platform-wide parameters, bounds checks, timelock/operator/guardian roles
- CampaignFactory: deterministic EIP-1167 proxy deployment via Clones.cloneDeterministic
- Campaign: donation clipping, finalization, SINGLE release, refund claims, pool settlement, unclaimed sweep
- ABI export pipeline: export.sh generates typed index.ts for viem integration
- 120 tests (unit, bounds, reentrancy selectors, fuzz, 7 invariants with handler tracking), 100% line coverage on src/
```

