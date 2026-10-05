import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { PublicCampaignCard } from "@/components/campaigns/PublicCampaignCard";
import { getDb } from "@/lib/db";
import {
  listCampaignFacets,
  listPublicCampaigns,
  parseCampaignFilters,
  type CampaignFilters,
} from "@/lib/campaigns/public";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "campaignPage" });
  return { title: t("metaTitle", { title: t("listTitle") }), description: t("listIntro") };
}

/** Query for a list link: only the filters that are set, page only above 1. */
function listQuery(filters: CampaignFilters, page?: number): Record<string, string | number> {
  const query: Record<string, string | number> = {};
  if (filters.cause) query.cause = filters.cause;
  if (filters.country) query.country = filters.country;
  if (page && page > 1) query.page = page;
  return query;
}

export default async function CampaignsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ page?: string; cause?: string | string[]; country?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const query = await searchParams;
  const t = await getTranslations("campaignPage");
  const tCause = await getTranslations("organizations.form.causeNames");
  const regionNames = new Intl.DisplayNames([locale], { type: "region" });
  const regionName = (code: string) => regionNames.of(code) ?? code;

  // TASK-039: cause / country filters from the URL; unknown values are ignored.
  const filters = parseCampaignFilters(query);
  const filtered = Boolean(filters.cause || filters.country);
  const db = getDb();
  const [{ campaigns, total, page, pageCount, chainAvailable }, facets] = await Promise.all([
    listPublicCampaigns(db, { page: Number(query.page ?? "1"), ...filters }),
    listCampaignFacets(db, filters),
  ]);
  const countries = [...facets.countries].sort((a, b) => regionName(a.country).localeCompare(regionName(b.country), locale));
  // A filter from the URL that no published campaign uses still shows as chosen.
  if (filters.country && !countries.some((c) => c.country === filters.country)) {
    countries.unshift({ country: filters.country, count: 0 });
  }
  const causes = [...facets.causes];
  if (filters.cause && !causes.some((c) => c.cause === filters.cause)) causes.unshift({ cause: filters.cause, count: 0 });
  const showFilters = filtered || causes.length > 0;

  return (
    <div className="ch-campaigns">
      <header className="flex flex-col gap-4">
        <span className="ch-eyebrow">{t("listEyebrow")}</span>
        <h1 className="ch-section-heading">{t("listTitle")}</h1>
        <p className="m-0 max-w-[65ch] text-lg leading-7">{t("listIntro")}</p>
      </header>

      {showFilters && (
        <section className="ch-filters" aria-label={t("filters.label")}>
          <nav className="ch-filter-row" aria-label={t("filters.cause")}>
            <span className="ch-filter-label">{t("filters.cause")}</span>
            <ul className="ch-filter-chips">
              <li>
                <Link
                  href={{ pathname: "/campaigns", query: listQuery({ country: filters.country }) }}
                  className="ch-filter-chip"
                  aria-current={filters.cause ? undefined : "true"}
                >
                  {t("filters.allCauses")}
                </Link>
              </li>
              {causes.map(({ cause, count }) => (
                <li key={cause}>
                  <Link
                    href={{ pathname: "/campaigns", query: listQuery({ cause, country: filters.country }) }}
                    className="ch-filter-chip"
                    aria-current={filters.cause === cause ? "true" : undefined}
                  >
                    {t("filters.causeOption", { name: tCause(cause), count })}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* A plain GET form: works without JavaScript and keeps the cause. */}
          <form className="ch-filter-row" method="get" action={`/${locale}/campaigns`}>
            <label className="ch-filter-label" htmlFor="campaign-country">
              {t("filters.country")}
            </label>
            {filters.cause && <input type="hidden" name="cause" value={filters.cause} />}
            <select id="campaign-country" name="country" className="ch-filter-select" defaultValue={filters.country ?? ""}>
              <option value="">{t("filters.allCountries")}</option>
              {countries.map(({ country, count }) => (
                <option key={country} value={country}>
                  {t("filters.countryOption", { name: regionName(country), count })}
                </option>
              ))}
            </select>
            <button type="submit" className="ch-btn">
              {t("filters.apply")}
            </button>
          </form>

          <p className="ch-filter-summary" role="status">
            <span>{t("filters.results", { count: total })}</span>
            {filtered && (
              <Link href="/campaigns" className="ch-proof">
                {t("filters.clear")}
              </Link>
            )}
          </p>
        </section>
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
            <Link href="/campaigns" className="ch-proof">
              {t("filters.showAll")}
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
            <Link href={{ pathname: "/campaigns", query: listQuery(filters, page - 1) }} className="ch-proof">
              {t("pagePrev")}
            </Link>
          )}
          <span>{t("pageOf", { page, count: pageCount })}</span>
          {page < pageCount && (
            <Link href={{ pathname: "/campaigns", query: listQuery(filters, page + 1) }} className="ch-proof">
              {t("pageNext")}
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
