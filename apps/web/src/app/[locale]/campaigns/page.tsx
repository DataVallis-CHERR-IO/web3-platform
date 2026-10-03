import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CampaignCard, Progress } from "@cherrio/ui";
import { Link } from "@/i18n/routing";
import { UsdcAmount, EurAmount } from "@/components/Amount";
import { chipFor, daysLeft, percentRaised } from "@/components/campaigns/public-display";
import { getDb } from "@/lib/db";
import { listPublicCampaigns } from "@/lib/campaigns/public";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "campaignPage" });
  return { title: t("metaTitle", { title: t("listTitle") }), description: t("listIntro") };
}

export default async function CampaignsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const query = await searchParams;
  const t = await getTranslations("campaignPage");
  const tUi = await getTranslations("ui");

  const { campaigns, page, pageCount, chainAvailable } = await listPublicCampaigns(getDb(), {
    page: Number(query.page ?? "1"),
  });

  return (
    <div className="ch-campaigns">
      <header className="flex flex-col gap-4">
        <span className="ch-eyebrow">{t("listEyebrow")}</span>
        <h1 className="ch-section-heading">{t("listTitle")}</h1>
        <p className="m-0 max-w-[65ch] text-lg leading-7">{t("listIntro")}</p>
      </header>

      {!chainAvailable && (
        <p className="ch-notice" role="status">
          {t("chainUnavailable")}
        </p>
      )}

      {campaigns.length === 0 ? (
        <p className="ch-campaigns-empty">{t("empty")}</p>
      ) : (
        <div className="ch-campaigns-grid">
          {campaigns.map((c) => {
            const state = c.onChain?.state ?? "unknown";
            const raised = c.onChain?.raised ?? 0n;
            const left = state === "live" ? daysLeft(c.deadline) : null;
            const meta: string[] = [];
            if (c.onChain) meta.push(t("donors", { count: c.onChain.donors }));
            if (state === "live") meta.push(left === 0 || left === null ? t("endsToday") : t("daysLeft", { count: left }));
            return (
              <CampaignCard
                key={c.id}
                href={`/${locale}/campaigns/${c.slug}`}
                title={c.title}
                org={c.orgName}
                verified={c.orgVerified}
                verifiedLabel={tUi("verified")}
                image={c.coverUrl ?? undefined}
                imageAlt={t("coverAlt", { title: c.title })}
                status={chipFor(state)}
                statusLabel={t(`state.${state}`)}
                raised={{ usdc: raised }}
                target={{ usdc: c.targetUsdc }}
              >
                <Progress
                  raised={{ usdc: raised }}
                  target={{ usdc: c.targetUsdc }}
                  currency="USDC"
                  raisedLabel={<UsdcAmount usdc={raised} maxDecimals={0} />}
                  targetLabel={<EurAmount eurCents={c.targetEurCents} />}
                  barLabel={t("barLabel", { percent: percentRaised(raised, c.targetUsdc) })}
                  meta={meta.length > 0 ? meta.join(" · ") : undefined}
                  successLineLabel={t("successLine")}
                  willSucceedLabel={t("willSucceed")}
                />
              </CampaignCard>
            );
          })}
        </div>
      )}

      {pageCount > 1 && (
        <nav className="ch-pager" aria-label={t("pagination")}>
          {page > 1 && (
            <Link href={{ pathname: "/campaigns", query: { page: page - 1 } }} className="ch-proof">
              {t("pagePrev")}
            </Link>
          )}
          <span>{t("pageOf", { page, count: pageCount })}</span>
          {page < pageCount && (
            <Link href={{ pathname: "/campaigns", query: { page: page + 1 } }} className="ch-proof">
              {t("pageNext")}
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
