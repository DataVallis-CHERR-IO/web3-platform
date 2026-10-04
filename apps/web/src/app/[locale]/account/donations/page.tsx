import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { formatUsdc } from "@cherrio/shared";
import { StatusChip } from "@cherrio/ui";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { Link } from "@/i18n/routing";
import { chipFor } from "@/components/campaigns/public-display";
import { donorAction, listMyCampaignDonations, nowSeconds, votesWaiting } from "@/lib/campaigns/lifecycle";
import { toPublicState } from "@/lib/campaigns/public";
import { shortAddress } from "@/lib/campaigns/lifecycle-view";

// "My donations" (TASK-033b part 3b): every campaign the user's linked
// addresses gave to, its state and what each address can do next. The actions
// themselves happen in the campaign page's lifecycle panel (one place to vote
// or claim), linked from here.

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "myDonations" });
  return { title: t("metaTitle") };
}

export default async function MyDonationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) redirect(`/${locale}`);

  const [list, t, tState] = await Promise.all([
    listMyCampaignDonations(getDb(), session.userId),
    getTranslations("myDonations"),
    getTranslations("campaignPage.state"),
  ]);
  const now = nowSeconds();
  const usdc = (v: bigint) => formatUsdc(v, { maxDecimals: 2 });
  const waiting = list ? votesWaiting(list, now) : 0;

  return (
    <div className="ch-container py-12">
      <div className="max-w-3xl mx-auto flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <h1 className="ch-section-heading uppercase text-[var(--ink)]">{t("title")}</h1>
          <p className="text-base text-[var(--ink-muted)]">{t("description")}</p>
          {waiting > 0 && (
            <p className="ch-notice m-0 font-bold" role="status">{t("votesWaiting", { count: waiting })}</p>
          )}
        </div>

        {list === null && <p className="ch-notice m-0" role="status">{t("unavailable")}</p>}
        {list !== null && list.length === 0 && (
          <p className="text-base text-[var(--ink)]">
            {t.rich("empty", { link: (chunks) => <Link href="/campaigns">{chunks}</Link> })}
          </p>
        )}

        {list?.map((d) => {
          const state = toPublicState(d.lifecycle.state, d.lifecycle.deadline, now);
          return (
            <article key={d.campaignId} className="ch-panel p-6 flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-xl font-display uppercase text-[var(--ink)] m-0">
                  <Link href={`/campaigns/${d.slug}`}>{d.title}</Link>
                </h2>
                <StatusChip status={chipFor(state)}>{tState(state)}</StatusChip>
              </div>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {d.positions.map((p) => {
                  const action = donorAction(d.lifecycle, p, now);
                  return (
                    <li key={p.address} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span>{t("gave", { amount: usdc(p.donated), address: shortAddress(p.address) })}</span>
                      {action.kind === "vote" && (
                        <Link href={`/campaigns/${d.slug}#lifecycle`} className="ch-btn ch-btn-primary no-underline">{t("action.vote")}</Link>
                      )}
                      {action.kind === "refund" && (
                        <Link href={`/campaigns/${d.slug}#lifecycle`} className="ch-btn ch-btn-primary no-underline">
                          {t("action.refund", { amount: usdc(action.amount) })}
                        </Link>
                      )}
                      {action.kind === "pool" && (
                        <Link href={`/campaigns/${d.slug}#lifecycle`} className="ch-btn ch-btn-primary no-underline">
                          {t("action.pool", { amount: usdc(action.amount) })}
                        </Link>
                      )}
                      {action.kind === "voted" && <span className="font-bold">{t(action.approve ? "action.votedYes" : "action.votedNo")}</span>}
                      {action.kind === "settled" && <span className="font-bold">{t("action.settled")}</span>}
                    </li>
                  );
                })}
              </ul>
            </article>
          );
        })}
      </div>
    </div>
  );
}
