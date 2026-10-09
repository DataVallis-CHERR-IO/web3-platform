import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { StatusChip } from "@cherrio/ui";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { Link } from "@/i18n/routing";
import { LocalDateTime } from "@/components/LocalDateTime";
import { ListFilters } from "@/components/admin/ListFilters";
import { countriesInUse } from "@/lib/admin/listing";
import { decodeCursor, encodeCursor, listHref, pick, searchText, type SearchParams } from "@/lib/admin/listing";
import { KYB_CHIP, KYB_FILTERS, listOrganizations, organizationCounts, SOURCE_FILTERS } from "@/lib/admin/organizations";

/** All organisations — search, filters, keyset pages. PLATFORM_ADMIN only; 404 for everyone else. */
export default async function AdminOrganizationsPage({
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
  const countryChoices = await countriesInUse(getDb(), "organizations", locale);
  const filters = {
    q: searchText(query),
    kyb: pick(query, "status", KYB_FILTERS, "all"),
    source: pick(query, "source", SOURCE_FILTERS, "all"),
    country: pick(query, "country", countryChoices.map((c) => c.value), ""),
  };
  const cursor = decodeCursor(query);
  const db = getDb();
  const [{ rows, next }, counts] = await Promise.all([listOrganizations(db, filters, cursor), organizationCounts(db)]);

  const t = await getTranslations("admin.organizations");
  const tList = await getTranslations("admin.list");
  const tKyb = await getTranslations("admin.organizations.kyb");
  const countries = new Intl.DisplayNames([locale], { type: "region" });
  const path = "/admin/organizations";

  return (
    <div className="ch-account-page flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="ch-section-heading uppercase text-[var(--ink)]">{t("title")}</h1>
      </div>

      <nav aria-label={t("statusNav")} className="ch-view-nav">
        {KYB_FILTERS.map((status) => (
          <Link
            key={status}
            href={listHref(path, query, { status: status === "all" ? null : status })}
            className={`ch-btn no-underline ${filters.kyb === status ? "ch-btn-primary" : "ch-btn-ghost"}`}
            aria-current={filters.kyb === status ? "page" : undefined}
          >
            {tKyb(status)} <span className="ch-mono">({counts[status]})</span>
          </Link>
        ))}
      </nav>

      <Suspense>
        <ListFilters
          searchLabel={t("search")}
          searchHint={t("searchHint")}
          selects={[
            {
              key: "source",
              label: t("source"),
              value: filters.source,
              options: SOURCE_FILTERS.map((value) => ({ value, label: t(`sources.${value}`) })),
            },
          ]}
          countries={countryChoices}
        />
      </Suspense>

      {rows.length === 0 ? (
        <p className="text-base text-[var(--ink)]">{tList("empty")}</p>
      ) : (
        <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-label={t("title")}>
          <table className="ch-ledger">
            <thead>
              <tr>
                <th>{t("colName")}</th>
                <th>{t("colCountry")}</th>
                <th>{t("colStatus")}</th>
                <th>{t("colSource")}</th>
                <th>{t("colCampaigns")}</th>
                <th>{t("colCreated")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-normal">
                    <Link href={`/admin/organizations/${row.id}`}>{row.name}</Link>
                    {row.registryId && <span className="block text-xs text-[var(--ink-muted)]">{row.registryId}</span>}
                  </td>
                  <td>{countries.of(row.country) ?? row.country}</td>
                  <td>
                    <StatusChip status={KYB_CHIP[row.kybStatus]!}>{tKyb(row.kybStatus)}</StatusChip>
                  </td>
                  <td>{t(`sources.${row.source}`)}</td>
                  <td className="ch-mono">{row.campaigns}</td>
                  <td>
                    <LocalDateTime value={row.createdAt} withTime={false} />
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
