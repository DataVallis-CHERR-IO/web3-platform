import { describe, it, expect } from "vitest";
import { parseAppEnv, getChainConfig, requireContracts, validateAuthEnv } from "../src/env.js";
import {
  POLYGON_CHAIN_ID,
  AMOY_CHAIN_ID,
  ANVIL_CHAIN_ID,
  POLYGON_USDC_ADDRESS,
  AMOY_USDC_ADDRESS,
  LOCAL_USDC_ADDRESS,
} from "../src/chains.js";

describe("env configuration", () => {
  describe("parseAppEnv", () => {
    it("accepts valid environments", () => {
      expect(parseAppEnv("local")).toBe("local");
      expect(parseAppEnv("dev")).toBe("dev");
      expect(parseAppEnv("uat")).toBe("uat");
      expect(parseAppEnv("prod")).toBe("prod");
    });

    it("rejects invalid environments", () => {
      expect(() => parseAppEnv("staging")).toThrow();
      expect(() => parseAppEnv("test")).toThrow();
      expect(() => parseAppEnv(123)).toThrow();
      expect(() => parseAppEnv(null)).toThrow();
    });
  });

  describe("getChainConfig", () => {
    it("returns local Anvil chain config for 'local'", () => {
      const config = getChainConfig("local");
      expect(config.appEnv).toBe("local");
      expect(config.chain.id).toBe(ANVIL_CHAIN_ID);
      expect(config.chain.name).toBe("Anvil Local");
      expect(config.chain.usdcAddress).toBe(LOCAL_USDC_ADDRESS);
      expect(config.contracts).toBeUndefined();
    });

    it("returns Amoy chain config for 'dev' with deployed contract addresses", () => {
      const config = getChainConfig("dev");
      expect(config.appEnv).toBe("dev");
      expect(config.chain.id).toBe(AMOY_CHAIN_ID);
      expect(config.chain.name).toBe("Polygon Amoy");
      expect(config.chain.usdcAddress).toBe(AMOY_USDC_ADDRESS);
      expect(config.contracts).toBeDefined();
      expect(config.contracts?.campaignFactory?.address).toBe(
        "0x30594D1B207d6101a82Bf2A89da622FB26E5a0B5"
      );
      expect(config.contracts?.platformConfig?.address).toBe(
        "0xFdC7134BDcE8e3Ed07322eD1F90DA15297ca5e0B"
      );
      expect(config.contracts?.emergencyPool?.address).toBe(
        "0x3a108a45BdD0843612Bd55C2797B1147f06223bD"
      );
      expect(config.contracts?.campaignImplementation?.address).toBe(
        "0x2C1F9AA8FCD1a990D12A5Bdbd8C79dF19b3ED3c6"
      );
      expect(config.contracts?.timelockController?.address).toBe(
        "0x725e30EfCc66f65257130b4C63c8e986d4b3351d"
      );

      const contracts = requireContracts("dev");
      expect(contracts.campaignFactory?.address).toBe(
        "0x30594D1B207d6101a82Bf2A89da622FB26E5a0B5"
      );
    });

    it("returns Amoy chain config for 'uat' without throwing", () => {
      const config = getChainConfig("uat");
      expect(config.appEnv).toBe("uat");
      expect(config.chain.id).toBe(AMOY_CHAIN_ID);
      expect(config.chain.name).toBe("Polygon Amoy");
      expect(config.chain.usdcAddress).toBe(AMOY_USDC_ADDRESS);
      expect(config.contracts).toBeUndefined();
    });

    it("returns Polygon mainnet chain config for 'prod'", () => {
      const config = getChainConfig("prod");
      expect(config.appEnv).toBe("prod");
      expect(config.chain.id).toBe(POLYGON_CHAIN_ID);
      expect(config.chain.name).toBe("Polygon PoS");
      expect(config.chain.usdcAddress).toBe(POLYGON_USDC_ADDRESS);
      expect(config.contracts).toBeUndefined();
    });
  });

  describe("requireContracts", () => {
    it("throws a clear descriptive error for 'uat'", () => {
      expect(() => requireContracts("uat")).toThrowError(
        'Contracts not deployed for environment "uat". Run the deployment script and ensure deployments/amoy-uat.json is configured.'
      );
    });

    it("throws a clear descriptive error for 'local'", () => {
      expect(() => requireContracts("local")).toThrowError(
        'Contracts not deployed for environment "local"'
      );
    });

    it("throws a clear descriptive error for 'prod'", () => {
      expect(() => requireContracts("prod")).toThrowError(
        'Contracts not deployed for environment "prod"'
      );
    });
  });

  describe("validateAuthEnv", () => {
    it("allows missing auth variables in 'local' and reports not configured", () => {
      const res = validateAuthEnv({ APP_ENV: "local" });
      expect(res.appEnv).toBe("local");
      expect(res.isAuthConfigured).toBe(false);
      expect(res.privyAppId).toBeUndefined();
    });

    it("detects configured auth in 'local'", () => {
      const res = validateAuthEnv({
        APP_ENV: "local",
        PRIVY_APP_ID: "app_123",
        PRIVY_APP_SECRET: "sec_123",
        SESSION_SECRET: "a".repeat(32),
      });
      expect(res.appEnv).toBe("local");
      expect(res.isAuthConfigured).toBe(true);
      expect(res.privyAppId).toBe("app_123");
    });

    it("throws in 'dev' when PRIVY_APP_ID is missing", () => {
      expect(() =>
        validateAuthEnv({
          APP_ENV: "dev",
          PRIVY_APP_SECRET: "sec_123",
          SESSION_SECRET: "a".repeat(32),
        })
      ).toThrowError("[Auth] Missing PRIVY_APP_ID for dev environment");
    });

    it("throws in 'uat' when PRIVY_APP_SECRET is missing", () => {
      expect(() =>
        validateAuthEnv({
          APP_ENV: "uat",
          PRIVY_APP_ID: "app_123",
          SESSION_SECRET: "a".repeat(32),
        })
      ).toThrowError("[Auth] Missing PRIVY_APP_SECRET for uat environment");
    });

    it("throws in 'prod' when SESSION_SECRET is missing or too short", () => {
      expect(() =>
        validateAuthEnv({
          APP_ENV: "prod",
          PRIVY_APP_ID: "app_123",
          PRIVY_APP_SECRET: "sec_123",
        })
      ).toThrowError("[Auth] Missing SESSION_SECRET for prod environment");

      expect(() =>
        validateAuthEnv({
          APP_ENV: "prod",
          PRIVY_APP_ID: "app_123",
          PRIVY_APP_SECRET: "sec_123",
          SESSION_SECRET: "too_short",
        })
      ).toThrow();
    });

    it("succeeds in 'dev' when all auth vars are present and valid", () => {
      const res = validateAuthEnv({
        APP_ENV: "dev",
        PRIVY_APP_ID: "cmup9dfcd00ct0cjsvqkzm9q9",
        PRIVY_APP_SECRET: "mock_secret",
        SESSION_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      });
      expect(res.appEnv).toBe("dev");
      expect(res.isAuthConfigured).toBe(true);
      expect(res.privyAppId).toBe("cmup9dfcd00ct0cjsvqkzm9q9");
    });
  });
});
