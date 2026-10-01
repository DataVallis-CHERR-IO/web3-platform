# @cherrio/contracts

Solidity smart contracts for CHERR.IO: PlatformConfig, CampaignFactory, Campaign clones, EmergencyPool, and deployment scripts.

## Build & Test

```bash
cd packages/contracts
forge build
forge test -vv
forge coverage --report summary
forge snapshot
bash abis/export.sh && pnpm run typecheck
```

## Deployment

**Contracts are deployed manually by David. Never run these commands without explicit approval.**

### Polygon Amoy testnet (DEV environment)

On Amoy, admin/guardian/operator is a plain testnet EOA (`0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7`). A Gnosis Safe is used on mainnet only.

#### 1. Setup environment variables

```bash
# RPC URL (Alchemy Amoy endpoint)
export ALCHEMY_AMOY_URL="https://polygon-amoy.g.alchemy.com/v2/<your-alchemy-key>"

# Amoy testnet EOA for operator / guardian and treasury
export SAFE_ADDRESS="0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7"
export TREASURY_ADDRESS="0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7"

# Target deployment name (only dev for now; uat deployed separately later)
export DEPLOY_NAME=dev

# Timelock delay in seconds (default 300s = 5m for testnet)
export TIMELOCK_DELAY=300

# Etherscan v2 API key (from https://etherscan.io -> API Keys; one unified key works for Amoy)
export POLYGONSCAN_API_KEY="<your-etherscan-v2-api-key>"

# Read deployer private key securely (never in shell history or written to disk)
echo -n "Enter DEPLOYER_PRIVATE_KEY: " && read -s DEPLOYER_PRIVATE_KEY && export DEPLOYER_PRIVATE_KEY && echo ""
```

#### 2. Dry run (simulation & gas estimation)

Run the script without `--broadcast` to simulate execution against Amoy RPC and check estimated gas and total POL cost. A dry run will never write or modify `deployments/*.json`.

```bash
cd packages/contracts
forge script script/DeployAmoy.s.sol \
  --rpc-url $ALCHEMY_AMOY_URL
```

Review the printed summary:
- Gas estimate per contract creation
- Total estimated POL cost
- Logged contract addresses and warnings

#### 3. Broadcast deployment & verify

Execute with `--broadcast` and `--verify` to deploy to Polygon Amoy (chain ID 80002) and automatically submit contract verification.

```bash
forge script script/DeployAmoy.s.sol \
  --rpc-url $ALCHEMY_AMOY_URL \
  --broadcast \
  --verify \
  --chain 80002 \
  --etherscan-api-key $POLYGONSCAN_API_KEY
```

This writes the deployed addresses and creation block numbers to `deployments/amoy-dev.json`.

#### 4. Manual contract verification (fallback)

If automated verification during broadcast fails or times out, verify each contract individually on chain 80002:

```bash
# 1. PlatformConfig
forge verify-contract <PLATFORM_CONFIG_ADDRESS> src/PlatformConfig.sol:PlatformConfig \
  --chain 80002 \
  --constructor-args $(cast abi-encode "constructor(address,address)" 0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582 <DEPLOYER_ADDRESS>) \
  --etherscan-api-key $POLYGONSCAN_API_KEY

# 2. Campaign implementation
forge verify-contract <CAMPAIGN_IMPL_ADDRESS> src/Campaign.sol:Campaign \
  --chain 80002 \
  --etherscan-api-key $POLYGONSCAN_API_KEY

# 3. CampaignFactory
forge verify-contract <FACTORY_ADDRESS> src/CampaignFactory.sol:CampaignFactory \
  --chain 80002 \
  --constructor-args $(cast abi-encode "constructor(address,address)" <PLATFORM_CONFIG_ADDRESS> <CAMPAIGN_IMPL_ADDRESS>) \
  --etherscan-api-key $POLYGONSCAN_API_KEY

# 4. EmergencyPool
forge verify-contract <EMERGENCY_POOL_ADDRESS> src/EmergencyPool.sol:EmergencyPool \
  --chain 80002 \
  --constructor-args $(cast abi-encode "constructor(address,address)" <PLATFORM_CONFIG_ADDRESS> <FACTORY_ADDRESS>) \
  --etherscan-api-key $POLYGONSCAN_API_KEY

# 5. TimelockController
forge verify-contract <TIMELOCK_ADDRESS> @openzeppelin/contracts/governance/TimelockController.sol:TimelockController \
  --chain 80002 \
  --constructor-args $(cast abi-encode "constructor(uint256,address[],address[],address)" 300 "[0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7]" "[0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7]" 0x0000000000000000000000000000000000000000) \
  --etherscan-api-key $POLYGONSCAN_API_KEY
```

