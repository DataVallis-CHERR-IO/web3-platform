export const USDC_DECIMALS = 6;
export const USDC_UNIT = 10n ** BigInt(USDC_DECIMALS); // 1_000_000n

// ---------------------------------------------------------------------------
// Money type (bigint only — never number or float)
// ---------------------------------------------------------------------------

/**
 * Exchange rate: USD per 1 EUR, stored as integer × 1e8.
 * Matches campaigns.eur_usd_rate numeric(18,8).
 * e.g. 1.08 USD/EUR → 108_000_000n
 */
export type EurUsdRate = bigint;

/**
 * Display money as either EUR cents (bigint) or USDC units (bigint, 6 dec).
 * Components accept this type for raised/target amounts.
 */
export type Money = { eurCents: bigint } | { usdc: bigint };

// ---------------------------------------------------------------------------
// Rate helpers
// ---------------------------------------------------------------------------

/**
 * Parse a decimal rate string (e.g. "1.08000000") into EurUsdRate (× 1e8).
 * Throws if the string has more than 8 decimal places or is not a valid positive number.
 */
export function parseRate(decimalString: string): EurUsdRate {
  const trimmed = decimalString.trim();
  if (!trimmed || trimmed.startsWith("-")) {
    throw new Error(`Invalid rate: "${decimalString}"`);
  }
  const [intPart = "0", fracPart = ""] = trimmed.split(".");
  if (fracPart.length > 8) {
    throw new Error(`Rate has more than 8 decimal places: "${decimalString}"`);
  }
  const padded = fracPart.padEnd(8, "0");
  const result = BigInt(intPart) * 100_000_000n + BigInt(padded);
  if (result === 0n) throw new Error("Rate must be positive");
  return result;
}

// ---------------------------------------------------------------------------
// Conversion helpers (bigint arithmetic, floor / ceil as documented)
// ---------------------------------------------------------------------------

/**
 * Convert USDC units (6 dec) to EUR cents.
 * Rounded DOWN — the human layer never overstates money.
 * Formula: usdc * 10_000 / rate
 *
 * Derivation:
 *   EUR = USDC_units / 1e6 / rate_decimal
 *   EUR_cents = EUR * 100 = USDC_units * 100 / (1e6 * rate / 1e8)
 *             = USDC_units * 100 * 1e8 / (1e6 * rate)
 *             = USDC_units * 10_000 / rate
 */
export function usdcToEurCents(usdc: bigint, rate: EurUsdRate): bigint {
  if (rate <= 0n) throw new Error("Rate must be positive");
  return (usdc * 10_000n) / rate; // bigint division truncates toward zero = floor for positives
}

/**
 * Convert EUR cents to USDC units (6 dec) at a campaign's approval (ADR-036).
 * Rounded DOWN: target_usdc = floor(eurCents × rate × 10^4 / 10^8), all in
 * integer arithmetic, so the stored snapshot reproduces the target exactly.
 */
export function eurCentsToUsdc(eurCents: bigint, rate: EurUsdRate): bigint {
  if (rate <= 0n) throw new Error("Rate must be positive");
  if (eurCents < 0n) throw new Error("EUR amount must not be negative");
  return (eurCents * rate) / 10_000n; // bigint division truncates = floor for non-negative values
}

/**
 * USD cents to USDC units (6 dec) at approval (ADR-060): 1 USD = 1 USDC, the
 * same peg assumption the display uses. Exact: cents × 10^4.
 */
export function usdCentsToUsdc(usdCents: bigint): bigint {
  if (usdCents < 0n) throw new Error("USD amount must not be negative");
  return usdCents * 10_000n;
}

/**
 * A rate × 1e8 (e.g. USD per EUR) as the numeric(18,8) column text: 117_340_000n → "1.17340000".
 * Lives here, not as a local arrow in the web app: once the minifier inlined that
 * arrow, Next's build-time file tracer (@vercel/nft) evaluated `rate / 100000000n`
 * with an unknown `rate` and failed the build ("Cannot mix BigInt", TASK-060).
 */
export function rateToNumeric8(rate: bigint): string {
  if (rate < 0n) throw new Error("Rate must not be negative");
  const whole = rate / 100_000_000n;
  const fraction = rate % 100_000_000n;
  return `${whole}.${fraction.toString().padStart(8, "0")}`;
}

