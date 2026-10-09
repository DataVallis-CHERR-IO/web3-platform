import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { StatusChip, type Status } from "@cherrio/ui";
import { Link } from "@/i18n/routing";
import { UsdcAmount } from "@/components/Amount";
import { LocalDateTime } from "@/components/LocalDateTime";
import { getDb } from "@/lib/db";
import { bpsPercent } from "@/lib/campaigns/lifecycle-view";
import { getChainConfig, parseAppEnv } from "@cherrio/shared";
import { GivePanel } from "@/components/pool/GivePanel";
import { emergencyPoolAddress } from "@/lib/admin/subpools";
import { explorerUrls } from "@/lib/campaigns/public";
import { allocationPhase, loadAllocations, loadPoolCards, voteFigures, type AllocationPhase } from "@/lib/pool/public";

// TASK-014a: the public Emergency Pool page — what it is, every sub-pool on chain
// with its balance, and every allocation vote with the rule it is judged by.
// Read-only, server-rendered per request, works without JavaScript.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "emergencyPool" });
  return { title: t("metaTitle"), description: t("metaDescription") };
}

const PHASE_CHIP: Record<AllocationPhase, Status> = {
  open: "voting",
  counting: "in-review",
  sent: "succeeded",
  notApproved: "rejected",
  review: "needs-review",
  sentByCherrio: "succeeded",
  returnedByCherrio: "rejected",
  notSent: "failed",
};

