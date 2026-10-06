import { createConfig, factory } from "ponder";
import { fallback, getAbiItem, http } from "viem";
import { CampaignAbi, CampaignFactoryAbi, EmergencyPoolAbi } from "@cherrio/contracts/abis";
import { resolveIndexerEnv } from "./lib/env";
import { installRedaction } from "./lib/redact";

// Before anything can print: the RPC URL contains the provider key and viem
// puts the URL into its error messages. No exit handlers here — Ponder has its own.
installRedaction();

const env = resolveIndexerEnv();

/** The ecrecover precompile: never emits logs. */
const NO_CAMPAIGN_YET = "0x0000000000000000000000000000000000000001";

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
      // Primary RPC; with a fallback URL every request that fails on the primary
      // (an error, a limit) is repeated on the fallback — in that order, not
      // load-balanced (Ponder spreads a URL list across all of them).
      rpc: env.rpcFallbackUrl ? fallback([http(env.rpcUrl), http(env.rpcFallbackUrl)], { rank: false }) : env.rpcUrl,
      // Infura refuses ranges over 10,000 blocks with a message Ponder's own
      // range helper does not recognise, so the backfill would stop there.
      ethGetLogsBlockRange: env.getLogsRange,
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
      endBlock: env.endBlock,
    },
    Campaign: {
      abi: CampaignAbi,
      chain: "cherrio",
      // Realtime: Ponder finds the campaigns itself. Batch mode (ADR-055): the
      // runner's list — `factory()` with a changing end block re-scans the whole
      // factory history every cycle. An empty list must not reach Ponder (no
      // address = every contract), so a never-emitting placeholder stands in.
      address:
        env.campaignAddresses === undefined
          ? factory({
              address: env.campaignFactory.address,
              event: getAbiItem({ abi: CampaignFactoryAbi, name: "CampaignCreated" }),
              parameter: "campaign",
            })
          : env.campaignAddresses.length > 0
            ? env.campaignAddresses
            : [NO_CAMPAIGN_YET],
      startBlock: env.campaignFactory.startBlock,
      endBlock: env.endBlock,
    },
    EmergencyPool: {
      abi: EmergencyPoolAbi,
      chain: "cherrio",
      address: env.emergencyPool.address,
      startBlock: env.emergencyPool.startBlock,
      endBlock: env.endBlock,
    },
  },
});