/** The smallest target `CampaignFactory.createCampaign` accepts: 100 USDC. */
export const MIN_CAMPAIGN_TARGET_USDC = 100n * USDC_UNIT;

// ---------------------------------------------------------------------------
// Display formatters
// ---------------------------------------------------------------------------

/**
 * Format EUR cents as whole euros, rounded down, with thousands separator.
 * Human layer only — no decimals.
 * e.g. 1_248_000n → "€12,480"
 */
export function formatEur(eurCents: bigint): string {
  if (typeof eurCents !== "bigint") {
    throw new Error("formatEur: eurCents must be bigint");
  }
  const isNeg = eurCents < 0n;
  const abs = isNeg ? -eurCents : eurCents;
  const wholeEuros = abs / 100n; // floor — never overstate
  const str = wholeEuros
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${isNeg ? "-" : ""}€${str}`;
}

export interface FormatUsdcOptions {
  /** Minimum decimal places to show. Defaults to 2. */
  minDecimals?: number;
  /** Maximum decimal places to show. Defaults to 2. */
  maxDecimals?: number;
  /** Whether to format with thousand commas. Defaults to true. */
  useGrouping?: boolean;
}

/**
 * Parses a string representation of USDC amount into a 6-decimal bigint.
 * Accepts formats like "10", "10.5", "10.50", "1,000.25", "0.000001".
 * Throws on negative amounts, invalid characters, or precision > 6 decimals.
 */
export function parseUsdc(value: string): bigint {
  if (!value || typeof value !== "string") {
    throw new Error("Invalid USDC amount: value must be a non-empty string");
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error("Invalid USDC amount: empty string");
  }

  // Reject negative numbers
  if (trimmed.startsWith("-")) {
    throw new Error("Invalid USDC amount: amount cannot be negative");
  }

  // Remove valid commas (thousand separators)
  const normalized = trimmed.replace(/,/g, "");

  // Match positive decimal pattern: e.g. "123", "123.456", ".456"
  const regex = /^(?:(\d+)(?:\.(\d+))?|(?:\.(\d+)))$/;
  const match = normalized.match(regex);
  if (!match) {
    throw new Error(`Invalid USDC amount format: "${value}"`);
  }

  const integerPart = match[1] ?? "0";
  const fractionalPart = match[2] ?? match[3] ?? "";

  if (fractionalPart.length > USDC_DECIMALS) {
    throw new Error(
      `Invalid USDC amount: precision exceeds ${USDC_DECIMALS} decimals ("${value}")`
    );
  }

  const paddedFraction = fractionalPart.padEnd(USDC_DECIMALS, "0");
  const whole = BigInt(integerPart) * USDC_UNIT;
  const fraction = BigInt(paddedFraction);

  return whole + fraction;
}

/**
 * Format a 6-decimal bigint USDC amount for display.
 * Defaults: 2 decimal places, thousands separator ON.
 * e.g. 12_480_000_000n → "12,480.00 USDC" when suffix is appended by caller.
 * Proof layer only — never show in the human layer.
 */
export function formatUsdc(amount: bigint, options: FormatUsdcOptions = {}): string {
  if (typeof amount !== "bigint") {
    throw new Error("Invalid amount: must be a bigint");
  }

  const { minDecimals = 2, maxDecimals = 2, useGrouping = true } = options;

  const isNegative = amount < 0n;
  const absAmount = isNegative ? -amount : amount;

  const whole = absAmount / USDC_UNIT;
  const remainder = absAmount % USDC_UNIT;

  let fractionStr = remainder.toString().padStart(USDC_DECIMALS, "0");

  // Trim trailing zeros beyond minDecimals
  let end = USDC_DECIMALS;
  while (end > minDecimals && fractionStr[end - 1] === "0") {
    end--;
  }
  // Cap at maxDecimals
  if (end > maxDecimals) {
    end = Math.max(maxDecimals, minDecimals);
  }
  fractionStr = fractionStr.slice(0, end);

  let wholeStr = whole.toString();
  if (useGrouping) {
    wholeStr = wholeStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  const sign = isNegative ? "-" : "";
  if (fractionStr.length === 0) {
    return `${sign}${wholeStr}`;
  }

  return `${sign}${wholeStr}.${fractionStr}`;
}
