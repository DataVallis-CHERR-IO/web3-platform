import { createConfig, factory } from "ponder";
import { getAbiItem } from "viem";
import { CampaignAbi, CampaignFactoryAbi, EmergencyPoolAbi } from "@cherrio/contracts/abis";
import { resolveIndexerEnv } from "./lib/env";

const env = resolveIndexerEnv();

// One chain per instance: each environment runs its own indexer (ADR-020).
export default createConfig({
  database: {
    kind: "postgres",
    connectionString: env.databaseUrl,
    // The dev/uat roles are limited to 20 connections, shared with PgBouncer.
    poolConfig: { max: 8 },
  },
  chains: {
    cherrio: {
      id: env.chainId,
      rpc: env.rpcUrl,
      disableCache: env.disableCache,
    },
  },
  contracts: {
    CampaignFactory: {
      abi: CampaignFactoryAbi,
      chain: "cherrio",
      address: env.campaignFactory.address,
      startBlock: env.campaignFactory.startBlock,
    },
    Campaign: {
      abi: CampaignAbi,
      chain: "cherrio",
      address: factory({
        address: env.campaignFactory.address,
        event: getAbiItem({ abi: CampaignFactoryAbi, name: "CampaignCreated" }),
        parameter: "campaign",
      }),
      startBlock: env.campaignFactory.startBlock,
    },
    EmergencyPool: {
      abi: EmergencyPoolAbi,
      chain: "cherrio",
      address: env.emergencyPool.address,
      startBlock: env.emergencyPool.startBlock,
    },
  },
});
