import { describe, expect, it } from "vitest";
import { POLYGON_USDC_ADDRESS } from "@cherrio/shared";
import {
  addFundsOptions, checkTopUp, fundingMode, fundingModeFromEnv, MIN_TOPUP_EUR, parseFundingOnramp, suggestTopUpEur,
} from "@/lib/funding/topup";

// TASK-036 (ADR-051): "Add money" rules — minimum 20 €, the suggested amount,
// the mode per environment and the options handed to Privy's addFunds.

const U = 1_000_000n;
/** 1 EUR = 1.17 USD, ×1e18. */
const RATE = 1_170_000_000_000_000_000n;

describe("checkTopUp", () => {
  it("whole euros from 20 to 10,000", () => {
    expect(MIN_TOPUP_EUR).toBe(20);
    expect(checkTopUp("19")).toEqual({ ok: false, reason: "below_minimum" });
    expect(checkTopUp("20")).toEqual({ ok: true, eur: 20 });
    expect(checkTopUp(" 150 ")).toEqual({ ok: true, eur: 150 });
    expect(checkTopUp("10000")).toEqual({ ok: true, eur: 10_000 });
    expect(checkTopUp("10001")).toEqual({ ok: false, reason: "above_maximum" });
    for (const bad of ["", "20.5", "20,00", "-20", "abc", "1e3"]) expect(checkTopUp(bad), bad).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("suggestTopUpEur", () => {
  it("the missing amount in EUR + 5 %, rounded up, at least 20 €", () => {
    // 5 USDC ≈ 4.27 € → 20 € (the minimum).
    expect(suggestTopUpEur(5n * U, RATE)).toBe(20);
    // 117 USDC = 100 € → 105 €.
    expect(suggestTopUpEur(117n * U, RATE)).toBe(105);
    // 117.000001 USDC is just above 100 € → 106 € (always rounded up).
    expect(suggestTopUpEur(117n * U + 1n, RATE)).toBe(106);
    // Without a rate USDC counts 1:1: 50 USDC → 52.50 € → 53 €.
    expect(suggestTopUpEur(50n * U, null)).toBe(53);
    expect(suggestTopUpEur(0n, RATE)).toBe(20);
    expect(suggestTopUpEur(1_000_000n * U, RATE)).toBe(10_000);
  });
});

describe("fundingMode", () => {
  it("faucet on a test network, the onramp only when switched on, sandbox wins everywhere", () => {
    expect(fundingMode({ testnet: true, onramp: "off" })).toEqual({ kind: "faucet" });
    expect(fundingMode({ testnet: true, onramp: "production" })).toEqual({ kind: "faucet" });
    expect(fundingMode({ testnet: true, onramp: "sandbox" })).toEqual({ kind: "onramp", environment: "sandbox" });
    expect(fundingMode({ testnet: false, onramp: "off" })).toEqual({ kind: "none" });
    expect(fundingMode({ testnet: false, onramp: "production" })).toEqual({ kind: "onramp", environment: "production" });
    expect(fundingMode({ testnet: false, onramp: "sandbox" })).toEqual({ kind: "onramp", environment: "sandbox" });
  });

  it("FUNDING_ONRAMP: unknown or missing → off", () => {
    expect(parseFundingOnramp(undefined)).toBe("off");
    expect(parseFundingOnramp("PRODUCTION")).toBe("off");
    expect(parseFundingOnramp("sandbox")).toBe("sandbox");
    expect(fundingModeFromEnv(false, undefined)).toEqual({ kind: "none" });
    expect(fundingModeFromEnv(false, "production")).toEqual({ kind: "onramp", environment: "production" });
  });
});

describe("addFundsOptions", () => {
  it("USDC on Polygon mainnet to the smart account, EUR first, the amount as default", () => {
    const address = "0x1111111111111111111111111111111111111111" as const;
    expect(addFundsOptions({ address, eur: 25, environment: "sandbox" })).toEqual({
      destination: { address, chain: "eip155:137", asset: POLYGON_USDC_ADDRESS },
      fiat: { source: { defaultAsset: "eur", assets: ["eur", "usd", "gbp", "chf"] }, defaultAmount: "25", environment: "sandbox" },
    });
  });
});
