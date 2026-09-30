import { describe, it, expect } from "vitest";
import {
  parseUsdc,
  formatUsdc,
  formatEur,
  usdcToEurCents,
  eurCentsToUsdc,
  parseRate,
} from "../src/money.js";

describe("parseUsdc", () => {
  it("parses whole integer strings correctly", () => {
    expect(parseUsdc("1")).toBe(1_000_000n);
    expect(parseUsdc("0")).toBe(0n);
    expect(parseUsdc("100")).toBe(100_000_000n);
    expect(parseUsdc("1000000")).toBe(1_000_000_000_000n);
  });

  it("parses decimal amounts correctly", () => {
    expect(parseUsdc("1.0")).toBe(1_000_000n);
    expect(parseUsdc("1.5")).toBe(1_500_000n);
    expect(parseUsdc("1.50")).toBe(1_500_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(parseUsdc("0.123456")).toBe(123456n);
    expect(parseUsdc(".5")).toBe(500_000n);
  });

  it("handles whitespace and comma grouping", () => {
    expect(parseUsdc("  10  ")).toBe(10_000_000n);
    expect(parseUsdc("1,000.50")).toBe(1_000_500_000n);
    expect(parseUsdc("1,000,000")).toBe(1_000_000_000_000n);
  });

  it("throws on invalid inputs", () => {
    expect(() => parseUsdc("")).toThrow("empty string");
    expect(() => parseUsdc("   ")).toThrow("empty string");
    expect(() => parseUsdc("-1")).toThrow("cannot be negative");
    expect(() => parseUsdc("-0.5")).toThrow("cannot be negative");
    expect(() => parseUsdc("abc")).toThrow("Invalid USDC amount format");
    expect(() => parseUsdc("1.2.3")).toThrow("Invalid USDC amount format");
    expect(() => parseUsdc("1.1234567")).toThrow("precision exceeds 6 decimals");
    expect(() => parseUsdc("0.0000001")).toThrow("precision exceeds 6 decimals");
  });
});

describe("formatUsdc", () => {
  // Default: minDecimals=2, maxDecimals=2, useGrouping=true
  it("formats standard amounts to 2 decimals by default", () => {
    expect(formatUsdc(1_000_000n)).toBe("1.00");
    expect(formatUsdc(0n)).toBe("0.00");
    expect(formatUsdc(1_500_000n)).toBe("1.50");
    expect(formatUsdc(100_000_000n)).toBe("100.00");
  });

  it("applies grouping by default", () => {
    expect(formatUsdc(1_000_000_000n)).toBe("1,000.00");
    expect(formatUsdc(12_480_000_000n)).toBe("12,480.00");
  });

  it("formats with explicit maxDecimals=6 when needed (proof layer ledger)", () => {
    expect(formatUsdc(1n, { maxDecimals: 6 })).toBe("0.000001");
    // minDecimals=2, maxDecimals=6: shows 6 significant fractional digits since they're non-zero
    expect(formatUsdc(123_456n, { maxDecimals: 6 })).toBe("0.123456");
    expect(formatUsdc(123_456n, { minDecimals: 6, maxDecimals: 6 })).toBe("0.123456");
    expect(formatUsdc(1_234_567n, { minDecimals: 6, maxDecimals: 6 })).toBe("1.234567");
  });

  it("respects formatting options", () => {
    expect(formatUsdc(1_000_000n, { minDecimals: 0, maxDecimals: 0 })).toBe("1");
    expect(formatUsdc(1_500_000n, { minDecimals: 1, maxDecimals: 1 })).toBe("1.5");
    expect(formatUsdc(123_456_789_000n, { minDecimals: 3, maxDecimals: 3 })).toBe("123,456.789");
  });

  it("handles negative amounts", () => {
    expect(formatUsdc(-1_000_000n)).toBe("-1.00");
  });
});

// ---------------------------------------------------------------------------
// formatEur
// ---------------------------------------------------------------------------
describe("formatEur", () => {
  it("formats EUR cents as whole euros with thousands separator", () => {
    expect(formatEur(0n)).toBe("€0");
    expect(formatEur(100n)).toBe("€1");
    expect(formatEur(1_248_000n)).toBe("€12,480");
    expect(formatEur(100_000_000n)).toBe("€1,000,000");
  });

  it("rounds down (floor) — never overstates", () => {
    expect(formatEur(199n)).toBe("€1"); // 199 cents = €1.99 → €1
    expect(formatEur(99n)).toBe("€0");  // 99 cents = €0.99 → €0
  });

  it("handles negative values", () => {
    expect(formatEur(-1_000n)).toBe("-€10");
  });

  it("handles very large values", () => {
    const big = 1_000_000_000_000n; // €10,000,000,000 (10 billion EUR cents)
    expect(formatEur(big)).toBe("€10,000,000,000");
  });
});

// ---------------------------------------------------------------------------
// parseRate
// ---------------------------------------------------------------------------
describe("parseRate", () => {
  it("parses 8-decimal rate strings", () => {
    expect(parseRate("1.08000000")).toBe(108_000_000n);
    expect(parseRate("1.00000000")).toBe(100_000_000n);
    expect(parseRate("1.12345678")).toBe(112_345_678n);
  });

  it("parses rates with fewer than 8 decimals", () => {
    expect(parseRate("1.08")).toBe(108_000_000n);
    expect(parseRate("1")).toBe(100_000_000n);
    expect(parseRate("2.5")).toBe(250_000_000n);
  });

  it("trims whitespace", () => {
    expect(parseRate("  1.08  ")).toBe(108_000_000n);
  });

  it("throws on invalid inputs", () => {
    expect(() => parseRate("0")).toThrow("positive");
    expect(() => parseRate("0.00000000")).toThrow("positive");
    expect(() => parseRate("-1.08")).toThrow();
    expect(() => parseRate("")).toThrow();
    expect(() => parseRate("1.123456789")).toThrow("8 decimal places");
  });
});

// ---------------------------------------------------------------------------
// usdcToEurCents
// ---------------------------------------------------------------------------
describe("usdcToEurCents", () => {
  const RATE_108 = 108_000_000n; // 1.08 USD/EUR

  it("converts correctly at 1.08 rate", () => {
    // 12,480 USDC → floor(12_480_000_000 * 10_000 / 108_000_000) = floor(1_155_555.5…) = 1_155_555
    expect(usdcToEurCents(12_480_000_000n, RATE_108)).toBe(1_155_555n);
  });

  it("rounds down (floor) — human layer never overstates", () => {
    // 1 USDC unit (0.000001 USDC) → floor(10_000 / 108_000_000) = 0
    expect(usdcToEurCents(1n, RATE_108)).toBe(0n);
  });

  it("converts exactly when divisible", () => {
    // 1 USDC = 1_000_000 units → floor(1_000_000 * 10_000 / 100_000_000) = 100 cents = €1
    expect(usdcToEurCents(1_000_000n, 100_000_000n)).toBe(100n); // at 1.00 rate
  });

  it("handles zero USDC", () => {
    expect(usdcToEurCents(0n, RATE_108)).toBe(0n);
  });

  it("throws on zero rate", () => {
    expect(() => usdcToEurCents(1_000_000n, 0n)).toThrow("positive");
  });

  it("handles very large USDC values", () => {
    // 1 billion USDC = 1_000_000_000_000_000n units
    const bigUsdc = 1_000_000_000n * RATE_108; // constructed to be exact
    const result = usdcToEurCents(bigUsdc, RATE_108);
    expect(result).toBe(bigUsdc * 10_000n / RATE_108); // reference equality
  });
});

// ---------------------------------------------------------------------------
// eurCentsToUsdc
// ---------------------------------------------------------------------------
describe("eurCentsToUsdc", () => {
  const RATE_108 = 108_000_000n; // 1.08 USD/EUR

  it("converts correctly at 1.08 rate (ceiling)", () => {
    // 1_155_555 * 108_000_000 = 124_799_940_000_000; / 10_000 = 12_479_994_000 exact (no remainder)
    expect(eurCentsToUsdc(1_155_555n, RATE_108)).toBe(12_479_994_000n);
  });

  it("applies ceiling — targets never under-collect", () => {
    // 1 EUR cent: ceil(108_000_000 / 10_000) = ceil(10800) = 10800 USDC units
    expect(eurCentsToUsdc(1n, RATE_108)).toBe(10_800n);
  });

  it("returns exact result when divisible (no ceiling needed)", () => {
    // 100 EUR cents at 1.00 = 1_000_000 USDC units
    expect(eurCentsToUsdc(100n, 100_000_000n)).toBe(1_000_000n);
  });

  it("handles zero EUR cents", () => {
    expect(eurCentsToUsdc(0n, RATE_108)).toBe(0n);
  });

  it("throws on zero rate", () => {
    expect(() => eurCentsToUsdc(100n, 0n)).toThrow("positive");
  });

  it("round-trip stays within 1 USDC unit of original", () => {
    const original = 12_480_000_000n; // 12,480 USDC
    const eur = usdcToEurCents(original, RATE_108);
    const backToUsdc = eurCentsToUsdc(eur, RATE_108);
    // ceil(floor(x)) ≥ x — we may collect a tiny bit more but never less
    expect(backToUsdc).toBeGreaterThanOrEqual(original - 10_800n); // within 1 cent
    expect(backToUsdc).toBeLessThanOrEqual(original + 10_800n);
  });
});
