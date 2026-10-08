import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { LEVELS } from "@cherrio/shared/points";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { Link } from "@/i18n/routing";
import { getImpact, type Missing } from "@/lib/points/impact";

// "My impact" (TASK-056b, ADR-057 §6): level, the next step in words, what the
// user did and the latest points. Levels need points AND an action.

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "impact" });
  return { title: t("metaTitle") };
}

export default async function ImpactPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) redirect(`/${locale}`);

  const [impact, t] = await Promise.all([getImpact(getDb(), session.userId), getTranslations("impact")]);
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const current = LEVELS.find((l) => l.level === impact.level) ?? null;
  const floor = current?.points ?? 0;
  const target = impact.next?.points ?? floor;
  const percent = impact.next
    ? Math.max(0, Math.min(100, Math.round(((impact.statusPoints - floor) / Math.max(1, target - floor)) * 100)))
    : 100;
  const step = (m: Missing) =>
    m.kind === "points" ? t("missing.points", { count: number.format(m.count) })
    : m.kind === "campaigns" ? t("missing.campaigns", { count: m.count })
    : m.kind === "vote" ? t("missing.vote")
    : m.kind === "rating" ? t("missing.rating")
    : m.kind === "people" ? t("missing.people", { count: m.count })
    : t("missing.months", { count: m.count });

  const stats: [string, number][] = [
    [t("stats.campaigns"), impact.campaignsSupported],
    [t("stats.succeeded"), impact.campaignsSucceeded],
    [t("stats.people"), impact.peopleBrought],
    [t("stats.votes"), impact.votes],
  ];

  return (
    <div className="ch-container py-12">
      <div className="max-w-3xl mx-auto flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <h1 className="ch-section-heading uppercase text-[var(--ink)]">{t("title")}</h1>
          <p className="text-base text-[var(--ink-muted)]">{t("description")}</p>
        </div>

        <section className="ch-panel ch-impact-level" aria-labelledby="level-heading">
          <span className="ch-eyebrow">{t("levelEyebrow")}</span>
          <h2 id="level-heading" className="ch-impact-level-name">
            {current ? t("levelName", { level: current.level, name: t(`levels.${current.key}`) }) : t("noLevel")}
          </h2>
          <p className="ch-impact-points">
            {t("statusPoints", { points: number.format(impact.statusPoints) })}
          </p>
          {impact.next ? (
            <>
              <div
                className="ch-meter"
                role="progressbar"
                aria-valuemin={floor}
                aria-valuemax={target}
                aria-valuenow={Math.min(impact.statusPoints, target)}
                aria-label={t("meterLabel", { name: t(`levels.${impact.next.key}`) })}
              >
                <span className="ch-meter-fill" style={{ width: `${percent}%` }} />
              </div>
              <div className="flex flex-col gap-2">
                <p className="m-0 font-bold">
                  {t("nextHeading", { level: impact.next.level, name: t(`levels.${impact.next.key}`) })}
                </p>
                {impact.missing.length > 0 ? (
                  <ul className="ch-impact-steps">
                    {impact.missing.map((m) => (
                      <li key={m.kind}>{step(m)}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="m-0 text-sm text-[var(--ink-muted)]">{t("nextSoon")}</p>
                )}
              </div>
            </>
          ) : (
            <p className="m-0 font-bold">{t("topLevel")}</p>
          )}
        </section>

        <section aria-labelledby="stats-heading" className="flex flex-col gap-3">
          <h2 id="stats-heading" className="m-0 text-xl font-display uppercase text-[var(--ink)]">{t("statsHeading")}</h2>
          <dl className="ch-impact-stats">
            {stats.map(([label, value]) => (
              <div key={label} className="ch-impact-stat">
                <dt>{label}</dt>
                <dd>{number.format(value)}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="recent-heading" className="flex flex-col gap-3">
          <h2 id="recent-heading" className="m-0 text-xl font-display uppercase text-[var(--ink)]">{t("recentHeading")}</h2>
          {impact.recent.length === 0 ? (
            <p className="ch-notice m-0">
              {t("recentEmpty")} <Link href="/campaigns">{t("recentEmptyLink")}</Link>
            </p>
          ) : (
            <ul className="ch-impact-recent">
              {impact.recent.map((e, i) => (
                <li key={i}>
                  <span className="ch-impact-recent-what">
                    {t(`reasons.${e.reason}`)}
                    {e.campaignTitle && e.campaignSlug && (
                      <>
                        {" · "}
                        <Link href={`/campaigns/${e.campaignSlug}`}>{e.campaignTitle}</Link>
                      </>
                    )}
                  </span>
                  <span className="ch-impact-recent-date">{date.format(e.createdAt)}</span>
                  <span className="ch-impact-recent-points">{t("plus", { points: number.format(e.delta) })}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="m-0 text-sm text-[var(--ink-muted)]">
            {t("rewardNote", { points: number.format(impact.rewardPoints) })}
          </p>
        </section>
      </div>
    </div>
  );
}
