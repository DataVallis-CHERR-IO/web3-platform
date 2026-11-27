import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AGENT_CREW, agentCrewEnabled } from "@cherrio/shared/agent-crew";
import { formatUsdc } from "@cherrio/shared/money";
import { Link } from "@/i18n/routing";
import { LocalDateTime } from "@/components/LocalDateTime";
import { getDb } from "@/lib/db";
import { explorerUrls } from "@/lib/campaigns/public";
import { loadAgentActivity, type ActivityItem, type AgentActivity, type CrewStats } from "@/lib/agents/activity";

// TASK-061f: what the testnet agents do, in public. Testnet (dev) and local only —
// 404 on uat and prod, where the crew does not exist. Server-rendered per request.
export const dynamic = "force-dynamic";

/** Public list of the Agents workflow's runs (the repository is public, ADR-044). */
const RUNS_URL = "https://github.com/DataVallis-CHERR-IO/web3-platform/actions/workflows/agents.yml";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "agentsPage" });
  return { title: t("metaTitle"), description: t("metaDescription"), robots: { index: false } };
}

// Exact amounts (agents give converted amounts such as 1.0975): a transparency page should not round.
const usdc = (value: bigint) => formatUsdc(value, { minDecimals: 2, maxDecimals: 6 });

export default async function AgentsPage({ params }: { params: Promise<{ locale: string }> }) {
  if (!agentCrewEnabled(process.env.APP_ENV)) notFound();
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("agentsPage");
  const explorer = explorerUrls();

  let activity: AgentActivity | null = null;
  try {
    activity = await loadAgentActivity(getDb(), AGENT_CREW);
  } catch (error) {
    console.error("[agents] activity failed:", error instanceof Error ? error.message : error);
  }

  const did = (s: Omit<CrewStats, "entry">) => {
    const lines: string[] = [];
    if (s.donations.count) lines.push(t("did.donations", { count: s.donations.count, amount: usdc(s.donations.usdc) }));
    if (s.poolGifts.count) lines.push(t("did.pool", { count: s.poolGifts.count, amount: usdc(s.poolGifts.usdc) }));
    if (s.organisationsApplied) lines.push(t("did.applied", { count: s.organisationsApplied }));
    if (s.campaignsStarted) lines.push(t("did.started", { count: s.campaignsStarted, live: s.campaignsLive }));
    if (s.organisationsApproved) lines.push(t("did.organisationsApproved", { count: s.organisationsApproved }));
    if (s.campaignsApproved) lines.push(t("did.campaignsApproved", { count: s.campaignsApproved }));
    if (s.campaignsPublished) lines.push(t("did.campaignsPublished", { count: s.campaignsPublished }));
    if (s.scamAttempts) lines.push(t("did.scamAttempts", { count: s.scamAttempts }));
    if (s.scamsCaught) lines.push(t("did.scamsCaught", { count: s.scamsCaught }));
    if (s.scamsMissed) lines.push(t("did.scamsMissed", { count: s.scamsMissed }));
    return lines;
  };

  const what = (item: ActivityItem) => {
    const agent = t("agentName", { name: item.agent });
    switch (item.kind) {
      case "donation":
        return item.campaign ? (
          <>{t("event.donationTo", { agent, amount: usdc(item.usdc) })}{" "}<Link href={`/campaigns/${item.campaign.slug}`} className="ch-inline-link">{item.campaign.title}</Link></>
        ) : t("event.donation", { agent, amount: usdc(item.usdc) });
      case "pool":
        return t("event.pool", { agent, amount: usdc(item.usdc) });
      case "organisation_applied":
        return t("event.organisation_applied", { agent });
      case "organisation_approved":
        return t("event.organisation_approved", { agent });
      case "scam_attempt":
      case "scam_caught":
      case "scam_missed":
        return t(`event.${item.kind}`, { agent });
      case "campaign_submitted":
      case "campaign_approved":
      case "campaign_published":
        return item.campaign ? (
          <>{t(`event.${item.kind}Named`, { agent })}{" "}<Link href={`/campaigns/${item.campaign.slug}`} className="ch-inline-link">{item.campaign.title}</Link></>
        ) : t(`event.${item.kind}`, { agent });
    }
  };

  const totals = activity?.totals;

  return (
    <div className="ch-container py-12 flex flex-col gap-10">
      <header className="flex flex-col gap-4">
        <span className="ch-eyebrow">{t("eyebrow")}</span>
        <h1 className="ch-section-heading">{t("title")}</h1>
        <p className="m-0 max-w-[70ch] text-lg leading-7">{t("intro")}</p>
        <p className="m-0 max-w-[70ch] text-base leading-6">{t("intro2")}</p>
      </header>

      {!activity || !totals ? (
        <p className="ch-notice" role="status">{t("unavailable")}</p>
      ) : (
        <>
          <section aria-labelledby="agents-totals" className="flex flex-col gap-4">
            <h2 id="agents-totals" className="ch-label m-0">{t("totalsTitle")}</h2>
            <dl className="ch-impact-stats">
              {([
                ["donations", String(totals.donations.count), t("usdc", { amount: usdc(totals.donations.usdc) })],
                ["pool", String(totals.poolGifts.count), t("usdc", { amount: usdc(totals.poolGifts.usdc) })],
                ["applied", String(totals.organisationsApplied), null],
                ["organisationsApproved", String(totals.organisationsApproved), null],
                ["started", String(totals.campaignsStarted), null],
                ["live", String(totals.campaignsLive), null],
                ["approved", String(totals.campaignsApproved), null],
                ["published", String(totals.campaignsPublished), null],
                ["scams", String(totals.scamsCaught), t("scamsOf", { count: totals.scamAttempts })],
              ] as const).map(([key, value, sub]) => (
                <div key={key} className="ch-impact-stat">
                  <dt>{sub ? t("totalWithAmount", { label: t(`totals.${key}`), amount: sub }) : t(`totals.${key}`)}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="agents-crew" className="flex flex-col gap-4">
            <h2 id="agents-crew" className="ch-label m-0">{t("crewTitle")}</h2>
            <ul className="m-0 p-0 list-none grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" aria-label={t("crewCaption")}>
              {activity.crew.map((s) => {
                const lines = did(s);
                return (
                  <li key={s.entry.name} className="ch-panel p-5 flex flex-col gap-2 min-w-0">
                    <h3 className="m-0 text-lg font-bold">{t("agentName", { name: s.entry.name })}</h3>
                    <p className="m-0 text-sm">{t(`role.${s.entry.persona}`)}</p>
                    <p className="m-0 text-sm">
                      {explorer ? (
                        <a href={`${explorer.address}${s.entry.address}`} target="_blank" rel="noreferrer" className="ch-inline-link break-all">
                          {t("walletLink", { address: `${s.entry.address.slice(0, 6)}…${s.entry.address.slice(-4)}` })}
                        </a>
                      ) : (
                        <span className="ch-mono break-all">{s.entry.address}</span>
                      )}
                    </p>
                    {lines.length === 0 ? (
                      <p className="m-0 text-sm text-[var(--ink-muted)]">{t("did.nothing")}</p>
                    ) : (
                      <ul className="m-0 pl-5 text-sm flex flex-col gap-1">
                        {lines.map((line) => <li key={line}>{line}</li>)}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="agents-recent" className="flex flex-col gap-4">
            <h2 id="agents-recent" className="ch-label m-0">{t("recentTitle")}</h2>
            {activity.recent.length === 0 ? (
              <p className="ch-notice" role="status">{t("recentNone")}</p>
            ) : (
              <ul className="ch-impact-recent">
                {activity.recent.map((item, i) => (
                  <li key={i}>
                    <span className="ch-impact-recent-what">{what(item)}</span>
                    <span className="ch-impact-recent-date"><LocalDateTime value={item.at} /></span>
                    <span className="text-sm">
                      {"tx" in item && explorer ? (
                        <a href={`${explorer.tx}${item.tx}`} target="_blank" rel="noreferrer" className="ch-inline-link">{t("transaction")}</a>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <section aria-labelledby="agents-runs" className="flex flex-col gap-2">
        <h2 id="agents-runs" className="ch-label m-0">{t("runsTitle")}</h2>
        <p className="m-0 max-w-[70ch] text-base leading-6">
          {t("runs")}{" "}<a href={RUNS_URL} target="_blank" rel="noreferrer" className="ch-inline-link">{t("runsLink")}</a>
        </p>
      </section>
    </div>
  );
}
