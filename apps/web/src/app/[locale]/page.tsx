import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { Button, ProofLink, Progress, StatusChip } from "@cherrio/ui";
import { UsdcAmount, EurAmount } from "@/components/Amount";
import { PublicCampaignCard } from "@/components/campaigns/PublicCampaignCard";
import { daysLeft, percentRaised } from "@/components/campaigns/public-display";
import { getDb } from "@/lib/db";
import { getLandingCampaigns } from "@/lib/campaigns/landing";
import type { PublicCampaignSummary } from "@/lib/campaigns/public";

// The landing shows real published campaigns (TASK-037), read per request:
// figures come from the indexed chain views and change every block.
export const dynamic = "force-dynamic";

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("landing");
  const { hero, grid, total } = await getLandingCampaigns(getDb());

  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="ch-landing-hero">
        <div className="ch-landing-hero-left">
          <span className="ch-landing-tagline">{t("hero.tagline")}</span>
          <h1 className="ch-landing-hero-headline">{t("hero.headline")}</h1>
          <p className="ch-landing-hero-sub">{t("hero.sub")}</p>
          <div className="ch-landing-hero-ctas">
            <Link href="/campaigns">
              <Button variant="primary" size="lg">
                {t("hero.cta")}
              </Button>
            </Link>
            <Link href="#how-it-works">
              <Button size="lg">{t("hero.ctaSecondary")}</Button>
            </Link>
          </div>
          <span className="ch-landing-hero-trust">{t("hero.trustNote")}</span>
        </div>

        <div className="ch-landing-hero-right">
          {hero ? <HeroCampaign campaign={hero} locale={locale} /> : <HeroEmpty />}
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────── */}
      <section id="how-it-works" className="ch-band-tint">
        <div className="ch-landing-steps-head">
          <span className="ch-eyebrow">{t("howItWorks.tagline")}</span>
          <h2 className="ch-section-heading">{t("howItWorks.title")}</h2>
        </div>
        <div className="ch-landing-steps">
          {(["donate", "milestones", "proof"] as const).map((key, i) => (
            <div
              key={key}
              className={`ch-landing-step${i === 2 ? " ch-landing-step-dark" : ""}`}
            >
              <span className="ch-landing-step-label">
                {t(`howItWorks.step${i + 1}Label`)}
              </span>
              <h3 className="ch-landing-step-title">
                {t(`howItWorks.steps.${key}.title`)}
              </h3>
              <p className="ch-landing-step-body">
                {t(`howItWorks.steps.${key}.body`)}
              </p>
            </div>
          ))}
        </div>
        <p className="ch-landing-steps-note">{t("howItWorks.belowNote")}</p>
      </section>

      {/* ── Campaigns grid ───────────────────────────────────────────── */}
      <section className="ch-landing-campaigns" aria-labelledby="landing-campaigns-heading">
        <div className="ch-landing-campaigns-head">
          <div>
            <span className="ch-eyebrow">{t("campaigns.tagline")}</span>
            <h2 className="ch-landing-campaigns-heading" id="landing-campaigns-heading">
              {t("campaigns.title")}
            </h2>
          </div>
          <Link href="/campaigns" className="ch-proof">
            {t("campaigns.seeAll")}
          </Link>
        </div>
        {grid.length > 0 ? (
          <div className="ch-landing-campaigns-grid">
            {grid.map((c) => (
              <PublicCampaignCard key={c.id} campaign={c} locale={locale} />
            ))}
          </div>
        ) : (
          <p className="ch-campaigns-empty">
            {hero ? t("campaigns.onlyHero") : total > 0 ? t("campaigns.noneLive") : t("campaigns.none")}
          </p>
        )}
      </section>

      {/* ── Charity Market Cap teaser ────────────────────────────────── */}
      <section className="ch-landing-cmc ch-band-raised">
        <div className="ch-landing-cmc-left">
          <span className="ch-landing-tagline">
            {t("charityMarketCap.tagline")}
          </span>
          <h2 className="ch-landing-cmc-heading">
            {t("charityMarketCap.heading")}
          </h2>
          <p className="ch-landing-cmc-desc">
            {t("charityMarketCap.description")}
          </p>
          <div className="ch-landing-cmc-actions">
            <Link href="/charity-market-cap">
              <Button variant="primary">
                {t("charityMarketCap.cta")}
              </Button>
            </Link>
            <a href="#" className="ch-landing-cmc-link">
              {t("charityMarketCap.howScoreWorks")}
            </a>
          </div>
        </div>

        <div className="ch-landing-cmc-table">
          <div className="ch-landing-cmc-table-head">
            <span>{t("charityMarketCap.colRank")}</span>
            <span>{t("charityMarketCap.colCharity")}</span>
            <span>{t("charityMarketCap.colScore")}</span>
            <span>{t("charityMarketCap.colStatus")}</span>
          </div>
          <p className="ch-landing-cmc-empty">{t("charityMarketCap.empty")}</p>
        </div>
      </section>

      {/* ── Emergency Pool band ──────────────────────────────────────── */}
      <section className="ch-landing-ep">
        <div className="ch-landing-ep-content">
          <span className="ch-landing-tagline ch-landing-ep-tagline">
            {t("emergencyPool.tagline")}
          </span>
          <h2 className="ch-landing-ep-heading">
            {t("emergencyPool.heading")}
          </h2>
          <p className="ch-landing-ep-desc">
            {t("emergencyPool.description")}
          </p>
        </div>
        <Link href="/emergency-pool">
          <Button variant="primary" size="lg">
            {t("emergencyPool.cta")}
          </Button>
        </Link>
      </section>
    </>
  );
}

