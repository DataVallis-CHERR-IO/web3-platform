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

### Amoy testnet (dev / uat)

```bash
# Set environment variables (never commit these)
export DEPLOYER_PRIVATE_KEY=<key>
export SAFE_ADDRESS=<gnosis-safe>
export TREASURY_ADDRESS=<treasury>
export DEPLOY_NAME=dev   # or "uat"
export ALCHEMY_AMOY_URL=<rpc-url>
export POLYGONSCAN_API_KEY=<key>

# Deploy
forge script script/DeployAmoy.s.sol \
  --rpc-url $ALCHEMY_AMOY_URL \
  --broadcast \
  --verify \
  --etherscan-api-key $POLYGONSCAN_API_KEY

# Output: deployments/amoy-dev.json (or amoy-uat.json)
```

### Polygon mainnet

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
  --etherscan-api-key $POLYGONSCAN_API_KEY

# Output: deployments/polygon.json
```

### Verify individual contracts (if automatic verification fails)

```bash
forge verify-contract <ADDRESS> src/PlatformConfig.sol:PlatformConfig \
  --chain-id 80002 \
  --constructor-args $(cast abi-encode "constructor(address,address)" $USDC $DEPLOYER) \
  --etherscan-api-key $POLYGONSCAN_API_KEY
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
