export type Address = `0x${string}`;

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

export const deployments: DeploymentsMap = {};

export default deployments;
