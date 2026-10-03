import { describe, expect, it } from "vitest";
import {
  checkDonationAmount, eurCentsToUsdcAtRate, MIN_DONATION_USDC, parseEurInput, parseUsdcInput,
} from "@/lib/campaigns/donate";

// Amount rules of the donate panel (TASK-011b): bigint only, rounded down,
// minimum 1 USDC / €1, clipped to what the campaign still needs.

const U = 1_000_000n;
/** 1.1734 USD per EUR × 1e18 */
const RATE = 1_173_400_000_000_000_000n;

describe("parsing", () => {
  it.each<[string, bigint | null]>([
    ["10", 1_000n],
    ["10.5", 1_050n],
    ["10,50", 1_050n],
    [" 1 000 ", 100_000n],
    ["0.01", 1n],
    ["10.", 1_000n],
    ["10.555", null],
    ["-5", null],
    ["abc", null],
    ["", null],
  ])("EUR %j → %s cents", (input, cents) => {
    expect(parseEurInput(input)).toBe(cents);
  });

  it.each<[string, bigint | null]>([
    ["1", U],
    ["1.000001", U + 1n],
    ["2,5", 2_500_000n],
    ["1.0000001", null],
    ["1e3", null],
  ])("USDC %j → %s", (input, units) => {
    expect(parseUsdcInput(input)).toBe(units);
  });
});

describe("eurCentsToUsdcAtRate", () => {
  it("converts with the display rate, rounded down", () => {
    expect(eurCentsToUsdcAtRate(1_000n, RATE)).toBe(11_734_000n); // €10 → 11.734 USDC
    expect(eurCentsToUsdcAtRate(1n, RATE)).toBe(11_734n); // €0.01 → 0.011734 USDC
    // 1.17345678… keeps only whole micro-USDC
    expect(eurCentsToUsdcAtRate(100n, 1_173_456_789_999_999_999n)).toBe(1_173_456n);
  });

  it("refuses a zero rate and negative amounts", () => {
    expect(() => eurCentsToUsdcAtRate(100n, 0n)).toThrow();
    expect(() => eurCentsToUsdcAtRate(-1n, RATE)).toThrow();
  });
});

describe("checkDonationAmount", () => {
  const base = { mode: "EUR" as const, usdPerEur18: RATE, remainingUsdc: 1_000n * U };

  it("accepts €25 and says what is sent", () => {
    expect(checkDonationAmount({ ...base, input: "25" })).toEqual({
      ok: true, usdc: 29_335_000n, send: 29_335_000n, clipped: false,
    });
  });

  it("refuses less than €1 or less than 1 USDC", () => {
    expect(checkDonationAmount({ ...base, input: "0.99" })).toEqual({ ok: false, reason: "below_minimum" });
    // A rate below 1 USD/EUR would make €1 less than 1 USDC.
    expect(checkDonationAmount({ ...base, usdPerEur18: 900_000_000_000_000_000n, input: "1" })).toEqual({
      ok: false, reason: "below_minimum",
    });
    expect(checkDonationAmount({ ...base, mode: "USDC", input: "0.999999" })).toEqual({ ok: false, reason: "below_minimum" });
    expect(checkDonationAmount({ ...base, mode: "USDC", input: "1" })).toMatchObject({ ok: true, usdc: MIN_DONATION_USDC });
  });

  it("refuses empty, zero and malformed input", () => {
    for (const input of ["", "0", "abc", "1.234"]) {
      expect(checkDonationAmount({ ...base, input })).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("needs a rate for EUR input", () => {
    expect(checkDonationAmount({ ...base, usdPerEur18: null, input: "10" })).toEqual({ ok: false, reason: "invalid" });
  });

  it("clips to the remaining target and keeps the typed amount for donate()", () => {
    expect(checkDonationAmount({ ...base, remainingUsdc: 5n * U, input: "100" })).toEqual({
      ok: true, usdc: 5n * U, send: 117_340_000n, clipped: true,
    });
    // The last cents of a campaign can be given even below the minimum.
    expect(checkDonationAmount({ ...base, remainingUsdc: 300_000n, input: "1" })).toMatchObject({
      ok: true, usdc: 300_000n, clipped: true,
    });
  });

  it("says when nothing is left", () => {
    expect(checkDonationAmount({ ...base, remainingUsdc: 0n, input: "10" })).toEqual({ ok: false, reason: "nothing_left" });
  });
});
