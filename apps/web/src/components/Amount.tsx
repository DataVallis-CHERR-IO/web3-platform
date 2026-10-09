import { getLocale, getTranslations } from "next-intl/server";
import { formatUsdc, type CampaignGoal } from "@cherrio/shared";
import { formatCurrencyAmount, getDisplayContext, goalAsUsdc, usdcIn } from "@/lib/fx/display";
import { formatGoal } from "@/lib/campaigns/goal";

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

/**
 * A campaign goal in the currency the fundraiser chose (ADR-060). In another
 * display currency it shows "≈ converted (original)", converted from the goal
 * currency: USD 1:1 to USDC, EUR at the current ECB rate (display only — the
 * campaign's USDC target keeps its own approval snapshot).
 */
export async function GoalAmount({ goal }: { goal: CampaignGoal }) {
  const [{ currency, rates }, locale, t] = await Promise.all([getDisplayContext(), getLocale(), getTranslations("fx")]);
  const original = formatGoal(goal, locale);
  if (currency === goal.currency) return <span className="whitespace-nowrap">{original}</span>;
  const usdc = goalAsUsdc(goal, rates);
  const value = usdc === null ? null : usdcIn(usdc, currency, rates);
  if (value === null) return <span className="whitespace-nowrap">{original}</span>;
  return <Converted converted={formatCurrencyAmount(value, currency, locale)} original={original} label={t("approxNote")} />;
}
