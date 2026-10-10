import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { loadGuardianQueue } from "@/lib/admin/guardian";
import { Link } from "@/i18n/routing";
import { formatUsdc, getChainConfig, parseAppEnv } from "@cherrio/shared";
import { consoleContracts } from "@/lib/contracts/changes";
import { emergencyPoolAddress } from "@/lib/admin/subpools";
import { bpsPercent } from "@/lib/campaigns/lifecycle-view";
import { loadAllocations, voteFigures } from "@/lib/pool/public";
import { PoolReviews, type PoolReviewItem } from "./PoolReviews";

export const dynamic = "force-dynamic";

/**
 * Admin → Chain actions (TASK-033d; Emergency Pool allocations TASK-014c-3) —
 * PLATFORM_ADMIN only; 404 for everyone else.
 */
export default async function AdminGuardianPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  try {
    await requireRole("PLATFORM_ADMIN");
  } catch {
    notFound();
  }
  const t = await getTranslations("admin.guardian");
  const tReview = await getTranslations("admin.guardian.poolReview");
  const tPool = await getTranslations("pool");
  const db = getDb();
  const [queue, reviews] = await Promise.all([loadGuardianQueue(db), loadAllocations(db, 100, { state: "NEEDS_REVIEW" })]);
  const appEnv = process.env.APP_ENV ?? "local";
  const chainConfig = getChainConfig(parseAppEnv(appEnv));
  const pool = emergencyPoolAddress(appEnv);
  const usdc = (v: bigint) => formatUsdc(v, { minDecimals: 2, maxDecimals: 6 });
  const items: PoolReviewItem[] = (reviews ?? []).map((a) => {
    const f = voteFigures(a);
    const poolName = a.poolSlug && tPool.has(`${a.poolSlug}.name` as never) ? tPool(`${a.poolSlug}.name` as never) : tReview("poolNumber", { id: a.poolId });
    const campaign = a.campaignTitle ?? `${a.campaignAddress.slice(0, 6)}…${a.campaignAddress.slice(-4)}`;
    return {
      id: a.id,
      heading: tReview("heading", { id: a.id, amount: usdc(a.amount), pool: poolName, campaign }),
      why: a.eligible === 0n
        ? tReview("whyNoWeight")
        : tReview("whyQuorum", { turnout: bpsPercent(f.turnoutBps), quorum: bpsPercent(a.quorumBps), yes: usdc(a.yes), no: usdc(a.no) }),
      reason: a.reasonText,
    };
  });

  return (
    <div className="ch-account-page flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Link href="/admin" className="text-sm font-bold underline text-[var(--ink)]">
          {t("back")}
        </Link>
        <span className="ch-eyebrow">{t("eyebrow")}</span>
        <h1 className="ch-section-heading uppercase text-[var(--ink)]">{t("title")}</h1>
        <p className="text-[var(--ink)] max-w-3xl">{t("intro")}</p>
      </div>
      <section aria-labelledby="pool-reviews" className="flex flex-col gap-3">
        <h2 id="pool-reviews" className="text-lg font-display uppercase text-[var(--ink)]">{tReview("title")}</h2>
        <p className="text-sm text-[var(--ink)] max-w-3xl">{tReview("intro")}</p>
        {reviews === null ? (
          <p role="status" className="ch-panel p-5 font-bold text-[var(--ink)]">{t("unavailable")}</p>
        ) : items.length === 0 ? (
          <p className="text-base text-[var(--ink)]">{tReview("empty")}</p>
        ) : pool ? (
          <PoolReviews
            appEnv={appEnv}
            chainId={chainConfig.chain.id}
            pool={pool}
            roles={consoleContracts(appEnv)}
            explorerUrl={chainConfig.chain.blockExplorerUrl ?? null}
            items={items}
          />
        ) : (
          <p role="status" className="ch-panel p-5 font-bold text-[var(--ink)]">{tReview("noPool")}</p>
        )}
      </section>
      <h2 className="text-lg font-display uppercase text-[var(--ink)]">{tReview("campaignsTitle")}</h2>
      {queue === null ? (
        <p role="status" className="ch-panel p-5 font-bold text-[var(--ink)]">{t("unavailable")}</p>
      ) : queue.length === 0 ? (
        <p className="text-base text-[var(--ink)]">{t("empty")}</p>
      ) : (
        <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-label={t("title")}>
          <table className="ch-ledger">
            <thead>
              <tr>
                <th>{t("colCampaign")}</th>
                <th>{t("colOrganisation")}</th>
                <th>{t("colState")}</th>
                <th>{t("colTask")}</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-normal">
                    <Link href={`/admin/campaigns/${row.id}#chain-actions`} className="font-bold underline">
                      {row.title}
                    </Link>
                  </td>
                  <td className="whitespace-normal">{row.organization ?? "—"}</td>
                  <td className="whitespace-normal">{t(`states.${row.state}`)}</td>
                  <td className="whitespace-normal font-bold">{t(`tasks.${row.task}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
