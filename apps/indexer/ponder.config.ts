import { createConfig, factory } from "ponder";
import { getAbiItem } from "viem";
import { CampaignAbi, CampaignFactoryAbi } from "@cherrio/contracts/abis";
import { resolveIndexerEnv } from "./lib/env";

const env = resolveIndexerEnv();

// One chain per instance: each environment runs its own indexer (ADR-020).
// EmergencyPool is registered with its handlers in the next PR (TASK-006 PR B).
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
  },
});