export default async function EmergencyPoolPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const db = getDb();
  const [pools, allocations] = await Promise.all([loadPoolCards(db), loadAllocations(db)]);
  const t = await getTranslations("emergencyPool");
  const tPool = await getTranslations("pool");
  const number = new Intl.NumberFormat(locale);
  const total = (pools ?? []).reduce((sum, p) => sum + p.balance, 0n);
  // "Give to this pool" (TASK-014b): only where this environment has an EmergencyPool.
  const appEnv = parseAppEnv(process.env.APP_ENV ?? "local");
  const poolAddress = emergencyPoolAddress(appEnv);
  const chain = getChainConfig(appEnv).chain;
  const explorer = explorerUrls();
  const poolName = (slug: string | null, id: number) =>
    slug && tPool.has(`${slug}.name`) ? tPool(`${slug}.name`) : t("poolNumber", { id });

  return (
    <div className="ch-container py-12 flex flex-col gap-10">
      <header className="flex flex-col gap-4">
        <span className="ch-eyebrow">{t("eyebrow")}</span>
        <h1 className="ch-section-heading">{t("title")}</h1>
        <p className="m-0 max-w-[70ch] text-lg leading-7">{t("intro")}</p>
      </header>

      <section aria-labelledby="pool-how" className="flex flex-col gap-4">
        <h2 id="pool-how" className="ch-label m-0">{t("how.title")}</h2>
        <ul className="ch-pool-how">
          {(["in", "propose", "vote", "out"] as const).map((step) => (
            <li key={step} className="ch-panel p-4 flex flex-col gap-2">
              <strong className="text-base">{t(`how.${step}.title`)}</strong>
              <span className="text-sm leading-6">{t(`how.${step}.body`)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="pool-balances" className="flex flex-col gap-4">
        <h2 id="pool-balances" className="ch-label m-0">{t("balances.title")}</h2>
        {pools === null ? (
          <p className="ch-notice" role="status">{t("unavailable")}</p>
        ) : (
          <>
            <p className="m-0 text-base">
              {t("balances.total")} <strong><UsdcAmount usdc={total} /></strong>
            </p>
            <ul className="ch-pool-grid" aria-label={t("balances.title")}>
              {pools.map((p) => (
                <li key={p.poolId} className="ch-panel p-5 flex flex-col gap-3 min-w-0">
                  <h3 className="m-0 text-lg font-bold">{poolName(p.slug, p.poolId)}</h3>
                  <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
                    <dt>{t("balances.available")}</dt>
                    <dd className="m-0 text-right font-bold"><UsdcAmount usdc={p.balance} /></dd>
                    <dt>{t("balances.contributed")}</dt>
                    <dd className="m-0 text-right"><UsdcAmount usdc={p.contributed} /></dd>
                    <dt>{t("balances.contributors")}</dt>
                    <dd className="m-0 text-right ch-mono">{number.format(p.contributors)}</dd>
                  </dl>
                  {poolAddress && (
                    <GivePanel
                      pool={poolAddress}
                      poolId={p.poolId}
                      poolName={poolName(p.slug, p.poolId)}
                      chainId={chain.id}
                      networkName={chain.name}
                      testnet={chain.testnet}
                      explorerTx={explorer ? explorer.tx : null}
                      appEnv={appEnv}
                    />
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="pool-allocations" className="flex flex-col gap-4">
        <h2 id="pool-allocations" className="ch-label m-0">{t("allocations.title")}</h2>
        <p className="m-0 max-w-[70ch] text-sm leading-6 text-[var(--ink-muted)]">{t("allocations.rule")}</p>
        {allocations === null ? (
          <p className="ch-notice" role="status">{t("unavailable")}</p>
        ) : allocations.length === 0 ? (
          <p className="ch-notice" role="status">{t("allocations.none")}</p>
        ) : (
          <ol className="m-0 p-0 list-none flex flex-col gap-4">
            {allocations.map((a) => {
              const phase = allocationPhase(a.state, a.voteEnd);
              const f = voteFigures(a);
              const voted = phase !== "review" && phase !== "sentByCherrio" && phase !== "returnedByCherrio";
              return (
                <li key={a.id} className="ch-panel p-5 flex flex-col gap-3 min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusChip status={PHASE_CHIP[phase]}>{t(`phase.${phase}`)}</StatusChip>
                    <span className="ch-mono text-xs text-[var(--ink-muted)]">{t("allocations.number", { id: a.id })}</span>
                  </div>
                  <p className="m-0 text-base break-words">
                    {t.rich("allocations.summary", {
                      amount: () => <strong><UsdcAmount usdc={a.amount} /></strong>,
                      pool: poolName(a.poolSlug, a.poolId),
                      campaign: () =>
                        a.campaignSlug ? (
                          <Link href={`/campaigns/${a.campaignSlug}`}>{a.campaignTitle}</Link>
                        ) : (
                          <span className="ch-mono" title={a.campaignAddress}>{`${a.campaignAddress.slice(0, 6)}…${a.campaignAddress.slice(-4)}`}</span>
                        ),
                    })}
                  </p>
                  {a.reasonText !== null ? (
                    <div className="flex flex-col gap-1">
                      <p className="m-0 text-sm font-bold">{t("allocations.reason")}</p>
                      <p className="m-0 text-base whitespace-pre-line break-words">{a.reasonText}</p>
                      <p className="m-0 text-xs text-[var(--ink-muted)] ch-mono break-all">{t("allocations.reasonCheck", { hash: a.reasonHash })}</p>
                    </div>
                  ) : (
                    <p className="m-0 text-sm text-[var(--ink-muted)] break-all">{t("allocations.reasonMissing", { hash: a.reasonHash })}</p>
                  )}
                  {a.delivered !== null && a.delivered !== a.amount && (
                    <p className="m-0 text-sm">
                      {t.rich("allocations.deliveredPart", { delivered: () => <UsdcAmount usdc={a.delivered!} /> })}
                    </p>
                  )}
                  <dl className="m-0 grid grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm ch-pool-figures">
                    <dt>{phase === "open" ? t("allocations.ends") : t("allocations.ended")}</dt>
                    <dd className="m-0"><LocalDateTime value={a.voteEnd} /></dd>
                    {voted && (
                      <>
                        <dt>{t("allocations.turnout")}</dt>
                        <dd className="m-0">
                          {t("allocations.ofNeeded", { value: bpsPercent(f.turnoutBps), needed: bpsPercent(a.quorumBps) })}
                        </dd>
                        <dt>{t("allocations.yes")}</dt>
                        <dd className="m-0">
                          {f.approvalBps === null
                            ? t("allocations.noVotesYet", { needed: bpsPercent(a.approvalBps) })
                            : t("allocations.ofNeeded", { value: bpsPercent(f.approvalBps), needed: bpsPercent(a.approvalBps) })}
                        </dd>
                        <dt>{t("allocations.weights")}</dt>
                        <dd className="m-0">
                          {t.rich("allocations.weightValues", {
                            yes: () => <UsdcAmount usdc={a.yes} />,
                            no: () => <UsdcAmount usdc={a.no} />,
                            eligible: () => <UsdcAmount usdc={a.eligible} />,
                          })}
                        </dd>
                      </>
                    )}
                  </dl>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
