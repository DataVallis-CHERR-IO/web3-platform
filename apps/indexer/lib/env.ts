import { readFileSync } from "node:fs";
import { getAddress, type Address } from "viem";
import { getChainConfig, parseAppEnv, requireContracts, type AppEnv } from "@cherrio/shared";
import { endBlockFromEnv } from "./batch";

export interface IndexedContract {
  address: Address;
  startBlock: number;
}

export interface IndexerEnv {
  appEnv: AppEnv;
  chainId: number;
  rpcUrl: string;
  /** Direct Postgres URL (ADR-026) — never PgBouncer. */
  databaseUrl: string;
  /** Local/test chains must not write Anvil data into Ponder's RPC cache. */
  disableCache: boolean;
  /** How often Ponder asks the RPC for a new block (ms). Every poll is billed by the RPC provider. */
  pollingIntervalMs: number;
  /** Batch mode (ADR-055): index up to this block only — set per cycle by scripts/batch.ts. Unset = follow the chain. */
  endBlock: number | undefined;
  campaignFactory: IndexedContract;
  emergencyPool: IndexedContract;
}

type Env = Record<string, string | undefined>;

function entry(raw: unknown, name: string): IndexedContract {
  const value = raw as { address?: unknown; startBlock?: unknown } | undefined;
  if (typeof value?.address !== "string" || typeof value.startBlock !== "number") {
    throw new Error(`[Indexer] Deployment has no valid "${name}" entry (address + startBlock)`);
  }
  return { address: getAddress(value.address), startBlock: value.startBlock };
}

/** APP_ENV=local: the deployment comes from a JSON file written by the deploy script. */
function readLocalDeployment(env: Env) {
  const file = env.INDEXER_DEPLOYMENT_FILE;
  if (!file) {
    throw new Error("[Indexer] INDEXER_DEPLOYMENT_FILE is required when APP_ENV=local");
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as {
    chainId?: unknown;
    contracts?: Record<string, unknown>;
  };
  if (typeof raw.chainId !== "number") {
    throw new Error(`[Indexer] ${file} has no numeric chainId`);
  }
  return { chainId: raw.chainId, contracts: raw.contracts ?? {} };
}

function requireDirectDatabaseUrl(env: Env): string {
  const url = env.DATABASE_URL_DIRECT;
  if (!url) {
    throw new Error("[Indexer] DATABASE_URL_DIRECT is not set");
  }
  const { port, hostname } = new URL(url);
  if (port === "6432" || hostname.includes("pgbouncer")) {
    throw new Error(
      "[Indexer] DATABASE_URL_DIRECT points at PgBouncer; Ponder needs a direct Postgres connection"
    );
  }
  return url;
}

/**
 * Block polling interval. Ponder's realtime sync fetches **at most 50 missing
 * blocks per poll** (`MAX_QUEUED_BLOCKS` in ponder/dist/esm/sync-realtime), so
 * the interval caps how many blocks a minute the indexer can follow. Amoy makes
 * ~60 blocks a minute (measured 2026-10-04: 6,764 blocks in 115 min): with the
 * 60 s interval used since 2026-10-03 the indexer fell ~10 blocks behind every
 * minute and was 2 h 20 min late after 12 h (a sponsored donation did not show).
 * 15 s follows up to ~200 blocks a minute; anything above 25 s is refused.
 * RPC cost scales with blocks (each is fetched once), not with polls: 15 s adds
 * only ~4,300 "latest block" calls a day compared with 60 s.
 * Local/test chains keep 1 s so the scenario tests stay fast.
 */
export const DEFAULT_POLLING_INTERVAL_MS = 15_000;
const MIN_POLLING_INTERVAL_MS = 1_000;
/** 50 blocks per poll at ~1 block/s → anything above ~40 s cannot keep up; 25 s keeps headroom. */
export const MAX_POLLING_INTERVAL_MS = 25_000;

function pollingInterval(env: Env, appEnv: AppEnv): number {
  const raw = env.INDEXER_POLLING_INTERVAL_MS;
  if (raw === undefined || raw === "") return appEnv === "local" ? MIN_POLLING_INTERVAL_MS : DEFAULT_POLLING_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_POLLING_INTERVAL_MS || value > MAX_POLLING_INTERVAL_MS) {
    throw new Error(
      `[Indexer] INDEXER_POLLING_INTERVAL_MS must be an integer between ${MIN_POLLING_INTERVAL_MS} and ${MAX_POLLING_INTERVAL_MS}`
    );
  }
  return value;
}

/**
 * Resolves chain, deployment, RPC and database for this indexer instance.
 * Throws on anything missing: an indexer must never start half-configured.
 */
export function resolveIndexerEnv(env: Env = process.env): IndexerEnv {
  if (!env.APP_ENV) {
    throw new Error("[Indexer] APP_ENV is not set (local | dev | uat | prod)");
  }
  const appEnv = parseAppEnv(env.APP_ENV);

  const { chainId, contracts } =
    appEnv === "local"
      ? readLocalDeployment(env)
      : { chainId: getChainConfig(appEnv).chain.id, contracts: requireContracts(appEnv) };

  const rpcVar = `PONDER_RPC_URL_${chainId}`;
  const rpcUrl = env[rpcVar];
  if (!rpcUrl) {
    throw new Error(`[Indexer] ${rpcVar} is not set`);
  }

  return {
    appEnv,
    chainId,
    rpcUrl,
    databaseUrl: requireDirectDatabaseUrl(env),
    // INDEXER_CACHE=1 keeps the cache on a local chain for RPC measurements only (scripts/rpc-cost.ts).
    disableCache: appEnv === "local" && env.INDEXER_CACHE !== "1",
    pollingIntervalMs: pollingInterval(env, appEnv),
    endBlock: endBlockFromEnv(env),
    campaignFactory: entry(contracts.campaignFactory, "campaignFactory"),
    emergencyPool: entry(contracts.emergencyPool, "emergencyPool"),
  };
}
