/**
 * TrustScore — Human layer summary + proof layer detail.
 * One big number /100, five weighted components as ink meters.
 * Imported orgs show "Not on CHERR.IO yet" and a cap note.
 */
import { cn } from "../lib/utils";

export interface TrustScoreItem {
  label: string;
  /** 0–1 */
  value: number;
}

export interface TrustScoreProps {
  score: number;
  version?: string;
  imported?: boolean;
  components: TrustScoreItem[];
  /** Translated "Not on CHERR.IO yet" */
  importedLabel?: string;
  /** Translated cap note for imported orgs */
  importedNoteLabel?: string;
  /** Translated "Methodology" link text */
  methodologyLabel?: string;
  methodologyHref?: string;
  className?: string;
}

export function TrustScore({
  score,
  version,
  imported = false,
  components,
  importedLabel,
  importedNoteLabel,
  methodologyLabel,
  methodologyHref = "#trust-methodology",
  className,
}: TrustScoreProps) {
  return (
    <div className={cn("ch-trust", className)}>
      <div className="ch-trust-head">
        <div>
          <div className="ch-trust-score">
            {imported ? (
              <span style={{ fontSize: 16 }}>{importedLabel}</span>
            ) : (
              <>
                {score}
                <small>/100</small>
              </>
            )}
          </div>
          {version && (
            <div className="ch-trust-note">
              v{version}
              {methodologyLabel && (
                <>
                  {" · "}
                  <a href={methodologyHref} className="ch-proof" style={{ fontSize: 13 }}>
                    {methodologyLabel}
                  </a>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {components.map((c) => (
        <div key={c.label} className="ch-trust-row">
          <span>{c.label}</span>
          <div className="ch-trust-meter" aria-hidden="true">
            <span style={{ width: `${Math.min(c.value * 100, 100)}%` }} />
          </div>
          <span className="ch-trust-val">{Math.round(c.value * 100)}</span>
        </div>
      ))}

      {imported && importedNoteLabel && (
        <div className="ch-trust-note">{importedNoteLabel}</div>
      )}
    </div>
  );
}
