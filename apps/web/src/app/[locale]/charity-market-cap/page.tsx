import { Suspense } from "react";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { StatusChip } from "@cherrio/ui";
import { Link } from "@/i18n/routing";
import { ListFilters } from "@/components/admin/ListFilters";
import { UsdcAmount } from "@/components/Amount";
import { getDb } from "@/lib/db";
import { listMarketCap, marketCapFacets, MARKET_CAP_PAGE, MARKET_CAP_SORTS, parseMarketCapQuery } from "@/lib/market-cap/list";

// TASK-017b (ADR-059): the public ranking of every listed organisation by Trust
// Score. State lives in the URL (filters, order, cursor); read per request.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "marketCap" });
  return { title: t("metaTitle"), description: t("metaDescription") };
}

export default async function CharityMarketCapPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const query = parseMarketCapQuery(await searchParams);
  const t = await getTranslations("marketCap");
  const tCause = await getTranslations("organizations.form.causeNames");
  const regions = new Intl.DisplayNames([locale], { type: "region" });
  const db = getDb();
  const [{ rows, next }, facets] = await Promise.all([listMarketCap(db, query), marketCapFacets(db)]);
  // Only countries and causes that have listed organisations, with how many.
  const number = new Intl.NumberFormat(locale);
  const withCount = (label: string, count: number) => `${label} (${number.format(count)})`;
  const countries = facets.countries
    .map((c) => ({ value: c.value, name: regions.of(c.value) ?? c.value, count: c.count }))
    .sort((a, b) => a.name.localeCompare(b.name, locale))
    .map((c) => ({ value: c.value, label: withCount(c.name, c.count) }));
  const causes = facets.causes
    .map((c) => ({ value: c.value as string, name: tCause(c.value), count: c.count }))
    .sort((a, b) => a.name.localeCompare(b.name, locale))
    .map((c) => ({ value: c.value, label: withCount(c.name, c.count) }));
  const filtered = Boolean(query.country || query.cause || query.on || query.q);
  const keep = Object.fromEntries(
    Object.entries({ sort: query.sort === "score" ? undefined : query.sort, country: query.country, cause: query.cause, on: query.on, q: query.q })
      .filter(([, v]) => v)
  ) as Record<string, string>;

  return (
    <div className="ch-container py-12 flex flex-col gap-8">
      <header className="flex flex-col gap-4">
        <span className="ch-eyebrow">{t("eyebrow")}</span>
        <h1 className="ch-section-heading">{t("title")}</h1>
        <p className="m-0 max-w-[70ch] text-lg leading-7">{t("intro")}</p>
        <Link href="/charity-market-cap/methodology" className="ch-proof self-start">
          {t("methodologyLink")}
        </Link>
      </header>

      <Suspense>
        <ListFilters
          messages="marketCap.filters"
          searchLabel={t("searchLabel")}
          selects={[
            {
              key: "sort",
              label: t("sortLabel"),
              value: query.sort,
              options: MARKET_CAP_SORTS.map((value) => ({ value, label: t(`sorts.${value}`) })),
            },
            {
              key: "cause",
              label: t("causeLabel"),
              value: query.cause ?? "all",
              options: [{ value: "all", label: t("filters.any") }, ...causes],
            },
            {
              key: "on",
              label: t("onLabel"),
              value: query.on ?? "all",
              options: [
                { value: "all", label: t("filters.any") },
                { value: "cherrio", label: t("on.cherrio") },
                { value: "other", label: t("on.other") },
              ],
            },
          ]}
          countries={countries}
        />
      </Suspense>

      {rows.length === 0 ? (
        <p className="ch-notice" role="status">
          {filtered ? t("empty") : t("emptyAll")}
        </p>
      ) : (
        <>
          {/* A ranked list, not a wide table (David 2026-10-08: no sideways scrolling): one row per
              organisation — rank, name with country and causes under it, score with a meter, status. */}
          <div className="ch-cmc" role="region" aria-label={t("tableLabel")}>
            <div className="ch-cmc-head" aria-hidden="true">
              <span>{t("colRank")}</span>
              <span>{t("colName")}</span>
              <span className="ch-cmc-head-score">{t("colScore")}</span>
              <span className="ch-cmc-head-status">{t("colStatus")}</span>
            </div>
            <ol className="ch-cmc-list">
              {rows.map((row) => {
                const causes = row.causes.map((c) => tCause(c));
                const shown = causes.slice(0, 3);
                return (
                  <li key={row.orgId} className="ch-cmc-row">
                    <span className="ch-cmc-rank">{row.position}</span>
                    <div className="ch-cmc-main">
                      <Link href={`/charity-market-cap/${row.orgId}`} className="ch-cmc-name">
                        {row.name}
                      </Link>
                      <p className="ch-cmc-meta">
                        {row.country && <span>{regions.of(row.country) ?? row.country}</span>}
                        {shown.length > 0 && (
                          <span>
                            {shown.join(", ")}
                            {causes.length > shown.length && (
                              <>
                                <span aria-hidden="true"> {t("moreCauses", { count: causes.length - shown.length })}</span>
                                <span className="sr-only">, {causes.slice(3).join(", ")}</span>
                              </>
                            )}
                          </span>
                        )}
                        {row.raised > 0n && (
                          <span>
                            {t("raisedShort")} <UsdcAmount usdc={row.raised} maxDecimals={0} />
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="ch-cmc-score">
                      <span className="ch-cmc-score-value" aria-label={t("scoreOf", { score: row.score })}>
                        {row.score}
                      </span>
                      <span className="ch-cmc-meter" aria-hidden="true">
                        <span style={{ width: `${Math.min(100, Number(row.score))}%` }} />
                      </span>
                    </div>
                    <div className="ch-cmc-status">
                      <StatusChip status={row.registered ? "verified" : "imported"}>
                        {row.registered ? t("on.cherrio") : t("on.other")}
                      </StatusChip>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
          <nav className="flex flex-wrap gap-6 items-center" aria-label={t("pages")}>
            {query.after && (
              <Link href={{ pathname: "/charity-market-cap", query: keep }} className="ch-proof">
                {t("firstPage")}
              </Link>
            )}
            {next && (
              <Link href={{ pathname: "/charity-market-cap", query: { ...keep, after: next } }} className="ch-proof" rel="next">
                {t("next", { count: MARKET_CAP_PAGE })}
              </Link>
            )}
          </nav>
          {filtered && <p className="m-0 text-sm text-[var(--ink-muted)]">{t("positionNote")}</p>}
        </>
      )}

      <section className="flex flex-col gap-2 text-sm text-[var(--ink-muted)] max-w-[80ch]" aria-labelledby="cmc-sources">
        <h2 id="cmc-sources" className="m-0 text-base font-bold text-[var(--ink)]">
          {t("sources.title")}
        </h2>
        <p className="m-0">{t("sources.cherrio")}</p>
        <p className="m-0">
          {t.rich("sources.uk", {
            licence: (chunks) => (
              <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" className="ch-proof" rel="license noopener">
                {chunks}
              </a>
            ),
          })}
        </p>
        <p className="m-0">{t("sources.us")}</p>
      </section>
    </div>
  );
}
