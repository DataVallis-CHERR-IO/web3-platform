// Display currency (ADR-040): amounts can be shown in a currency the visitor
// chooses. Display only — contracts, the database and all money logic stay in
// USDC (6 decimals) and EUR targets. Rates are "USD per one unit" of a currency,
// scaled × 10^18, with 1 USDC = 1 USD (ADR-036).

export type DisplayCurrencyKind = "fiat" | "crypto";

export interface DisplayCurrency {
  code: string;
  kind: DisplayCurrencyKind;
  /** Decimals shown (rounded half-up). */
  decimals: number;
}

// Fiat: EUR plus the currencies of the ECB daily reference rates. Crypto: the
// few a donor is likely to think in. The order is the selector's order.
const FIAT: ReadonlyArray<[string, number]> = [
  ["EUR", 2], ["USD", 2], ["GBP", 2], ["CHF", 2], ["JPY", 0], ["CAD", 2], ["AUD", 2], ["NZD", 2],
  ["SEK", 2], ["NOK", 2], ["DKK", 2], ["ISK", 0], ["PLN", 2], ["CZK", 2], ["HUF", 0], ["RON", 2],
  ["TRY", 2], ["ILS", 2], ["ZAR", 2], ["BRL", 2], ["MXN", 2], ["CNY", 2], ["HKD", 2], ["SGD", 2],
  ["KRW", 0], ["INR", 2], ["IDR", 0], ["MYR", 2], ["PHP", 2], ["THB", 2],
];
const CRYPTO: ReadonlyArray<[string, number]> = [["USDC", 2], ["BTC", 8], ["ETH", 6], ["POL", 2]];

export const DISPLAY_CURRENCIES: readonly DisplayCurrency[] = [
  ...FIAT.map(([code, decimals]) => ({ code, kind: "fiat" as const, decimals })),
  ...CRYPTO.map(([code, decimals]) => ({ code, kind: "crypto" as const, decimals })),
];

const BY_CODE = new Map(DISPLAY_CURRENCIES.map((c) => [c.code, c]));

export const DEFAULT_DISPLAY_CURRENCY = "USD";
/** Cookie that keeps the visitor's choice (not secret; read by the page too). */
export const DISPLAY_CURRENCY_COOKIE = "cherrio_currency";

export function isDisplayCurrency(code: unknown): code is string {
  return typeof code === "string" && BY_CODE.has(code);
}

export function displayCurrency(code: string): DisplayCurrency | undefined {
  return BY_CODE.get(code);
}

// Region → currency, for the regions whose currency we can show.
const EURO_REGIONS = [
  "AT", "BE", "BG", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT",
  "NL", "PT", "SI", "SK", "AD", "MC", "SM", "VA", "ME", "XK",
];
const REGION_CURRENCY: Record<string, string> = {
  ...Object.fromEntries(EURO_REGIONS.map((r) => [r, "EUR"])),
  US: "USD", GB: "GBP", CH: "CHF", LI: "CHF", JP: "JPY", CA: "CAD", AU: "AUD", NZ: "NZD", SE: "SEK",
  NO: "NOK", DK: "DKK", IS: "ISK", PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", TR: "TRY", IL: "ILS",
  ZA: "ZAR", BR: "BRL", MX: "MXN", CN: "CNY", HK: "HKD", SG: "SGD", KR: "KRW", IN: "INR", ID: "IDR",
  MY: "MYR", PH: "PHP", TH: "THB",
};
// A language tag without a region ("sl", "ja"): only where the language points to one currency.
const LANGUAGE_CURRENCY: Record<string, string> = {
  sl: "EUR", hr: "EUR", de: "EUR", fr: "EUR", it: "EUR", es: "EUR", nl: "EUR", fi: "EUR", et: "EUR",
  lv: "EUR", lt: "EUR", sk: "EUR", el: "EUR", mt: "EUR", ga: "EUR", bg: "EUR",
  ja: "JPY", pl: "PLN", cs: "CZK", da: "DKK", sv: "SEK", nb: "NOK", nn: "NOK", no: "NOK", is: "ISK",
  hu: "HUF", ro: "RON", tr: "TRY", he: "ILS", ko: "KRW", zh: "CNY", th: "THB", id: "IDR", ms: "MYR",
};

