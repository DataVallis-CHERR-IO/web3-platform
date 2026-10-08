import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { StatusChip, TrustScore } from "@cherrio/ui";
import { parseAppEnv } from "@cherrio/shared";
import { COMPLETENESS_CHECKS, TRUST_COMPONENTS, TRUST_SCORE_VERSION } from "@cherrio/shared/trust";
import { Link } from "@/i18n/routing";
import { UsdcAmount } from "@/components/Amount";
import { LocalDateTime } from "@/components/LocalDateTime";
import { ClaimButton } from "@/components/market-cap/ClaimButton";
import { PublicCampaignCard } from "@/components/campaigns/PublicCampaignCard";
import { RatingSummary } from "@/components/ratings/RatingSummary";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { listPublicCampaigns } from "@/lib/campaigns/public";
import { registryFacts } from "@/lib/market-cap/facts";
import { getMarketCapProfile, type MarketCapProfile } from "@/lib/market-cap/profile";
import { orgRatingSummaries } from "@/lib/ratings";
import { getExpectedOrigin } from "@/lib/security/origin";

// TASK-017c (ADR-059): one organisation on the Charity Market Cap — its Trust
// Score and what it is made of, ratings, campaigns, what its register says, and
// "Claim this organization" for an imported one. Read per request.
export const dynamic = "force-dynamic";

type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, id } = await params;
  const profile = await getMarketCapProfile(getDb(), id);
  if (!profile) return {};
  const t = await getTranslations({ locale, namespace: "marketCap.profile" });
  return {
    title: t("metaTitle", { name: profile.name, score: profile.score }),
    description: t("metaDescription", { name: profile.name, score: profile.score }),
  };
}

function registerUrl(p: MarketCapProfile): string | null {
  if (p.registry === "UK_CC" && p.registryId && /^\d+$/.test(p.registryId)) {
    return `https://register-of-charities.charitycommission.gov.uk/charity-search/-/charity-details/${p.registryId}`;
  }
  return null;
}

