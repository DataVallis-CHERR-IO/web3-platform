import { describe, expect, it } from "vitest";
import {
  DISPLAY_CURRENCIES,
  convertUsdc,
  currencyForLanguages,
  isDisplayCurrency,
  parseLanguageHeader,
  parseScaled18,
  roundScaled,
} from "../src/display-currency";

const R = 10n ** 18n;

describe("display currencies", () => {
  it("has EUR, the ECB currencies and BTC/ETH/POL/USDC, each once", () => {
    const codes = DISPLAY_CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of ["EUR", "USD", "GBP", "CHF", "JPY", "BTC", "ETH", "POL", "USDC"]) expect(codes).toContain(code);
    expect(DISPLAY_CURRENCIES.filter((c) => c.kind === "fiat")).toHaveLength(30);
    expect(isDisplayCurrency("CHF")).toBe(true);
    expect(isDisplayCurrency("chf")).toBe(false);
    expect(isDisplayCurrency("XYZ")).toBe(false);
    expect(isDisplayCurrency(undefined)).toBe(false);
  });
});

describe("currencyForLanguages", () => {
  it.each([
    [["sl-SI", "en"], "EUR"],
    [["en-GB"], "GBP"],
    [["de-CH", "de"], "CHF"],
    [["en-US"], "USD"],
    [["ja"], "JPY"],
    [["sl"], "EUR"],
    [["zh-Hant-HK"], "HKD"],
    [["en", "pt-BR"], "BRL"], // a region later in the list beats a language without one
    [["en"], "USD"],
    [["xx-ZZ"], "USD"],
    [[], "USD"],
  ])("%j → %s", (tags, currency) => {
    expect(currencyForLanguages(tags)).toBe(currency);
  });

  it("reads Accept-Language by weight", () => {
    expect(parseLanguageHeader("en;q=0.5, de-CH;q=0.9, *;q=0.1")).toEqual(["de-CH", "en"]);
    expect(parseLanguageHeader("sl-SI,sl;q=0.9,en-US;q=0.8")).toEqual(["sl-SI", "sl", "en-US"]);
    expect(parseLanguageHeader("fr;q=0")).toEqual([]);
    expect(parseLanguageHeader(null)).toEqual([]);
    expect(currencyForLanguages(parseLanguageHeader("en;q=0.5, de-CH;q=0.9"))).toBe("CHF");
  });
});

describe("conversion and rounding", () => {
  it("converts USDC with a USD-per-unit rate", () => {
    // 561.25 USDC at 1 EUR = 1.1225 USD → exactly 500 EUR
    expect(roundScaled(convertUsdc(561_250_000n, parseScaled18("1.1225")!), 2)).toBe("500.00");
    // 100 USDC at 1 JPY = 0.0067 USD → 14925.37… → 14925 JPY
    expect(roundScaled(convertUsdc(100_000_000n, parseScaled18("0.0067")!), 0)).toBe("14925");
    // 561.25 USDC at 1 BTC = 65000 USD → 0.0086346153… BTC
    expect(roundScaled(convertUsdc(561_250_000n, 65_000n * R), 8)).toBe("0.00863462");
    expect(() => convertUsdc(1n, 0n)).toThrow(RangeError);
  });

  it("rounds half-up at the shown decimals", () => {
    expect(roundScaled(1_005n * 10n ** 15n, 2)).toBe("1.01"); // 1.005 → 1.01
    expect(roundScaled(1_004_999_999_999_999_999n, 2)).toBe("1.00");
    expect(roundScaled(2_500_000_000_000_000_000n, 0)).toBe("3");
    expect(roundScaled(-1_005n * 10n ** 15n, 2)).toBe("-1.01");
    expect(roundScaled(4n * 10n ** 15n, 2)).toBe("0.00");
    expect(roundScaled(0n, 0)).toBe("0");
    expect(roundScaled(123n * R, 18)).toBe("123.000000000000000000");
  });

  it("parses decimal rates exactly, including exponents, and refuses the rest", () => {
    expect(parseScaled18("1.1734")).toBe(1_173_400_000_000_000_000n);
    expect(parseScaled18("65000")).toBe(65_000n * R);
    expect(parseScaled18("6.5e-5")).toBe(65_000_000_000_000n);
    expect(parseScaled18("1.5e3")).toBe(1_500n * R);
    expect(parseScaled18("0.1234567890123456789")).toBe(123_456_789_012_345_678n); // past 18 decimals: cut
    for (const bad of ["", "0", "-1", "1,5", "abc", "1.", ".5", "Infinity", "1e999"]) expect(parseScaled18(bad)).toBeNull();
  });
});
