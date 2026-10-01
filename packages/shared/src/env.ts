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

/**
 * Asserts that deployment contracts are available for the given environment and returns them.
 * Throws a clear error if contracts have not been deployed yet.
 */
export function requireContracts(appEnv: AppEnv): DeploymentContracts {
  const config = getChainConfig(appEnv);
  if (!config.contracts) {
    throw new Error(
      `Contracts not deployed for environment "${appEnv}". Run the deployment script and ensure deployments/${appEnv === "prod" ? "polygon" : `amoy-${appEnv}`}.json is configured.`
    );
  }
  return config.contracts;
}

// ── Auth Environment ─────────────────────────────────────────────────────────

export const AuthEnvSchema = z.object({
  APP_ENV: AppEnvSchema.default("local"),
  PRIVY_APP_ID: z.string().min(1).optional(),
  PRIVY_APP_SECRET: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(32).optional(),
});
export type AuthEnv = z.infer<typeof AuthEnvSchema>;

export interface ValidatedAuthEnv {
  appEnv: AppEnv;
  privyAppId?: string;
  privyAppSecret?: string;
  sessionSecret?: string;
  isAuthConfigured: boolean;
}

declare const process: { env: Record<string, string | undefined> } | undefined;

/**
 * Validates auth environment variables at runtime.
 *
 * In `dev`, `uat`, or `prod`: throws loudly if any required auth variable is missing.
 * In `local`: allows missing variables so CI / E2E / local dev can run with login disabled.
 */
export function validateAuthEnv(
  env: Record<string, string | undefined> = typeof process !== "undefined"
    ? process.env
    : {}
): ValidatedAuthEnv {
  const parsed = AuthEnvSchema.safeParse({
    APP_ENV: env.APP_ENV ?? "local",
    PRIVY_APP_ID: env.PRIVY_APP_ID,
    PRIVY_APP_SECRET: env.PRIVY_APP_SECRET,
    SESSION_SECRET: env.SESSION_SECRET,
  });

  if (!parsed.success) {
    throw new Error(`[Auth] Invalid auth environment: ${parsed.error.message}`);
  }

  const { APP_ENV: appEnv, PRIVY_APP_ID: privyAppId, PRIVY_APP_SECRET: privyAppSecret, SESSION_SECRET: sessionSecret } =
    parsed.data;

  const isAuthConfigured = Boolean(privyAppId && privyAppSecret && sessionSecret);

  if (appEnv !== "local") {
    if (!privyAppId) {
      throw new Error(`[Auth] Missing PRIVY_APP_ID for ${appEnv} environment`);
    }
    if (!privyAppSecret) {
      throw new Error(`[Auth] Missing PRIVY_APP_SECRET for ${appEnv} environment`);
    }
    if (!sessionSecret) {
      throw new Error(`[Auth] Missing SESSION_SECRET for ${appEnv} environment`);
    }
    if (sessionSecret.length < 32) {
      throw new Error(`[Auth] SESSION_SECRET must be at least 32 characters for ${appEnv} environment`);
    }
  }

  return {
    appEnv,
    privyAppId,
    privyAppSecret,
    sessionSecret,
    isAuthConfigured,
  };
}

