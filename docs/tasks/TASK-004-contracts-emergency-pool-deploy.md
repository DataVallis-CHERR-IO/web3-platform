# TASK-004 — Contracts: EmergencyPool, Timelock, Amoy deployment scripts

Read first: `docs/01-PRODUCT-SPEC.md` §2.5, §2.6, `docs/02-ARCHITECTURE.md` §2.1–2.2, TASK-003 feedback.

## Scope
### `EmergencyPool.sol`
- Sub-pools: `uint32 poolId → balance`. Pool `0` = general, always exists. `createSubPool(uint32 id)` — `OPERATOR_ROLE`.
- Inflows:
  - `donate(uint32 poolId, uint256 amount)` — direct USDC donation; records `contributed[poolId][donor]` and `totalContributed[poolId]`.
  - `receiveFromCampaign(uint32 poolId, uint256 amount, address donor)` — callable only by a campaign registered in `CampaignFactory` (`isCampaign`); pulls or accounts USDC already transferred (choose one pattern, justify). The donor is credited as contributor of that pool.
  - Unknown poolId → credited to pool 0.
- Outflow (**Quick Realisation**):
  - `proposeAllocation(uint32 poolId, address campaign, uint256 amount, bytes32 reasonHash)` — `OPERATOR_ROLE`; target must be a LIVE campaign from the factory.
  - Voting: contributors of that pool, weight = `contributed[poolId][voter]`, window = config `voteWindow`, quorum/approval same as campaigns (turnout base = `totalContributed[poolId]`).
  - `closeAllocation(id)` → pass: transfer to campaign via `Campaign.donateFromPool(amount)` (add this function to Campaign: only callable by the pool, credited as donation from the pool address, REFUND preference → funds return to pool if the campaign fails). No quorum → `NEEDS_REVIEW` → Guardian `resolveAllocation(id, bool)`.
- Events for every action.
- Wire `Campaign._sendToPool` to `EmergencyPool.receiveFromCampaign`.

### Timelock and roles
- Deploy OZ `TimelockController` (minDelay 48h; proposer & executor = Safe address from env; admin = none).
- `PlatformConfig` `DEFAULT_ADMIN_ROLE` → Timelock; `GUARDIAN_ROLE` → Safe; `OPERATOR_ROLE` → Safe (Phase 1).
- Deployer renounces all roles at end of script.

### Scripts
- `script/DeployAmoy.s.sol`: deploys PlatformConfig (Amoy USDC `0x41E9…7582`), Factory, Pool, Timelock; sets roles; writes `deployments/amoy.json` (addresses + block numbers for Ponder `startBlock`).
- Env: `DEPLOYER_PRIVATE_KEY` (used locally by David only), `SAFE_ADDRESS`, `TREASURY_ADDRESS`, `ALCHEMY_AMOY_URL`, `POLYGONSCAN_API_KEY` for verification.
- `README` section in `packages/contracts` with exact deploy + verify commands. **Do not run the deployment** — David runs it.

## Tests
- Pool unit + fuzz tests, allocation vote boundaries, only-factory-campaign inflow, fail-then-return path, end-to-end test: campaign fails → donor prefers pool → pool allocation to new campaign → success → release.
- Deployment script test on Anvil fork of Amoy (or local Anvil with MockUSDC) asserting final role layout: deployer has no roles.

## Acceptance criteria
- Coverage ≥ 95% across `src/`.
- Slither run with no high/medium findings (or justified in feedback).
- `deployments/amoy.json` schema documented.
