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
          <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-label={t("tableLabel")}>
            <table className="ch-ledger">
              <thead>
                <tr>
                  <th scope="col" className="ch-num">{t("colRank")}</th>
                  <th scope="col">{t("colName")}</th>
                  <th scope="col" className="hidden md:table-cell">{t("colCountry")}</th>
                  <th scope="col" className="hidden lg:table-cell">{t("colCauses")}</th>
                  <th scope="col" className="ch-num">{t("colScore")}</th>
                  <th scope="col" className="ch-num hidden md:table-cell">{t("colRaised")}</th>
                  <th scope="col">{t("colStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.orgId}>
                    <td className="ch-num">{row.position}</td>
                    <td className="whitespace-normal min-w-[9rem] md:min-w-[14rem]">
                      <Link href={`/charity-market-cap/${row.orgId}`}>{row.name}</Link>
                    </td>
                    <td className="hidden md:table-cell">{row.country ? (regions.of(row.country) ?? row.country) : "—"}</td>
                    <td className="whitespace-normal ch-ledger-muted hidden lg:table-cell">
                      {row.causes.length > 0 ? row.causes.map((c) => tCause(c)).join(", ") : "—"}
                    </td>
                    <td className="ch-num">
                      <span className="ch-market-cap-score" aria-label={t("scoreOf", { score: row.score })}>
                        {row.score}
                      </span>
                    </td>
                    <td className="ch-num hidden md:table-cell">{row.raised > 0n ? <UsdcAmount usdc={row.raised} maxDecimals={0} /> : "—"}</td>
                    <td>
                      <StatusChip status={row.registered ? "verified" : "imported"}>
                        {row.registered ? t("on.cherrio") : t("on.other")}
                      </StatusChip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
