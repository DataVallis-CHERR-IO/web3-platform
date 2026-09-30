/**
 * VoteMeter — Human layer.
 * Two rules: turnout (≥50% of donated money) and approval (≥51%).
 * All text comes via translated props (no hard-coded strings).
 */
import { cn } from "../lib/utils";

export interface VoteMeterProps {
  /** Current turnout 0–100 */
  turnout: number;
  /** Current approval 0–100 */
  approval: number;
  /** Required quorum, default 50 */
  quorum?: number;
  /** Required pass threshold, default 51 */
  pass?: number;
  /** e.g. "14 h 6 min" */
  closesIn?: string;
  /* Translated labels */
  turnoutLabel: string;
  approvalLabel: string;
  quorumNeededLabel: string;
  passNeededLabel: string;
  verdictMetLabel: string;
  verdictNotMetLabel: string;
  approvalMetLabel: string;
  approvalNotMetLabel: string;
  closesInLabel?: string;
}

export function VoteMeter({
  turnout,
  approval,
  quorum = 50,
  pass = 51,
  closesIn,
  turnoutLabel,
  approvalLabel,
  quorumNeededLabel,
  passNeededLabel,
  verdictMetLabel,
  verdictNotMetLabel,
  approvalMetLabel,
  approvalNotMetLabel,
  closesInLabel,
}: VoteMeterProps) {
  const turnoutMet = turnout >= quorum;
  const approvalMet = approval >= pass;

  return (
    <div className={cn("ch-vote")}>
      {/* Turnout line */}
      <div className="ch-vote-line">
        <div className="ch-vote-top">
          <span className="ch-vote-q">{turnoutLabel}</span>
          <span>
            <b>{turnout}%</b> / {quorumNeededLabel}
          </span>
        </div>
        <div
          className="ch-bar"
          role="progressbar"
          aria-valuenow={Math.min(turnout, 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={turnoutLabel}
        >
          <div className="ch-bar-fill" style={{ width: `${Math.min(turnout, 100)}%` }} />
          <div className="ch-bar-tick" style={{ left: `${quorum}%` }} aria-hidden="true" />
        </div>
        <div className="ch-vote-verdict">{turnoutMet ? verdictMetLabel : verdictNotMetLabel}</div>
      </div>

      {/* Approval line */}
      <div className="ch-vote-line">
        <div className="ch-vote-top">
          <span className="ch-vote-q">{approvalLabel}</span>
          <span>
            <b>{approval}%</b> / {passNeededLabel}
          </span>
        </div>
        <div
          className="ch-bar"
          role="progressbar"
          aria-valuenow={Math.min(approval, 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={approvalLabel}
        >
          <div className="ch-bar-fill" style={{ width: `${Math.min(approval, 100)}%` }} />
          <div className="ch-bar-tick" style={{ left: `${pass}%` }} aria-hidden="true" />
        </div>
        <div className="ch-vote-verdict">{approvalMet ? approvalMetLabel : approvalNotMetLabel}</div>
      </div>

      {closesIn && closesInLabel && (
        <div className="ch-vote-verdict" style={{ color: "var(--ink-muted)" }}>
          {closesInLabel}
        </div>
      )}
    </div>
  );
}
