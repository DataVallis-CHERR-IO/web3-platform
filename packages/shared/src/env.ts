import { z } from "zod";
import { deployments, type DeploymentContracts } from "@cherrio/contracts/deployments";
import {
  type ChainConfig,
  POLYGON_MAINNET,
  POLYGON_AMOY,
  ANVIL_LOCAL,
} from "./chains.js";

export const AppEnvSchema = z.enum(["local", "dev", "uat", "prod"]);
export type AppEnv = z.infer<typeof AppEnvSchema>;

export interface ResolvedChainConfig {
  appEnv: AppEnv;
  chain: ChainConfig;
  contracts: DeploymentContracts | undefined;
}

export function parseAppEnv(value: unknown): AppEnv {
  return AppEnvSchema.parse(value);
}

export function getChainConfig(appEnv: AppEnv): ResolvedChainConfig {
  switch (appEnv) {
    case "local":
      return {
        appEnv,
        chain: ANVIL_LOCAL,
        contracts: undefined,
      };
    case "dev":
      return {
        appEnv,
        chain: POLYGON_AMOY,
        contracts: deployments["amoy-dev"]?.contracts,
      };
    case "uat":
      return {
        appEnv,
        chain: POLYGON_AMOY,
        contracts: deployments["amoy-uat"]?.contracts,
      };
    case "prod":
      return {
        appEnv,
        chain: POLYGON_MAINNET,
        contracts: deployments.polygon?.contracts,
      };
    default: {
      const _exhaustive: never = appEnv;
      throw new Error(`Unhandled AppEnv: ${_exhaustive}`);
    }
  }
}
