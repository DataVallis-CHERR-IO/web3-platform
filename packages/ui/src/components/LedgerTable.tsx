/**
 * LedgerTable — Proof layer only.
 * Every donation/payout as a row, newest first, each linking to Polygonscan.
 * amount is bigint (USDC units with 6 decimals). Scrolls horizontally on mobile.
 */
import { formatUsdc } from "@cherrio/shared/money";
import { cn } from "../lib/utils";

export interface LedgerRow {
  time: string;
  from: string;
  /** Shown instead of the truncated `from` address, e.g. a donor's name (ADR-043). */
  fromDisplay?: string;
  label?: string;
  /** USDC units (bigint, 6 decimals) */
  amount: bigint;
  tx: string;
}

export interface LedgerTableProps {
  rows: LedgerRow[];
  /** Tx URL prefix; null renders the hash without a link (no explorer, e.g. a local chain). */
  explorerBase?: string | null;
  caption?: string;
  colTime?: string;
  colFrom?: string;
  colType?: string;
  colAmount?: string;
  colTx?: string;
  /** Accessible name of a tx link; receives the shortened hash. */
  txAriaLabel?: (shortTx: string) => string;
  /**
   * Accessible name of the scroll region. The wrapper scrolls horizontally on
   * narrow screens, so it is focusable and named (keyboard users can scroll it).
   */
  regionLabel?: string;
  className?: string;
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function LedgerTable({
  rows,
  explorerBase = "https://amoy.polygonscan.com/tx/",
  caption,
  colTime = "TIME",
  colFrom = "FROM",
  colType = "TYPE",
  colAmount = "AMOUNT",
  colTx = "TX",
  txAriaLabel,
  regionLabel,
  className,
}: LedgerTableProps) {
  return (
    <div className={cn("ch-ledger-wrap", className)} role="region" tabIndex={0} aria-label={regionLabel ?? caption ?? colTx}>
      <table className="ch-ledger">
        {caption && (
          <caption
            className="ch-ledger-muted"
            style={{ captionSide: "bottom", padding: "8px 12px", textAlign: "left" }}
          >
            {caption}
          </caption>
        )}
        <thead>
          <tr>
            <th>{colTime}</th>
            <th>{colFrom}</th>
            <th>{colType}</th>
            <th className="ch-num">{colAmount}</th>
            <th>{colTx}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td className="ch-ledger-muted">{row.time}</td>
              <td title={row.from}>{row.fromDisplay ?? truncateAddress(row.from)}</td>
              <td className="ch-ledger-muted">{row.label ?? "—"}</td>
              <td className="ch-num">{formatUsdc(row.amount)} USDC</td>
              <td>
                {explorerBase === null ? (
                  <span title={row.tx}>{row.tx.slice(0, 8)}…</span>
                ) : (
                <a
                  href={`${explorerBase}${row.tx}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={txAriaLabel ? txAriaLabel(`${row.tx.slice(0, 8)}…`) : `Transaction ${row.tx.slice(0, 8)}… on Polygonscan`}
                >
                  {row.tx.slice(0, 8)}…
                  <span aria-hidden="true"> ↗</span>
                </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
