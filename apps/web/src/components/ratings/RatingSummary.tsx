import { getTranslations } from "next-intl/server";
import type { RatingSummary as Summary } from "@/lib/ratings";

// Average stars of an organisation (TASK-057b, ADR-058): public, no names.
export async function RatingSummary({ summary, locale }: { summary: Summary | undefined; locale: string }) {
  const t = await getTranslations("ratings");
  if (!summary || summary.count === 0) return null;
  const average = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(summary.average);
  return (
    <span className="ch-rating-summary" role="img" aria-label={t("summaryLabel", { average, count: summary.count })}>
      <span aria-hidden="true" className="ch-rating-star">★</span>
      <span aria-hidden="true">{average}</span>
      <span aria-hidden="true" className="ch-rating-count">({summary.count})</span>
    </span>
  );
}
