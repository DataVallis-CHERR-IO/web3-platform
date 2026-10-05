import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { PublicCampaignCard } from "@/components/campaigns/PublicCampaignCard";
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
          {campaigns.map((c) => (
            <PublicCampaignCard key={c.id} campaign={c} locale={locale} />
          ))}
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
