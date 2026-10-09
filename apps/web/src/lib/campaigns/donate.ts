import { USDC_UNIT, usdCentsToUsdc } from "@cherrio/shared/money";

// Amount rules of the donate panel (TASK-011b). Pure bigint logic shared by the
// browser panel and its tests — no floats, no React, no server imports.
//
// Product Spec §2.2: minimum donation 1 USDC (PlatformConfig.minDonation default
// 1e6); a donation above the remaining target is clipped by the contract, so the
// panel clips first and approves only what will be taken.

/** PlatformConfig.minDonation default. The contract read during the transaction is authoritative. */
export const MIN_DONATION_USDC = 1n * USDC_UNIT;

/** Quick amounts in cents of the field's currency (10 / 25 / 50 / 100 — € or $, ADR-060). */
export const QUICK_AMOUNTS_CENTS = [1_000n, 2_500n, 5_000n, 10_000n] as const;

const RATE_SCALE_18 = 10n ** 18n;

/**
 * "12", "12.5", "12,50", "1 000" → cents (bigint); null when it is not a
 * non-negative amount with at most two decimals.
 */
export function parseEurInput(input: string): bigint | null {
  const s = input.trim().replace(/[\s']/g, "").replace(",", ".");
  if (!/^\d{1,9}(\.\d{0,2})?$/.test(s)) return null;
  const [whole, fraction = ""] = s.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
}

/** "12", "12.5", "12.123456" → USDC units (6 decimals); null when invalid. */
export function parseUsdcInput(input: string): bigint | null {
  const s = input.trim().replace(/[\s']/g, "").replace(",", ".");
  if (!/^\d{1,12}(\.\d{0,6})?$/.test(s)) return null;
  const [whole, fraction = ""] = s.split(".");
  return BigInt(whole!) * USDC_UNIT + BigInt(fraction.padEnd(6, "0") || "0");
}

/**
 * EUR cents → USDC units with a display rate (USD per EUR × 1e18, ADR-040).
 * Rounded down: the donor never sends more than the euros they typed.
 */
export function eurCentsToUsdcAtRate(eurCents: bigint, usdPerEur18: bigint): bigint {
  if (usdPerEur18 <= 0n) throw new Error("Rate must be positive");
  if (eurCents < 0n) throw new Error("EUR amount must not be negative");
  return (eurCents * 10_000n * usdPerEur18) / RATE_SCALE_18;
}

export type DonationAmountCheck =
  /**
   * `usdc`: what the campaign will take (approved exactly); `send`: the amount
   * passed to donate(). They differ only when clipped: the contract checks the
   * minimum against the amount passed, then takes at most what is left.
   */
  | { ok: true; usdc: bigint; send: bigint; clipped: boolean }
  | { ok: false; reason: "invalid" | "below_minimum" | "nothing_left" };

/** What the amount field holds: EUR (needs a rate), USD (1 USD = 1 USDC, ADR-060) or USDC. */
export type DonationInputMode = "EUR" | "USD" | "USDC";

/**
 * The field's currency: the campaign's goal currency (ADR-060) — USD needs no
 * rate; EUR falls back to USDC when no EUR rate is available.
 */
export function donationInputMode(goalCurrency: string, usdPerEur18: bigint | null): DonationInputMode {
  if (goalCurrency === "USD") return "USD";
  return usdPerEur18 ? "EUR" : "USDC";
}

/**
 * Validates a typed amount and clips it to what the campaign still needs.
 * `mode` says what the field holds (see DonationInputMode).
 */
export function checkDonationAmount(args: {
  input: string;
  mode: DonationInputMode;
  usdPerEur18: bigint | null;
  remainingUsdc: bigint;
  minUsdc?: bigint;
}): DonationAmountCheck {
  const min = args.minUsdc ?? MIN_DONATION_USDC;
  let usdc: bigint;
  if (args.mode === "EUR") {
    if (args.usdPerEur18 === null) return { ok: false, reason: "invalid" };
    const cents = parseEurInput(args.input);
    if (cents === null || cents === 0n) return { ok: false, reason: "invalid" };
    if (cents < 100n) return { ok: false, reason: "below_minimum" };
    usdc = eurCentsToUsdcAtRate(cents, args.usdPerEur18);
  } else if (args.mode === "USD") {
    const cents = parseEurInput(args.input); // same format: up to two decimals
    if (cents === null || cents === 0n) return { ok: false, reason: "invalid" };
    usdc = usdCentsToUsdc(cents);
  } else {
    const parsed = parseUsdcInput(args.input);
    if (parsed === null || parsed === 0n) return { ok: false, reason: "invalid" };
    usdc = parsed;
  }
  if (usdc < min) return { ok: false, reason: "below_minimum" };
  if (args.remainingUsdc <= 0n) return { ok: false, reason: "nothing_left" };
  if (usdc > args.remainingUsdc) {
    // The last donation may be smaller than the minimum when it completes the target.
    return { ok: true, usdc: args.remainingUsdc, send: usdc, clipped: true };
  }
  return { ok: true, usdc, send: usdc, clipped: false };
}
