import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { StatusChip } from "@cherrio/ui";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { Link } from "@/i18n/routing";
import { CAMPAIGN_CHIP, listCampaignOrganizations, listOwnCampaigns } from "@/lib/campaigns/own";

export default async function AccountCampaignsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) redirect(`/${locale}`);

  const db = getDb();
  const [rows, organizations] = await Promise.all([
    listOwnCampaigns(db, session.userId),
    listCampaignOrganizations(db, session.userId),
  ]);
  const t = await getTranslations("campaigns");

  return (
    <div className="ch-container py-12">
      <div className="max-w-3xl mx-auto flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl md:text-4xl font-display uppercase tracking-tight text-[var(--ink)]">
            {t("listTitle")}
          </h1>
          <p className="text-base text-[var(--ink-muted)]">{t("listDescription")}</p>
        </div>

        {rows.length === 0 && <p className="text-base text-[var(--ink)]">{t("listEmpty")}</p>}
        {rows.map((row) => (
          <article key={row.id} className="ch-panel p-6 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-xl font-display uppercase text-[var(--ink)]">
                <Link href={`/account/campaigns/${row.id}`}>{row.title}</Link>
              </h2>
              <p className="text-sm text-[var(--ink-muted)]">{row.organization}</p>
            </div>
            <StatusChip status={CAMPAIGN_CHIP[row.status]!}>{t(`status.${row.status}`)}</StatusChip>
          </article>
        ))}

        {organizations.length > 0 ? (
          <div>
            <Link href="/account/campaigns/new" className="ch-btn ch-btn-primary no-underline">
              {t("new")}
            </Link>
          </div>
        ) : (
          <p className="text-sm text-[var(--ink-muted)]">{t("needOrganization")}</p>
        )}
      </div>
    </div>
  );
}
