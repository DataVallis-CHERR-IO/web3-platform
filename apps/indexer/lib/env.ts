import { readFileSync } from "node:fs";
import { getAddress, type Address } from "viem";
import { getChainConfig, parseAppEnv, requireContracts, type AppEnv } from "@cherrio/shared";

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
    disableCache: appEnv === "local",
    campaignFactory: entry(contracts.campaignFactory, "campaignFactory"),
    emergencyPool: entry(contracts.emergencyPool, "emergencyPool"),
  };
}
