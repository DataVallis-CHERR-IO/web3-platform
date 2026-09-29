export const USDC_DECIMALS = 6;
export const USDC_UNIT = 10n ** BigInt(USDC_DECIMALS); // 1_000_000n

export interface FormatUsdcOptions {
  /** Minimum decimal places to show. Defaults to 2. */
  minDecimals?: number;
  /** Maximum decimal places to show. Defaults to 6. */
  maxDecimals?: number;
  /** Whether to format with thousand commas. Defaults to false. */
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
 * Formats a 6-decimal bigint USDC amount into a string.
 */
export function formatUsdc(amount: bigint, options: FormatUsdcOptions = {}): string {
  if (typeof amount !== "bigint") {
    throw new Error("Invalid amount: must be a bigint");
  }

  const { minDecimals = 2, maxDecimals = 6, useGrouping = false } = options;

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
