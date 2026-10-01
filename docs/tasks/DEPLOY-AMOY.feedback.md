# DEPLOY-AMOY feedback
Status: DONE

## What I implemented
- **`DeployAmoy.s.sol`**:
  - Configured `TIMELOCK_DELAY` from environment (in seconds), defaulting to 300s (5 minutes) for Amoy.
  - Allowed `SAFE_ADDRESS` to be a plain testnet EOA (`0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7`); logs a warning when `safe.code.length == 0` without reverting.
  - Configured script to write `deployments/amoy-<DEPLOY_NAME>.json` ONLY upon real broadcast (`vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)`); dry runs do not create or modify JSON files.
- **`DeployPolygon.s.sol`**:
  - Enforced 48h hardcoded timelock delay; reverts with `TimelockDelayOverrideNotAllowed` if `TIMELOCK_DELAY` env var is set.
  - Enforced `SAFE_ADDRESS` must be a contract; reverts with `SafeMustBeContract` if `safe.code.length == 0`.
  - Configured deployment JSON writing only on real broadcast (`vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)`).
- **`packages/contracts/README.md`**:
  - Added full end-to-end deployment runbook for Polygon Amoy (DEV): env var export with secure `read -s` for `DEPLOYER_PRIVATE_KEY`, Etherscan v2 API key guidance, dry-run simulation command, broadcast command with verification on chain 80002, individual fallback verification commands with encoded constructor arguments, on-chain state verification checklist on `amoy.polygonscan.com`, and commit instructions.
- **`Deploy.t.sol`**:
  - Added tests for `DeployAmoy` (dry-run does not write file, EOA safe accepted, configurable timelock delay, wrong chain revert) and `DeployPolygon` (reverts if timelock delay env set, reverts if safe is EOA, succeeds when safe has code, wrong chain revert).
- **`packages/contracts/deployments/index.ts`**:
  - Imported `amoy-dev.json` via JSON import (`import amoyDevRaw from "./amoy-dev.json" with { type: "json" }`).
  - Added runtime shape validation and address checksumming via `viem` `getAddress`.
  - Set `deployments["amoy-dev"] = parseDeployment(amoyDevRaw)` while keeping `amoy-uat` and `polygon` undefined.
- **`packages/shared/src/env.ts` & `packages/shared/test/env.test.ts`**:
  - `getChainConfig("dev")` reads deployed contract addresses (`campaignFactory: 0xd5Ca76A8FC6E15C6cC3F3C691A2b6c70D9715a00`, `platformConfig: 0x4d2570ccB2a6653D62a002027C0d383FfB193A16`, `emergencyPool: 0xFa7Fd0253813E196d74575A8F93ABB91cd009517`, `campaignImplementation: 0x6F6A9F54cC48a13bC5bFc127d16D874D07ccEA8F`, `timelockController: 0x52ba2090E62c9155c04E7E5f28DB9Af00A6AAede`).
  - Added `requireContracts(appEnv)` helper that returns `DeploymentContracts` or throws a clear error if contracts have not been deployed yet.
  - `getChainConfig("uat")` returns the Amoy config with `contracts: undefined` without throwing.
  - Vitest tests covering `getChainConfig` and `requireContracts` for all environments.
- **Local Anvil Simulation**:
  - Tested dry run against local chain ID 80002. Estimated total gas used: 11,583,446 gas (~0.0232 POL).

## Files changed
- `packages/contracts/script/DeployAmoy.s.sol` — TIMELOCK_DELAY env fallback, EOA safe logging, broadcast-only JSON export
- `packages/contracts/script/DeployPolygon.s.sol` — 48h timelock enforcement, contract-safe check, broadcast-only JSON export
- `packages/contracts/test/Deploy.t.sol` — script tests for DeployAmoy & DeployPolygon constraints and dry-run isolation
- `packages/contracts/README.md` — Amoy DEV deployment runbook, Etherscan v2 API key docs, verification and check procedures
- `packages/contracts/deployments/index.ts` — JSON import of amoy-dev.json with shape validation and address checksumming
- `packages/contracts/package.json` — added viem dependency
- `packages/shared/src/env.ts` — `requireContracts` helper
- `packages/shared/test/env.test.ts` — tests for `requireContracts` and `getChainConfig` with amoy-dev contract assertions
- `Dockerfile` — added packages/contracts package.json copy in deps stage

## Deviations from the task (and why)
- none. Followed plan approvals: `getChainConfig("uat")` does not throw; `requireContracts` throws when contract addresses are accessed before deployment; deployments JSON is only written on broadcast.

## New dependencies
- none

## How to verify
1. `cd packages/contracts && forge fmt --check` — passes cleanly
2. `forge build` — compiles cleanly
3. `forge test` — all 241 tests pass (including 21 deployment tests)
4. `pnpm typecheck` — all 8 packages pass typechecking
5. `pnpm --filter shared test` — all 38 vitest tests pass

## Test results
- Foundry: 241 passed, 0 failed, 0 skipped
- Vitest: 38 passed in shared (including money and env tests)
- Local Anvil simulation:
  - Estimated gas: 11,583,446
  - Estimated cost: ~0.023167 POL

## Open questions / risks
- When deploying on Amoy, ensure Alchemy Amoy URL has sufficient throughput for broadcasting 5 contract deployments. The deployer account requires at least ~0.05 POL on Amoy for safety.

## Suggested commit message
feat(contracts): prepare Amoy DEV deployment scripts and verification runbook
