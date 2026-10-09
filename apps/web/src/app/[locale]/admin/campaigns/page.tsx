import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { formatUsdc } from "@cherrio/shared";
import { StatusChip } from "@cherrio/ui";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { Link } from "@/i18n/routing";
import { GoalAmount } from "@/components/Amount";
import { campaignGoal } from "@cherrio/shared";
import { LocalDateTime } from "@/components/LocalDateTime";
import { ListFilters } from "@/components/admin/ListFilters";
import { countriesInUse } from "@/lib/admin/listing";
import { CAMPAIGN_CHIP } from "@/lib/campaigns/own";
import { decodeCursor, encodeCursor, listHref, pick, searchText, type SearchParams } from "@/lib/admin/listing";
import { CAMPAIGN_VIEWS, campaignCounts, listCampaigns } from "@/lib/admin/campaigns";

/**
 * Campaigns for platform admins (TASK-029 §3): one tab per stage — waiting for
 * review (default), approved and waiting to be published, live, rejected,
 * drafts, all — with search, country filter and keyset pages. 404 for non-admins.
 */
export default async function AdminCampaignsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  try {
    await requireRole("PLATFORM_ADMIN");
  } catch {
    notFound();
  }

  const query = await searchParams;
  // Only countries that occur in the list (David 2026-10-08), with counts.
  const countryChoices = await countriesInUse(getDb(), "campaigns", locale);
  const filters = {
    view: pick(query, "view", CAMPAIGN_VIEWS, "review"),
    q: searchText(query),
    country: pick(query, "country", countryChoices.map((c) => c.value), ""),
  };
  const cursor = decodeCursor(query);
  const db = getDb();
  const [{ rows, next }, counts] = await Promise.all([listCampaigns(db, filters, cursor), campaignCounts(db)]);

  const t = await getTranslations("admin.campaigns");
  const tList = await getTranslations("admin.list");
  const tStatus = await getTranslations("campaigns.status");
  const path = "/admin/campaigns";
  const viewTitle = t(`views.${filters.view}`);

  return (
    <div className="ch-container py-12 flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/admin" className="text-sm font-bold underline text-[var(--ink)]">
          {tList("backToAdmin")}
        </Link>
        <h1 className="ch-section-heading uppercase text-[var(--ink)]">{t("title")}</h1>
      </div>

      <nav aria-label={t("viewNav")} className="ch-view-nav">
        {CAMPAIGN_VIEWS.map((view) => (
          <Link
            key={view}
            href={listHref(path, query, { view: view === "review" ? null : view })}
            className={`ch-btn no-underline ${filters.view === view ? "ch-btn-primary" : "ch-btn-ghost"}`}
            aria-current={filters.view === view ? "page" : undefined}
          >
            {t(`views.${view}`)} <span className="ch-mono">({counts[view]})</span>
          </Link>
        ))}
      </nav>

      <Suspense>
        <ListFilters searchLabel={t("search")} searchHint={t("searchHint")} selects={[]} countries={countryChoices} />
      </Suspense>

      <h2 className="text-2xl font-display uppercase tracking-tight text-[var(--ink)]">{viewTitle}</h2>
      {rows.length === 0 ? (
        <p className="text-base text-[var(--ink)]">{t(`viewsEmpty.${filters.view}`)}</p>
      ) : (
        <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-label={viewTitle}>
          <table className="ch-ledger">
            <thead>
              <tr>
                <th>{t("colCampaign")}</th>
                <th>{t("colOrganisation")}</th>
                <th>{t("colStatus")}</th>
                <th>{t("colTarget")}</th>
                <th>{t(`viewDate.${filters.view}`)}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-normal">
                    <Link href={`/admin/campaigns/${row.id}`}>{row.title}</Link>
                  </td>
                  <td className="whitespace-normal">
                    {row.organizationId ? (
                      <Link href={`/admin/organizations/${row.organizationId}`}>{row.organization}</Link>
                    ) : (
                      t("individual")
                    )}
                  </td>
                  <td>
                    <StatusChip status={CAMPAIGN_CHIP[row.status]!}>{tStatus(row.status)}</StatusChip>
                    {row.status === "APPROVED" && (
                      <span className="block text-xs text-[var(--ink-muted)]">
                        {row.publishTxHash ? t("publishState.sent") : t("publishState.notSent")}
                      </span>
                    )}
                  </td>
                  <td>
                    <GoalAmount goal={campaignGoal(row.goalCurrency, row.goalAmountMinor)} />
                    {row.targetUsdc !== null && (
                      <span className="block text-xs ch-mono text-[var(--ink-muted)]">
                        {t("usdc", { amount: formatUsdc(row.targetUsdc) })}
                      </span>
                    )}
                  </td>
                  <td>
                    <LocalDateTime value={row.date} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav aria-label={tList("pages")} className="flex flex-wrap gap-3">
        {cursor && (
          <Link href={listHref(path, query, {})} className="ch-btn ch-btn-ghost no-underline">
            {tList("firstPage")}
          </Link>
        )}
        {next && (
          <Link href={listHref(path, query, { after: encodeCursor(next) })} className="ch-btn no-underline">
            {tList("nextPage")}
          </Link>
        )}
      </nav>
    </div>
  );
}
