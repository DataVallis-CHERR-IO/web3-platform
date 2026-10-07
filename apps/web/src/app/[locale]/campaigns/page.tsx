import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { CampaignFilters, type FilterGroupData } from "@/components/campaigns/CampaignFilters";
import { CampaignListControls } from "@/components/campaigns/CampaignListControls";
import { PublicCampaignCard } from "@/components/campaigns/PublicCampaignCard";
import { getDb } from "@/lib/db";
import { listQuery, parseCampaignSort, sortOptions, type ListState } from "@/lib/campaigns/filter-options";
import { listCampaignFacets, listPublicCampaigns, parseCampaignFilters } from "@/lib/campaigns/public";

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
  searchParams: Promise<{ page?: string; cause?: string | string[]; country?: string | string[]; q?: string | string[]; sort?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const query = await searchParams;
  const t = await getTranslations("campaignPage");
  const tCause = await getTranslations("organizations.form.causeNames");
  const regionNames = new Intl.DisplayNames([locale], { type: "region" });
  const regionName = (code: string) => regionNames.of(code) ?? code;

  // TASK-039/042: cause and country filters from the URL; unknown values are ignored.
  // TASK-053: text search (`q`) and order (`sort`) travel in the URL too.
  const filters = parseCampaignFilters(query);
  const sort = parseCampaignSort(query.sort);
  const causes = filters.causes ?? [];
  const countries = filters.countries ?? [];
  const q = filters.q ?? "";
  const filtered = causes.length + countries.length > 0 || q !== "";
  const state: ListState = { causes, countries, q, sort };
  const db = getDb();
  const [{ campaigns, total, page, pageCount, chainAvailable }, facets] = await Promise.all([
    listPublicCampaigns(db, { page: Number(query.page ?? "1"), sort, ...filters }),
    listCampaignFacets(db, filters),
  ]);

  // A value from the URL that no published campaign has still shows, with 0, so it can be unticked.
  const causeOptions = facets.causes.map(({ cause, count }) => ({ value: cause as string, label: tCause(cause), count }));
  for (const c of causes) if (!causeOptions.some((o) => o.value === c)) causeOptions.push({ value: c, label: tCause(c), count: 0 });
  const countryOptions = facets.countries.map(({ country, count }) => ({ value: country, label: regionName(country), count }));
  for (const c of countries) if (!countryOptions.some((o) => o.value === c)) countryOptions.push({ value: c, label: regionName(c), count: 0 });
  const groups: FilterGroupData[] = [
    { name: "cause", options: sortOptions(causeOptions, locale), selected: causes },
    { name: "country", options: sortOptions(countryOptions, locale), selected: countries },
  ];
  const showFilters = filtered || causeOptions.length > 0;

  // Active filters as removable tags above the results.
  const active: { key: string; label: string; next: ListState }[] = [
    ...(q ? [{ key: "q", label: t("controls.searchTag", { q }), next: { ...state, q: "" } }] : []),
    ...causes.map((c) => ({ key: `cause-${c}`, label: tCause(c), next: { ...state, causes: causes.filter((x) => x !== c) } })),
    ...countries.map((c) => ({
      key: `country-${c}`,
      label: regionName(c),
      next: { ...state, countries: countries.filter((x) => x !== c) },
    })),
  ];
  // "Clear all" and "Show all campaigns" drop filters and search, keep the order.
  const clearHref = { pathname: "/campaigns" as const, query: listQuery({ causes: [], countries: [], q: "", sort }) };

  return (
    <div className="ch-campaigns">
      <header className="flex flex-col gap-4">
        <span className="ch-eyebrow">{t("listEyebrow")}</span>
        <h1 className="ch-section-heading">{t("listTitle")}</h1>
        <p className="m-0 max-w-[65ch] text-lg leading-7">{t("listIntro")}</p>
      </header>

      <div className={showFilters ? "ch-campaigns-body" : "ch-campaigns-body ch-campaigns-body-plain"}>
        {showFilters && <CampaignFilters groups={groups} total={total} locale={locale} keep={{ q, sort }} />}

        <div className="ch-campaigns-results">
          {showFilters && <CampaignListControls state={state} locale={locale} />}
          {showFilters && (
            <div className="ch-results-bar">
              <p className="ch-results-total" role="status">
                {t("filters.results", { count: total })}
              </p>
              {active.length > 0 && (
                <ul className="ch-active-filters" aria-label={t("filters.active")}>
                  {active.map((a) => (
                    <li key={a.key}>
                      <Link
                        href={{ pathname: "/campaigns", query: listQuery(a.next) }}
                        className="ch-active-filter"
                        aria-label={t("filters.remove", { name: a.label })}
                        scroll={false}
                      >
                        <span>{a.label}</span>
                        <span className="ch-active-filter-x" aria-hidden="true">
                          ×
                        </span>
                      </Link>
                    </li>
                  ))}
                  <li>
                    <Link href={clearHref} className="ch-proof" scroll={false}>
                      {t("filters.clearAll")}
                    </Link>
                  </li>
                </ul>
              )}
            </div>
          )}

          {!chainAvailable && (
            <p className="ch-notice" role="status">
              {t("chainUnavailable")}
            </p>
          )}

          {campaigns.length === 0 ? (
            filtered ? (
              <div className="ch-campaigns-empty">
                <p className="m-0">{t("filters.noMatch")}</p>
                <Link href={clearHref} className="ch-proof">
                  {t("filters.showAllCampaigns")}
                </Link>
              </div>
            ) : (
              <p className="ch-campaigns-empty">{t("empty")}</p>
            )
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
                <Link href={{ pathname: "/campaigns", query: listQuery({ ...state, page: page - 1 }) }} className="ch-proof">
                  {t("pagePrev")}
                </Link>
              )}
              <span>{t("pageOf", { page, count: pageCount })}</span>
              {page < pageCount && (
                <Link href={{ pathname: "/campaigns", query: listQuery({ ...state, page: page + 1 }) }} className="ch-proof">
                  {t("pageNext")}
                </Link>
              )}
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}
