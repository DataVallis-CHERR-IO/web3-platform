# TASK-002 — Contracts core: PlatformConfig, CampaignFactory, Campaign (donations, finalize, refunds, SINGLE payout)

Read first: `docs/00-MANIFEST.md`, `docs/01-PRODUCT-SPEC.md` §2, `docs/02-ARCHITECTURE.md` §2, `docs/03-DECISIONS.md` ADR-002, 008, 009, 010.

## Goal
Secure, fully tested escrow contracts for the SINGLE-payout path. Milestones/voting come in TASK-003, Emergency Pool in TASK-004 — design so they plug in without rewriting storage.

## Scope

### `PlatformConfig.sol`
- OZ `AccessControl`. Roles: `DEFAULT_ADMIN_ROLE`, `OPERATOR_ROLE`, `GUARDIAN_ROLE`.
- Storage + admin-only setters with events:
  - `usdc` (immutable, constructor)
  - `treasury` (address)
  - `emergencyPool` (address, settable once non-zero; can be zero until TASK-004)
  - `feeBps` = 100, max 500
  - `successThresholdBps` = 1000
  - `voteWindow` = 24 hours (min 1h, max 14 days)
  - `quorumBps` = 5000, `approvalBps` = 5100
  - `refundSweepDelay` = 180 days
  - `minDonation` = 1e6 (1 USDC)
- Campaigns read config **live** except values snapshotted at creation (see below).

### `CampaignFactory.sol`
- `createCampaign(CreateParams p) returns (address)` — `OPERATOR_ROLE` only. Deploys `Campaign` clone (OZ `Clones.clone`), calls `initialize`.
- `CreateParams`: `bytes32 offchainId`, `address beneficiary`, `uint256 target` (USDC units), `uint64 deadline`, `uint8 beneficiaryType` (0 = ORG, 1 = INDIVIDUAL).
- Validations: beneficiary ≠ 0, target ≥ 100 USDC, deadline between now+1 day and now+90 days, `offchainId` unique.
- Event `CampaignCreated(address campaign, bytes32 offchainId, address beneficiary, uint256 target, uint64 deadline, uint8 beneficiaryType)`.
- `isCampaign(address) view`.

### `Campaign.sol` (initializable clone, **non-upgradeable** logic)
- Snapshot at `initialize`: `feeBps`, `successThresholdBps`, `refundSweepDelay` (so config changes never affect running campaigns). Vote params snapshot too (used in TASK-003).
- State enum (full set now, some used in TASK-003): `LIVE, SUCCEEDED, FAILED, PAYING, COMPLETED, VOTING, NEEDS_REVIEW, REJECTED, FROZEN`.
- `donate(uint256 amount, uint8 preference, uint32 subPoolId)`:
  - only `LIVE`, before deadline, `amount ≥ minDonation`.
  - clip to `target − totalRaised`; pull clipped amount via `SafeERC20.safeTransferFrom`.
  - track `donated[donor]`, `totalRaised`, donor preference (`0 = REFUND`, `1 = EMERGENCY_POOL`) + `subPoolId`.
  - if `totalRaised == target` → state `SUCCEEDED`, emit `Finalized`.
  - emit `Donated(donor, amount, preference, subPoolId)`.
- `setPreference(uint8 preference, uint32 subPoolId)` — donors only, while `LIVE`.
- `finalize()` — anyone, only `LIVE` and `block.timestamp ≥ deadline`; `SUCCEEDED` if `totalRaised * 10000 ≥ target * successThresholdBps`, else `FAILED`.
- `setPayoutMode(uint8 mode)` — `OPERATOR_ROLE`, only in `SUCCEEDED` before any release. `0 = SINGLE`, `1 = MILESTONES`. `INDIVIDUAL` campaigns **revert** on `SINGLE`.
- `release()` — anyone may call; `SINGLE` mode: sends `fee = totalRaised * feeBps / 10000` to treasury, rest to beneficiary, state `COMPLETED`. (MILESTONES path: revert `NotImplemented` placeholder to be replaced in TASK-003.)
- `claimRefund()` — `FAILED` state, donor with preference REFUND, pull-payment, zero out balance. Emit `Refunded`.
- `settleToPool(address donor)` — `FAILED`, donor preference EMERGENCY_POOL; transfers donor's amount to `emergencyPool` (revert if pool not configured). Anyone may call. Emit `SentToPool(donor, amount, subPoolId)`. (Pool-side accounting call added in TASK-004 — keep an internal hook `_sendToPool(amount, subPoolId)`.)
- `sweepUnclaimed()` — after `endTime + refundSweepDelay`, moves all remaining unclaimed refunds to the pool (general, subPool 0).
- Reentrancy guard on all state-changing external functions. Custom errors, no revert strings.
- Views: `state()`, `totalRaised()`, `donated(address)`, `preferenceOf(address)`, `remaining()`, `config snapshot getters`.

### Tests (Foundry)
- `MockUSDC` (6 decimals, mintable) in `test/mocks`.
- Unit tests for every function incl. every revert path and role check.
- Fuzz: donation clipping, fee math, success threshold boundary (exactly 10% succeeds, 10% − 1 unit fails), refunds sum.
- **Invariant test** (handler-based): `usdc.balanceOf(campaign) == totalRaised − released − refunded − sentToPool` and sum of `donated[]` of refunded+unclaimed donors equals what is owed.
- Coverage ≥ 95% lines on `src/`.
- Gas snapshot (`forge snapshot`) committed.

### Scripts
- `script/DeployCore.s.sol` for local Anvil only (Amoy deployment comes in TASK-004).
- Export ABIs to `packages/contracts/abis/*.json` via a pnpm script, and a TS `index.ts` exporting them (`as const`) for viem.

## Must not touch
`docs/**`, `apps/**`, other packages (except `packages/shared` if you need to export chain constants — justify in feedback).

## Acceptance criteria
- `forge build`, `forge test -vv`, `forge coverage` pass; coverage ≥ 95%.
- No `onlyOwner`; only AccessControl roles.
- No function can send USDC anywhere other than: beneficiary, treasury (fee), donor (refund), emergencyPool.
- Feedback includes the coverage table and the list of all external functions with their access rules.