/** The big hero card: the live campaign whose deadline comes first. */
async function HeroCampaign({ campaign: c, locale }: { campaign: PublicCampaignSummary; locale: string }) {
  const t = await getTranslations("landing");
  const tCp = await getTranslations("campaignPage");
  const tUi = await getTranslations("ui");
  const raised = c.onChain?.raised ?? 0n;
  const left = daysLeft(c.deadline);
  const meta = [
    tCp("donors", { count: c.onChain?.donors ?? 0 }),
    left === 0 || left === null ? tCp("endsToday") : tCp("daysLeft", { count: left }),
  ].join(" · ");
  const href = `/campaigns/${c.slug}` as const;
  return (
    <>
      <article className="ch-landing-hero-card" aria-labelledby="landing-hero-title">
        <div className="ch-landing-hero-photo">
          {c.coverUrl ? (
            <img src={c.coverUrl} alt={tCp("coverAlt", { title: c.title })} />
          ) : (
            <span>{t("hero.noPhoto")}</span>
          )}
        </div>
        <div className="ch-landing-hero-card-body">
          <div className="ch-landing-hero-card-meta">
            <StatusChip status="live">{tCp("state.live")}</StatusChip>
            {c.isDemo && <span className="ch-card-tag ch-card-tag-inline">{tCp("demoTag")}</span>}
            <span>
              {c.orgName}
              {c.orgVerified ? ` · ${tUi("verified")}` : ""}
            </span>
          </div>
          <h2 className="ch-landing-hero-card-title" id="landing-hero-title">
            <Link href={href} className="ch-card-link">
              {c.title}
            </Link>
          </h2>
          <Progress
            raised={{ usdc: raised }}
            target={{ usdc: c.targetUsdc }}
            currency="USDC"
            raisedLabel={<UsdcAmount usdc={raised} maxDecimals={0} />}
            targetLabel={<EurAmount eurCents={c.targetEurCents} />}
            barLabel={tCp("barLabel", { percent: percentRaised(raised, c.targetUsdc) })}
            meta={meta}
            successLineLabel={tCp("successLine")}
            willSucceedLabel={tCp("willSucceed")}
          />
          <Link href={href}>
            <Button variant="primary" block>
              {t("campaigns.donate")}
            </Button>
          </Link>
        </div>
      </article>
      <ProofLink href={`/${locale}${href}#proof`}>{t("campaigns.seeDonations")}</ProofLink>
    </>
  );
}

/** Before the first campaign goes live: say so instead of showing sample data. */
async function HeroEmpty() {
  const t = await getTranslations("landing");
  return (
    <div className="ch-landing-hero-card">
      <div className="ch-landing-hero-card-body">
        <h2 className="ch-landing-hero-card-title">{t("hero.emptyTitle")}</h2>
        <p className="m-0">{t("hero.emptyBody")}</p>
        <Link href="/account/campaigns/new">
          <Button variant="primary" block>
            {t("hero.emptyCta")}
          </Button>
        </Link>
      </div>
    </div>
  );
}
