import { cache } from "react";
import { cookies, headers } from "next/headers";
import { after } from "next/server";
import {
  DISPLAY_CURRENCY_COOKIE,
  convertUsdc,
  currencyForLanguages,
  displayCurrency,
  isDisplayCurrency,
  parseLanguageHeader,
  roundScaled,
} from "@cherrio/shared";
import { getDb } from "@/lib/db";
import { fetchCryptoRates, fetchEcbRates } from "./sources";
import { getDisplayRates, type DisplayRate } from "./rates";

// Server side of the display currency (ADR-040): which currency this request
// shows, and amounts formatted in it. Display only.

/** The visitor's currency: a valid cookie, else the browser languages (Accept-Language), else USD. */
export async function resolveDisplayCurrency(): Promise<string> {
  const chosen = (await cookies()).get(DISPLAY_CURRENCY_COOKIE)?.value;
  if (isDisplayCurrency(chosen)) return chosen;
  return currencyForLanguages(parseLanguageHeader((await headers()).get("accept-language")));
}

export interface DisplayContext {
  currency: string;
  rates: Map<string, DisplayRate>;
}

/** Once per request: the currency and the usable rates (a refresh runs after the response). */
export const getDisplayContext = cache(async (): Promise<DisplayContext> => {
  const currency = await resolveDisplayCurrency();
  let rates = new Map<string, DisplayRate>();
  try {
    rates = await getDisplayRates(getDb(), {
      fetchEcb: () => fetchEcbRates(),
      fetchCrypto: () => fetchCryptoRates(),
      now: () => new Date(),
      schedule: (work) => after(work),
    });
  } catch (error) {
    // Rates are a convenience: without them the original amounts are shown.
    console.error(`[fx] rates unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { currency, rates };
});

/** An amount (decimal string) with its currency, e.g. "CHF 1,234.56", "¥14,925", "0.00863462 BTC". */
/** From this magnitude on a converted figure is shown in whole units (David 2026-10-05: "brez decimalk"). */
export const WHOLE_UNITS_FROM = 1000;

/** True when |decimal| ≥ WHOLE_UNITS_FROM, read from the string (no float). */
function isLarge(decimal: string): boolean {
  const whole = decimal.replace(/^-/, "").split(".")[0]!.replace(/^0+/, "");
  return whole.length > String(WHOLE_UNITS_FROM).length - 1;
}

/**
 * A converted amount for display. Below 1,000 it keeps the currency's decimals
 * (€500.00, 20.28 POL, 0.2200125 BTC); from 1,000 on it is shown in whole
 * units (≈ 5,495,542 POL) — the "≈" already marks it as an approximation and the
 * exact original is shown next to it.
 */
export function formatCurrencyAmount(decimal: string, code: string, locale: string): string {
  const info = displayCurrency(code);
  const digits = isLarge(decimal) ? 0 : (info?.decimals ?? 2);
  // A decimal string keeps every digit (Intl.NumberFormat v3); no float conversion.
  const value = decimal as unknown as number;
  if (info?.kind === "fiat") {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  }
  const number = new Intl.NumberFormat(locale, { minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: digits }).format(value);
  return `${number} ${code}`;
}

/** A USDC amount in `code`, to the shown decimals; null when there is no usable rate. */
export function usdcIn(usdc: bigint, code: string, rates: Map<string, DisplayRate>): string | null {
  const rate = rates.get(code);
  const info = displayCurrency(code);
  if (!rate || !info) return null;
  return roundScaled(convertUsdc(usdc, rate.usdPerUnit18), info.decimals);
}

/** EUR cents as USDC at the current ECB rate (display only; campaign targets keep their own snapshot). */
export function eurCentsAsUsdc(eurCents: bigint, rates: Map<string, DisplayRate>): bigint | null {
  const eur = rates.get("EUR");
  if (!eur) return null;
  // eurCents / 100 EUR × usdPerEur → micro-USD: eurCents × 10^4 × usdPerEur18 / 10^18
  return (eurCents * 10_000n * eur.usdPerUnit18) / 10n ** 18n;
}
