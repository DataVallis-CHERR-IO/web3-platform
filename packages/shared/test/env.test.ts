import { describe, it, expect } from "vitest";
import { parseAppEnv, getChainConfig, requireContracts } from "../src/env.js";
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
        "0xd5Ca76A8FC6E15C6cC3F3C691A2b6c70D9715a00"
      );
      expect(config.contracts?.platformConfig?.address).toBe(
        "0x4d2570ccB2a6653D62a002027C0d383FfB193A16"
      );
      expect(config.contracts?.emergencyPool?.address).toBe(
        "0xFa7Fd0253813E196d74575A8F93ABB91cd009517"
      );
      expect(config.contracts?.campaignImplementation?.address).toBe(
        "0x6F6A9F54cC48a13bC5bFc127d16D874D07ccEA8F"
      );
      expect(config.contracts?.timelockController?.address).toBe(
        "0x52ba2090E62c9155c04E7E5f28DB9Af00A6AAede"
      );

      const contracts = requireContracts("dev");
      expect(contracts.campaignFactory?.address).toBe(
        "0xd5Ca76A8FC6E15C6cC3F3C691A2b6c70D9715a00"
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
});
