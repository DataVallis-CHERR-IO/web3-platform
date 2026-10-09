import type { CampaignGoal } from "@cherrio/shared";

// ADR-060: a campaign goal as the fundraiser set it (EUR or USD). Pure helpers,
// safe for server, client, the link preview and the embed widget.

/** Whole units and the cents left over, both as decimal strings. */
function split(goal: CampaignGoal): { whole: string; cents: string } {
  const whole = goal.minor / 100n;
  const cents = goal.minor % 100n;
  return { whole: String(whole), cents: String(cents).padStart(2, "0") };
}

/** "€15,000", "$12,500.50"; whole amounts without decimals. `wholeOnly` rounds down to whole units. */
export function formatGoal(goal: CampaignGoal, locale: string, opts: { wholeOnly?: boolean } = {}): string {
  const { whole, cents } = split(goal);
  const exact = cents === "00";
  const digits = opts.wholeOnly || exact ? 0 : 2;
  // A decimal string keeps every digit (Intl.NumberFormat v3); no float conversion.
  const decimal = digits === 0 ? whole : `${whole}.${cents}`;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: goal.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(decimal as unknown as number);
}

/** Whole units as entered in the campaign form ("15000"). */
export function goalWholeUnits(goal: CampaignGoal): string {
  return split(goal).whole;
}
