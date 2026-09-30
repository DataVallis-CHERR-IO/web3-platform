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
  label?: string;
  /** USDC units (bigint, 6 decimals) */
  amount: bigint;
  tx: string;
}

export interface LedgerTableProps {
  rows: LedgerRow[];
  explorerBase?: string;
  caption?: string;
  colTime?: string;
  colFrom?: string;
  colType?: string;
  colAmount?: string;
  colTx?: string;
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
  className,
}: LedgerTableProps) {
  return (
    <div className={cn("ch-ledger-wrap", className)}>
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
              <td title={row.from}>{truncateAddress(row.from)}</td>
              <td className="ch-ledger-muted">{row.label ?? "—"}</td>
              <td className="ch-num">{formatUsdc(row.amount)} USDC</td>
              <td>
                <a
                  href={`${explorerBase}${row.tx}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Transaction ${row.tx.slice(0, 8)}… on Polygonscan`}
                >
                  {row.tx.slice(0, 8)}…
                  <span aria-hidden="true"> ↗</span>
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