/** Language tags from an `Accept-Language` header, most preferred first. */
export function parseLanguageHeader(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .slice(0, 20)
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((x) => x.tag && x.tag !== "*" && x.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((x) => x.tag);
}

/**
 * The default display currency for a visitor's languages (`navigator.languages`
 * or a parsed `Accept-Language`): the first tag with a known region decides,
 * then the first language that maps to one currency, else USD.
 */
export function currencyForLanguages(tags: readonly string[]): string {
  for (const tag of tags) {
    const parts = tag.split(/[-_]/);
    // The region is the first 2-letter (or 3-digit) subtag after the language (skipping a script like "Hant").
    const region = parts.slice(1).find((p) => /^[A-Za-z]{2}$/.test(p))?.toUpperCase();
    if (region && REGION_CURRENCY[region]) return REGION_CURRENCY[region];
  }
  for (const tag of tags) {
    const language = tag.split(/[-_]/)[0]?.toLowerCase() ?? "";
    if (LANGUAGE_CURRENCY[language]) return LANGUAGE_CURRENCY[language];
  }
  return DEFAULT_DISPLAY_CURRENCY;
}

export const RATE_SCALE = 10n ** 18n;

/**
 * A USDC amount (6 decimals) in units of a currency, scaled × 10^18:
 * `usdc / 10^6 USD ÷ (usdPerUnit18 / 10^18)` = `usdc × 10^30 ÷ usdPerUnit18` (truncated; rounding is done for display).
 */
export function convertUsdc(usdc: bigint, usdPerUnit18: bigint): bigint {
  if (usdPerUnit18 <= 0n) throw new RangeError("rate must be positive");
  return (usdc * 10n ** 30n) / usdPerUnit18;
}

/** A value scaled × 10^18 as a decimal string with `decimals` places, rounded half-up (away from zero). */
export function roundScaled(value18: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new RangeError("decimals must be 0–18");
  const negative = value18 < 0n;
  const abs = negative ? -value18 : value18;
  const step = 10n ** BigInt(18 - decimals);
  const rounded = (abs + step / 2n) / step; // half-up on the dropped digits
  const unit = 10n ** BigInt(decimals);
  const whole = rounded / unit;
  const fraction = (rounded % unit).toString().padStart(decimals, "0");
  const text = decimals > 0 ? `${whole}.${fraction}` : `${whole}`;
  return negative && rounded !== 0n ? `-${text}` : text;
}

/** A decimal string (e.g. "1.1734", "0.000012") as an integer × 10^18; null when it is not a plain positive decimal. */
export function parseScaled18(text: string): bigint | null {
  let plain = text.trim();
  // JSON may write a number with an exponent ("6.5e-5"); move the decimal point instead of using a float.
  const exp = /^(\d{1,20})(?:\.(\d{1,30}))?[eE]([+-]?\d{1,2})$/.exec(plain);
  if (exp) {
    const digits = `${exp[1]}${exp[2] ?? ""}`;
    const point = exp[1]!.length + Number(exp[3]);
    plain =
      point <= 0
        ? `0.${"0".repeat(-point)}${digits}`
        : point >= digits.length
          ? digits + "0".repeat(point - digits.length)
          : `${digits.slice(0, point)}.${digits.slice(point)}`;
    plain = plain.replace(/^0+(?=\d)/, "");
  }
  const match = /^(\d{1,20})(?:\.(\d{1,40}))?$/.exec(plain);
  if (!match) return null;
  const fraction = (match[2] ?? "").slice(0, 18).padEnd(18, "0");
  const value = BigInt(match[1]!) * RATE_SCALE + BigInt(fraction);
  return value > 0n ? value : null;
}
