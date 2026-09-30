/**
 * CampaignCard — Human layer.
 * Full-colour photo, org name, campaign title, EUR progress.
 * raised/target are Money (bigint). Featured card gets shadow-hard.
 */
import * as React from "react";
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
  /** Translated status label (required when status is set) */
  statusLabel?: React.ReactNode;
  /** Translated meta fragments e.g. "{n} donors · {n} days left" */
  metaLabel?: string;
  /** Translated "Verified" label for aria */
  verifiedLabel?: string;
  /** Translated success labels for Progress */
  successLineLabel?: string;
  willSucceedLabel?: string;
  className?: string;
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
  statusLabel,
  metaLabel,
  verifiedLabel,
  successLineLabel,
  willSucceedLabel,
  className,
}: CampaignCardProps) {
  return (
    <article className={cn("ch-card", featured && "ch-card-featured", className)}>
      <div className="ch-card-media">
        {image ? (
          <img src={image} alt={imageAlt ?? title} />
        ) : null}
        {status && statusLabel && (
          <StatusChip status={status}>{statusLabel}</StatusChip>
        )}
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

        <h3 className="ch-card-title">{title}</h3>

        <Progress
          raised={raised}
          target={target}
          currency="EUR"
          meta={metaLabel}
          successLineLabel={successLineLabel}
          willSucceedLabel={willSucceedLabel}
        />
      </div>
    </article>
  );
}
