/**
 * CampaignCard — Human layer.
 * Full-colour photo, org name, campaign title, EUR progress.
 * raised/target are Money (bigint). Featured card gets shadow-hard.
 */
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { StatusChip, type Status } from "./StatusChip";
import { Progress } from "./Progress";
import type { Money } from "@cherrio/shared/money";

export interface CampaignCardProps {
  title: string;
  org: string;
  verified?: boolean;
  image?: string;
  imageAlt?: string;
  status?: Status;
  raised: Money;
  target: Money;
  donors?: number;
  daysLeft?: number | null;
  featured?: boolean;
  /** When set, the whole card is one link to this URL (the title is the link text). */
  href?: string;
  /**
   * Translated status label text (required when status is set).
   * Plain text only: the card wraps it in its own StatusChip, so passing a
   * <StatusChip> here would render a chip inside a chip.
   */
  statusLabel?: string;
  /** Translated short tag in the image corner, e.g. "Demo" for made-up test campaigns (ADR-052). */
  tag?: string;
  /** Translated meta fragments e.g. "{n} donors · {n} days left" */
  metaLabel?: string;
  /** Translated "Verified" label for aria */
  verifiedLabel?: string;
  /** Translated success labels for Progress */
  successLineLabel?: string;
  willSucceedLabel?: string;
  className?: string;
  /**
   * Replaces the built-in Progress, e.g. a Progress with server-rendered
   * display-currency figures (ADR-040).
   */
  children?: ReactNode;
}

export function CampaignCard({
  title,
  org,
  verified = false,
  image,
  imageAlt,
  status,
  raised,
  target,
  donors: _donors,        // kept in interface for callers; rendered via metaLabel
  daysLeft: _daysLeft,    // kept in interface for callers; rendered via metaLabel
  featured = false,
  href,
  tag,
  statusLabel,
  metaLabel,
  verifiedLabel,
  successLineLabel,
  willSucceedLabel,
  className,
  children,
}: CampaignCardProps) {
  return (
    <article className={cn("ch-card", featured && "ch-card-featured", href && "ch-card-linked", className)}>
      <div className="ch-card-media">
        {image ? (
          <img src={image} alt={imageAlt ?? title} loading="lazy" />
        ) : null}
        {status && statusLabel && (
          <StatusChip status={status}>{statusLabel}</StatusChip>
        )}
        {tag && <span className="ch-card-tag">{tag}</span>}
      </div>

      <div className="ch-card-body">
        <div className="ch-card-org">
          {verified && (
            <span className="ch-verified" role="img" aria-label={verifiedLabel}>
              <span aria-hidden="true">✓</span>
            </span>
          )}
          <span>{org}</span>
        </div>

        <h3 className="ch-card-title">
          {href ? (
            <a href={href} className="ch-card-link">
              {title}
            </a>
          ) : (
            title
          )}
        </h3>

        {children ?? (
          <Progress
            raised={raised}
            target={target}
            currency="EUR"
            meta={metaLabel}
            successLineLabel={successLineLabel}
            willSucceedLabel={willSucceedLabel}
          />
        )}
      </div>
    </article>
  );
}
