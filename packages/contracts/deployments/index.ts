import { getAddress, type Address } from "viem";
import amoyDevRaw from "./amoy-dev.json" with { type: "json" };

export type { Address };

export interface ContractEntry {
  address: Address;
  startBlock: number;
}

export interface DeploymentContracts {
  platformConfig?: ContractEntry;
  campaignFactory?: ContractEntry;
  campaignImplementation?: ContractEntry;
  emergencyPool?: ContractEntry;
  timelockController?: ContractEntry;
  [key: string]: ContractEntry | undefined;
}

export interface Deployment {
  chainId: number;
  /** Unix timestamp (seconds) as a string, e.g. "1719849600". */
  deployedAt: string;
  /** Git commit SHA from env COMMIT_SHA; may be empty string. */
  commitSha: string;
  deployer: Address;
  contracts: DeploymentContracts;
}

export interface DeploymentsMap {
  "amoy-dev"?: Deployment;
  "amoy-uat"?: Deployment;
  polygon?: Deployment;
  [key: string]: Deployment | undefined;
}

function parseContractEntry(raw: unknown, key: string): ContractEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Invalid contract entry for "${key}": expected object`);
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.address !== "string") {
    throw new Error(`Invalid contract entry for "${key}": missing or invalid address`);
  }
  if (typeof entry.startBlock !== "number" || !Number.isInteger(entry.startBlock)) {
    throw new Error(`Invalid contract entry for "${key}": missing or invalid startBlock`);
  }
  return {
    address: getAddress(entry.address),
    startBlock: entry.startBlock,
  };
}

export function parseDeployment(raw: unknown): Deployment {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Invalid deployment: expected JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.chainId !== "number") {
    throw new Error("Invalid deployment: missing or invalid chainId");
  }
  if (typeof obj.deployedAt !== "string") {
    throw new Error("Invalid deployment: missing or invalid deployedAt");
  }
  if (typeof obj.commitSha !== "string") {
    throw new Error("Invalid deployment: missing or invalid commitSha");
  }
  if (typeof obj.deployer !== "string") {
    throw new Error("Invalid deployment: missing or invalid deployer address");
  }
  if (typeof obj.contracts !== "object" || obj.contracts === null) {
    throw new Error("Invalid deployment: missing or invalid contracts map");
  }

  const rawContracts = obj.contracts as Record<string, unknown>;
  const contracts: DeploymentContracts = {};

  for (const [name, entry] of Object.entries(rawContracts)) {
    if (entry !== undefined && entry !== null) {
      contracts[name] = parseContractEntry(entry, name);
    }
  }

  return {
    chainId: obj.chainId,
    deployedAt: obj.deployedAt,
    commitSha: obj.commitSha,
    deployer: getAddress(obj.deployer),
    contracts,
  };
}

export const deployments: DeploymentsMap = {
  "amoy-dev": parseDeployment(amoyDevRaw),
  "amoy-uat": undefined,
  polygon: undefined,
};

export default deployments;
