export type Address = `0x${string}`;

export interface DeploymentContracts {
  platformConfig?: Address;
  campaignFactory?: Address;
  emergencyPool?: Address;
  timelockController?: Address;
  [key: string]: Address | undefined;
}

export interface Deployment {
  chainId: number;
  deployedAt?: string;
  commitSha?: string;
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