#### 5. Verify on amoy.polygonscan.com

Verify the on-chain state on `https://amoy.polygonscan.com`:
1. **PlatformConfig roles**:
   - `hasRole(DEFAULT_ADMIN_ROLE, deployer) == false` (deployer holds NO roles)
   - `hasRole(OPERATOR_ROLE, deployer) == false`
   - `hasRole(GUARDIAN_ROLE, deployer) == false`
   - `hasRole(DEFAULT_ADMIN_ROLE, TimelockController) == true` (Timelock is admin)
   - `hasRole(OPERATOR_ROLE, 0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7) == true`
   - `hasRole(GUARDIAN_ROLE, 0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7) == true`
2. **PlatformConfig configuration**:
   - `emergencyPool() == <EmergencyPool address>`
   - `treasury() == 0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7`
   - `usdc() == 0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` (Circle testnet USDC)
3. **TimelockController roles**:
   - Deployer has NO proposer / executor / admin / canceller roles
   - Timelock is self-admin
   - `0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7` has `PROPOSER_ROLE`, `EXECUTOR_ROLE`, and `CANCELLER_ROLE`

#### 6. Commit deployment artifact

```bash
git add packages/contracts/deployments/amoy-dev.json
git commit -m "chore(contracts): amoy-dev deployment addresses"
```

---

### Polygon mainnet (PROD environment)

Mainnet deployment requires a real Gnosis Safe contract on Polygon (`SAFE_ADDRESS`), 48h hard-coded timelock delay (no `TIMELOCK_DELAY` override allowed), and native Circle USDC (`0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`).

```bash
export DEPLOYER_PRIVATE_KEY=<key>
export SAFE_ADDRESS=<gnosis-safe>
export TREASURY_ADDRESS=<treasury>
export ALCHEMY_POLYGON_URL=<rpc-url>
export POLYGONSCAN_API_KEY=<key>

forge script script/DeployPolygon.s.sol \
  --rpc-url $ALCHEMY_POLYGON_URL \
  --broadcast \
  --verify \
  --chain 137 \
  --etherscan-api-key $POLYGONSCAN_API_KEY

# Output: deployments/polygon.json
```

## Deployment JSON schema

All deployment files (`amoy-dev.json`, `amoy-uat.json`, `polygon.json`) share the same schema:

```jsonc
{
  "chainId": 80002,            // 80002 = Amoy, 137 = Polygon mainnet
  "deployer": "0x...",         // deployer address (holds no roles after deploy)
  "blockNumber": 12345,        // block at deployment (Ponder startBlock)
  "contracts": {
    "platformConfig":         "0x...",
    "campaignFactory":        "0x...",
    "campaignImplementation": "0x...",
    "emergencyPool":          "0x...",
    "timelockController":     "0x..."
  }
}
```

The TypeScript types are in `deployments/index.ts`.

## Role layout after deployment

| Role | Holder | Contract |
|------|--------|----------|
| `DEFAULT_ADMIN_ROLE` | TimelockController | PlatformConfig |
| `OPERATOR_ROLE` | Safe (Phase 1) | PlatformConfig |
| `GUARDIAN_ROLE` | Safe | PlatformConfig |
| Deployer | **no roles** | PlatformConfig, Timelock |
