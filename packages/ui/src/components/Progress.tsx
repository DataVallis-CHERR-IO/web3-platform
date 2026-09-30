/**
 * Progress — Human layer (EUR) or proof layer (USDC).
 * raised/target accept Money ({ eurCents: bigint } | { usdc: bigint }) — bigint only.
 * Shows a 10% success line as a dashed tick.
 */
import { formatEur, formatUsdc } from "@cherrio/shared/money";
import type { Money } from "@cherrio/shared/money";
import { cn } from "../lib/utils";

export interface ProgressProps {
  raised: Money;
  target: Money;
  threshold?: number;
  /** "EUR" (default, human layer) or "USDC" (proof layer) */
  currency?: "EUR" | "USDC";
  /** e.g. "312 donors · 9 days left" */
  meta?: string;
  /** Translated success-line text, e.g. "Succeeds at 10% (€2,000)" */
  successLineLabel?: string;
  /** Translated will-succeed text, e.g. "Campaign will succeed" */
  willSucceedLabel?: string;
}

function extractBigint(m: Money, currency: "EUR" | "USDC"): bigint {
  if (currency === "EUR") {
    return "eurCents" in m ? m.eurCents : m.usdc; // fallback: treat usdc as cents for display
  }
  return "usdc" in m ? m.usdc : m.eurCents;
}

function formatMoney(val: bigint, currency: "EUR" | "USDC"): string {
  return currency === "EUR" ? formatEur(val) : `${formatUsdc(val)} USDC`;
}

export function Progress({
  raised,
  target,
  threshold = 0.1,
  currency = "EUR",
  meta,
  successLineLabel,
  willSucceedLabel,
}: ProgressProps) {
  const raisedVal = extractBigint(raised, currency);
  const targetVal = extractBigint(target, currency);

  const pct = targetVal > 0n
    ? Number((raisedVal * 10000n) / targetVal) / 100
    : 0;
  const fillPct = Math.min(pct, 100);
  const thresholdPct = threshold * 100;
  const willSucceed = pct >= thresholdPct;

  const raisedStr = formatMoney(raisedVal, currency);
  const targetStr = formatMoney(targetVal, currency);

  return (
    <div className={cn("ch-progress")} role="group">
      <div className="ch-progress-figures">
        <span className="ch-progress-raised">{raisedStr}</span>
        <span className="ch-progress-target">{targetStr}</span>
      </div>

      <div
        className="ch-bar"
        role="progressbar"
        aria-valuenow={Math.round(fillPct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={raisedStr}
      >
        <div
          className="ch-bar-fill"
          data-full={fillPct >= 100 ? "true" : undefined}
          style={{ width: `${fillPct}%` }}
        />
        {thresholdPct > 0 && thresholdPct < 100 && (
          <div
            className="ch-bar-tick"
            style={{ left: `${thresholdPct}%` }}
            aria-hidden="true"
          />
        )}
      </div>

      <div className="ch-progress-meta">
        {meta && <span>{meta}</span>}
        {successLineLabel && (
          <span>{willSucceed ? <><span aria-hidden="true">✓ </span>{willSucceedLabel ?? successLineLabel}</> : successLineLabel}</span>
        )}
      </div>
    </div>
  );
}
