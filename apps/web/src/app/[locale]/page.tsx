import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { Button, CampaignCard, ProofLink, Progress, StatusChip } from "@cherrio/ui";
import {
  SAMPLE_CAMPAIGNS,
  HERO_CAMPAIGN,
  CMC_SAMPLE_ORGS,
} from "@/fixtures/landing";

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <LandingPage />;
}

function LandingPage() {
  const t = useTranslations("landing");
  const tStatus = useTranslations("ui.status");
  const tProgress = useTranslations("ui.progress");
  const tUi = useTranslations("ui");

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
          <div className="ch-landing-hero-card">
            <div className="ch-landing-hero-photo">{t("hero.photoPlaceholder")}</div>
            <div className="ch-landing-hero-card-body">
              <div className="ch-landing-hero-card-meta">
                <StatusChip status="live">{tStatus("live")}</StatusChip>
                <span>
                  {HERO_CAMPAIGN.org} · {tStatus("verified")}
                </span>
              </div>
              <h2 className="ch-landing-hero-card-title">
                {HERO_CAMPAIGN.title}
              </h2>
              <Progress
                raised={HERO_CAMPAIGN.raised}
                target={HERO_CAMPAIGN.target}
                successLineLabel={tProgress("successLine")}
                willSucceedLabel={tProgress("willSucceed")}
                meta={`${t("campaigns.donorsCount", { count: HERO_CAMPAIGN.donors })} · ${t("campaigns.daysLeft", { count: HERO_CAMPAIGN.daysLeft })}`}
              />
              <Button variant="primary" block>
                {t("campaigns.donateTo", { name: "Susan" })}
              </Button>
            </div>
          </div>
          <ProofLink>
            {t("campaigns.seeAllDonations", {
              count: HERO_CAMPAIGN.donors,
            })}
          </ProofLink>
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
      <section className="ch-landing-campaigns">
        <div className="ch-landing-campaigns-head">
          <div>
            <span className="ch-eyebrow">{t("campaigns.tagline")}</span>
            <h2 className="ch-landing-campaigns-heading">
              {t("campaigns.title")}
            </h2>
          </div>
          <div className="ch-landing-campaigns-filters">
            <Button>{t("campaigns.filterAll")}</Button>
            <Button variant="ghost">{t("campaigns.filterHealth")}</Button>
            <Button variant="ghost">{t("campaigns.filterAnimals")}</Button>
            <Button variant="ghost">{t("campaigns.filterEnvironment")}</Button>
          </div>
        </div>
        <div className="ch-landing-campaigns-grid">
          {SAMPLE_CAMPAIGNS.map((c) => {
            const parts: string[] = [];
            if (c.donors != null)
              parts.push(t("campaigns.donorsCount", { count: c.donors }));
            if (c.daysLeft != null)
              parts.push(t("campaigns.daysLeft", { count: c.daysLeft }));
            return (
              <CampaignCard
                key={c.id}
                title={c.title}
                org={c.org}
                verified={c.verified}
                status={c.status}
                statusLabel={tStatus(c.status)}
                raised={c.raised}
                target={c.target}
                donors={c.donors}
                daysLeft={c.daysLeft}
                featured={c.featured}
                verifiedLabel={tUi("verified")}
                successLineLabel={tProgress("successLine")}
                willSucceedLabel={tProgress("willSucceed")}
                metaLabel={parts.length > 0 ? parts.join(" · ") : undefined}
              />
            );
          })}
        </div>
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
          {CMC_SAMPLE_ORGS.map((o) => (
            <div key={o.rank} className="ch-landing-cmc-table-row">
              <span className="ch-landing-cmc-rank">{o.rank}</span>
              <span className="ch-landing-cmc-name">{o.name}</span>
              <span className="ch-landing-cmc-score">
                {o.score}
                <span className="ch-landing-cmc-score-max"> /100</span>
              </span>
              <StatusChip status={o.status}>{tStatus(o.status)}</StatusChip>
            </div>
          ))}
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
