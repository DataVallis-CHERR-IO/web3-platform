import { describe, it, expect } from "vitest";
import { parseUsdc, formatUsdc } from "../src/money.js";

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
  it("formats standard amounts to 2 decimals by default", () => {
    expect(formatUsdc(1_000_000n)).toBe("1.00");
    expect(formatUsdc(0n)).toBe("0.00");
    expect(formatUsdc(1_500_000n)).toBe("1.50");
    expect(formatUsdc(100_000_000n)).toBe("100.00");
  });

  it("formats precision amounts up to maxDecimals", () => {
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatUsdc(123_456n)).toBe("0.123456");
    expect(formatUsdc(1_234_567n)).toBe("1.234567");
  });

  it("respects formatting options", () => {
    expect(formatUsdc(1_000_000n, { minDecimals: 0 })).toBe("1");
    expect(formatUsdc(1_500_000n, { minDecimals: 1 })).toBe("1.5");
    expect(formatUsdc(1_000_000_000n, { useGrouping: true })).toBe("1,000.00");
    expect(formatUsdc(123_456_789_000n, { useGrouping: true })).toBe("123,456.789");
  });

  it("handles negative amounts", () => {
    expect(formatUsdc(-1_000_000n)).toBe("-1.00");
  });
});
