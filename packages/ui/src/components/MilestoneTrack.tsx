/**
 * MilestoneTrack — Human layer.
 * Three steps: released (ink), voting (hatch), locked (raised), rejected (danger).
 * amount is Money (bigint). Stacks vertically under 480px.
 */
import { cn } from "../lib/utils";
import { formatEur, formatUsdc } from "@cherrio/shared/money";
import type { Money } from "@cherrio/shared/money";

export type MilestoneState = "released" | "voting" | "locked" | "rejected";

export interface MilestoneTranche {
  /** Translated label e.g. "Step 1" */
  label?: string;
  amount: Money;
  state: MilestoneState;
  /** Translated state label from next-intl ui.milestone.* */
  stateLabel: string;
}

export interface MilestoneTrackProps {
  tranches: MilestoneTranche[];
  currency?: "EUR" | "USDC";
}

function formatAmount(amount: Money, currency: "EUR" | "USDC"): string {
  if (currency === "USDC") {
    const val = "usdc" in amount ? amount.usdc : amount.eurCents;
    return `${formatUsdc(val)} USDC`;
  }
  const val = "eurCents" in amount ? amount.eurCents : amount.usdc;
  return formatEur(val);
}

export function MilestoneTrack({ tranches, currency = "EUR" }: MilestoneTrackProps) {
  return (
    <div className={cn("ch-ms")}>
      {tranches.map((t, i) => (
        <div
          key={i}
          className="ch-ms-step"
          data-state={t.state}
        >
          {t.label && <span className="ch-label">{t.label}</span>}
          <span className="ch-ms-amt">{formatAmount(t.amount, currency)}</span>
          <span className="ch-ms-state">{t.stateLabel}</span>
        </div>
      ))}
    </div>
  );
}
