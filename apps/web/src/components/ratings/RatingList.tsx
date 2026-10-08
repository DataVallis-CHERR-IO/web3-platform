import { getTranslations } from "next-intl/server";
import { LocalDateTime } from "@/components/LocalDateTime";
import type { RatingEntry } from "@/lib/ratings";

// Ratings with their private comments (TASK-057b, ADR-058) — shown only to the
// organisation's members and to platform admins. Raters are never named.
export async function RatingList({ entries, showCampaign = true }: { entries: RatingEntry[]; showCampaign?: boolean }) {
  const t = await getTranslations("ratings");
  if (entries.length === 0) return <p className="m-0 text-sm text-[var(--ink-muted)]">{t("none")}</p>;
  return (
    <ul className="ch-rating-list">
      {entries.map((e, i) => (
        <li key={`${e.campaignId}-${i}`}>
          <div className="ch-rating-list-head">
            <span className="ch-rating-stars" role="img" aria-label={t("starsLabel", { stars: e.stars })}>
              <span aria-hidden="true">{"★".repeat(e.stars)}</span>
              <span aria-hidden="true" className="ch-rating-stars-off">{"★".repeat(5 - e.stars)}</span>
            </span>
            {showCampaign && <span className="font-bold">{e.campaignTitle}</span>}
            <span className="ch-rating-date"><LocalDateTime value={e.updatedAt} withTime={false} /></span>
          </div>
          {e.comment ? <p className="ch-rating-comment">{e.comment}</p> : <p className="ch-rating-comment ch-rating-comment-none">{t("noComment")}</p>}
        </li>
      ))}
    </ul>
  );
}
