import { createConfig, factory } from "ponder";
import { getAbiItem } from "viem";
import { CampaignAbi, CampaignFactoryAbi, EmergencyPoolAbi } from "@cherrio/contracts/abis";
import { resolveIndexerEnv } from "./lib/env";
import { installRedaction } from "./lib/redact";

// Before anything can print: the RPC URL contains the provider key and viem
// puts the URL into its error messages. No exit handlers here — Ponder has its own.
installRedaction();

const env = resolveIndexerEnv();

// One chain per instance: each environment runs its own indexer (ADR-020).
export default createConfig({
  database: {
    kind: "postgres",
    connectionString: env.databaseUrl,
    // The indexer role is limited to 10 connections (infra/README.md budget).
    // Ponder uses 2 internal + 3 pools of (max - 2) / 3, plus one LISTEN connection.
    poolConfig: { max: 5 },
  },
  chains: {
    cherrio: {
      id: env.chainId,
      rpc: env.rpcUrl,
      disableCache: env.disableCache,
      pollingInterval: env.pollingIntervalMs,
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