export default async function MarketCapProfilePage({ params }: { params: Params }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const db = getDb();
  const profile = await getMarketCapProfile(db, id);
  if (!profile) notFound();

  const [t, tCap, tCause, ratings, campaigns, session] = await Promise.all([
    getTranslations("marketCap.profile"),
    getTranslations("marketCap"),
    getTranslations("organizations.form.causeNames"),
    orgRatingSummaries(db, [profile.id]),
    profile.registered ? listPublicCampaigns(db, { orgId: profile.id }) : Promise.resolve(null),
    profile.claimable ? getSession() : Promise.resolve(null),
  ]);
  const rating = ratings.get(profile.id);
  const regions = new Intl.DisplayNames([locale], { type: "region" });
  const country = regions.of(profile.country) ?? profile.country;
  const c = profile.components;
  const value = (k: string) => (typeof c[k] === "number" ? (c[k] as number) : Number(c[k] ?? 0));
  const facts = registryFacts(profile, locale);
  const register = registerUrl(profile);

  // Structured data for search engines (schema.org); `<` is escaped so the JSON cannot close the script tag.
  const origin = getExpectedOrigin(parseAppEnv(process.env.APP_ENV ?? "local"));
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: profile.name,
    url: `${origin}/${locale}/charity-market-cap/${profile.id}`,
    ...(profile.website ? { sameAs: [profile.website] } : {}),
    ...(profile.description ? { description: profile.description } : {}),
    address: { "@type": "PostalAddress", addressCountry: profile.country },
    ...(rating && rating.count > 0
      ? { aggregateRating: { "@type": "AggregateRating", ratingValue: rating.average, ratingCount: rating.count, bestRating: 5, worstRating: 1 } }
      : {}),
  };

  return (
    <div className="ch-container py-12 flex flex-col gap-10">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <header className="flex flex-col gap-4">
        <Link href="/charity-market-cap" className="ch-eyebrow no-underline">
          {t("back")}
        </Link>
        <h1 className="ch-section-heading">{profile.name}</h1>
        <div className="flex flex-wrap gap-3 items-center">
          <StatusChip status={profile.registered ? "verified" : "imported"}>
            {profile.registered ? tCap("on.cherrio") : tCap("on.other")}
          </StatusChip>
          <span>{country}</span>
          {profile.causes.length > 0 && <span className="text-[var(--ink-muted)]">{profile.causes.map((x) => tCause(x)).join(", ")}</span>}
          <RatingSummary summary={rating} locale={locale} />
        </div>
      </header>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] items-start">
        <div className="flex flex-col gap-8 min-w-0">
          {(profile.description || profile.website) && (
            <section className="flex flex-col gap-3" aria-labelledby="p-about">
              <h2 id="p-about" className="m-0 text-2xl font-bold">{t("about")}</h2>
              {profile.description && <p className="m-0 text-lg leading-7 max-w-[70ch]">{profile.description}</p>}
              {profile.website && (
                <p className="m-0">
                  <span className="font-bold">{t("website")}: </span>
                  <a href={profile.website} className="ch-proof" rel="noopener nofollow ugc">
                    {profile.website.replace(/^https?:\/\//, "")}
                  </a>
                </p>
              )}
            </section>
          )}

          {profile.registered && (
            <section className="flex flex-col gap-4" aria-labelledby="p-campaigns">
              <h2 id="p-campaigns" className="m-0 text-2xl font-bold">{t("campaigns")}</h2>
              <p className="m-0">
                <span className="font-bold">{t("raised")}: </span>
                <UsdcAmount usdc={profile.raised} maxDecimals={0} />
              </p>
              {campaigns && campaigns.campaigns.length > 0 ? (
                <div className="grid gap-6 md:grid-cols-2">
                  {campaigns.campaigns.map((campaign) => (
                    <PublicCampaignCard key={campaign.id} campaign={campaign} locale={locale} />
                  ))}
                </div>
              ) : (
                <p className="m-0 text-[var(--ink-muted)]">{t("noCampaigns")}</p>
              )}
            </section>
          )}

          {facts.length > 0 && (
            <section className="flex flex-col gap-3" aria-labelledby="p-registry">
              <h2 id="p-registry" className="m-0 text-2xl font-bold">{t("registryTitle")}</h2>
              <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2">
                <div className="contents">
                  <dt className="font-bold">{t("facts.register")}</dt>
                  <dd className="m-0">{t(`registryNames.${profile.registry}`)}</dd>
                </div>
                {facts.map(([key, text]) => (
                  <div key={key} className="contents">
                    <dt className="font-bold">{t(`facts.${key}`)}</dt>
                    <dd className="m-0 ch-mono">{text}</dd>
                  </div>
                ))}
              </dl>
              {register && (
                <a href={register} className="ch-proof self-start" rel="noopener">
                  {t("registerLink")}
                </a>
              )}
            </section>
          )}
        </div>

        <aside className="flex flex-col gap-6" aria-labelledby="p-score">
          <h2 id="p-score" className="sr-only">{t("scoreTitle")}</h2>
          <TrustScore
            className="ch-panel p-5 w-full max-w-none"
            score={Number(profile.score)}
            version={String(TRUST_SCORE_VERSION)}
            methodologyLabel={t("methodology")}
            methodologyHref={`/${locale}/charity-market-cap/methodology`}
            components={
              profile.registered
                ? TRUST_COMPONENTS.map((k) => ({ label: t(`components.${k}`), value: value(k) }))
                : []
            }
          />
          {!profile.registered && (
            <div className="ch-panel p-5 flex flex-col gap-3">
              <h3 className="m-0 text-lg font-bold">{t("checksTitle")}</h3>
              <ul className="m-0 p-0 list-none flex flex-col gap-2">
                {COMPLETENESS_CHECKS.map((k) => {
                  const ok = c[k] === true;
                  return (
                    <li key={k} className="flex gap-3 items-start">
                      <span aria-hidden="true" className={ok ? "ch-check-ok" : "ch-check-no"}>{ok ? "✓" : "✕"}</span>
                      <span>
                        {tCap(`methodology.checks.${k}`)}
                        <span className="sr-only">: {ok ? t("checkPassed") : t("checkFailed")}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="m-0 text-sm text-[var(--ink-muted)]">{t("importedNote")}</p>
            </div>
          )}
          <p className="m-0 text-sm text-[var(--ink-muted)]">
            {t("computedAt")} <LocalDateTime value={profile.computedAt} />
          </p>
          {profile.claimable && (
            <div className="ch-panel p-5 flex flex-col gap-3">
              <h3 className="m-0 text-lg font-bold">{t("claimTitle")}</h3>
              <p className="m-0">{t("claimBody")}</p>
              <ClaimButton orgId={profile.id} loggedIn={Boolean(session)} />
            </div>
          )}
        </aside>
      </div>

      {(profile.registry === "UK_CC" || profile.registry === "US_IRS") && (
        <p className="m-0 text-sm text-[var(--ink-muted)] max-w-[80ch]">
          {profile.registry === "UK_CC"
            ? t.rich("sourceUk", {
                licence: (chunks) => (
                  <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" className="ch-proof" rel="license noopener">
                    {chunks}
                  </a>
                ),
              })
            : t("sourceUs")}
        </p>
      )}
    </div>
  );
}
