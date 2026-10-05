import { getLocale, getTranslations } from "next-intl/server";
import { formatUsdc } from "@cherrio/shared";
import { eurCentsAsUsdc, formatCurrencyAmount, getDisplayContext, usdcIn } from "@/lib/fx/display";

// Amounts in the visitor's display currency (ADR-040). The converted value is
// marked "≈"; the exact original always stays next to it. When the visitor's
// currency is the original one, or no rate is usable, only the original shows.

function Converted({ converted, original, label }: { converted: string; original: string; label: string }) {
  return (
    // The converted figure and the original stay whole, but the original may wrap
    // under it in a narrow column (campaign cards) instead of overflowing it.
    <span title={label}>
      <span className="whitespace-nowrap">≈ {converted}</span>{" "}
      <span className="whitespace-nowrap text-[var(--ink-muted)] text-[0.85em]">({original})</span>
    </span>
  );
}

/** A USDC amount (6 decimals, bigint). */
export async function UsdcAmount({ usdc, maxDecimals = 2 }: { usdc: bigint; maxDecimals?: number }) {
  const [{ currency, rates }, locale, t] = await Promise.all([getDisplayContext(), getLocale(), getTranslations("fx")]);
  const original = t("usdc", { amount: formatUsdc(usdc, { maxDecimals }) });
  if (currency === "USDC") return <span className="whitespace-nowrap">{original}</span>;
  const value = usdcIn(usdc, currency, rates);
  if (value === null) return <span className="whitespace-nowrap">{original}</span>;
  return <Converted converted={formatCurrencyAmount(value, currency, locale)} original={original} label={t("approxNote")} />;
}

/** A euro amount in cents (bigint), e.g. a campaign target. */
export async function EurAmount({ eurCents }: { eurCents: bigint }) {
  const [{ currency, rates }, locale, t] = await Promise.all([getDisplayContext(), getLocale(), getTranslations("fx")]);
  const whole = eurCents % 100n === 0n;
  const euros = `${eurCents / 100n}.${(eurCents % 100n).toString().padStart(2, "0")}`;
  const original = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(euros as unknown as number);
  if (currency === "EUR") return <span className="whitespace-nowrap">{original}</span>;
  const usdc = eurCentsAsUsdc(eurCents, rates);
  const value = usdc === null ? null : usdcIn(usdc, currency, rates);
  if (value === null) return <span className="whitespace-nowrap">{original}</span>;
  return <Converted converted={formatCurrencyAmount(value, currency, locale)} original={original} label={t("approxNote")} />;
}
