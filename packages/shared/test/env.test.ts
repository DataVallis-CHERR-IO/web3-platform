import { describe, it, expect } from "vitest";
import { parseAppEnv, getChainConfig } from "../src/env.js";
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

    it("returns Amoy chain config for 'dev'", () => {
      const config = getChainConfig("dev");
      expect(config.appEnv).toBe("dev");
      expect(config.chain.id).toBe(AMOY_CHAIN_ID);
      expect(config.chain.name).toBe("Polygon Amoy");
      expect(config.chain.usdcAddress).toBe(AMOY_USDC_ADDRESS);
      expect(config.contracts).toBeUndefined();
    });

    it("returns Amoy chain config for 'uat'", () => {
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
});
