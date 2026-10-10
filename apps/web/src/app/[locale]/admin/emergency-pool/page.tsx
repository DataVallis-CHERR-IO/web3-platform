import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { formatUsdc, getChainConfig, parseAppEnv } from "@cherrio/shared";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { consoleContracts } from "@/lib/contracts/changes";
import { emergencyPoolAddress, loadSubpools } from "@/lib/admin/subpools";
import { SubpoolActions } from "./SubpoolActions";
import { ProposeAllocation } from "./ProposeAllocation";
import { proposableCampaigns } from "@/lib/pool/allocations";

export const dynamic = "force-dynamic";

/** Admin → Emergency Pool (TASK-046 sub-pools, TASK-014c allocations) — PLATFORM_ADMIN only; 404 for everyone else. */
export default async function AdminEmergencyPoolPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  try {
    await requireRole("PLATFORM_ADMIN");
  } catch {
    notFound();
  }
  const t = await getTranslations("admin.pool");
  const tPool = await getTranslations("pool");
  const appEnv = process.env.APP_ENV ?? "local";
  const chainConfig = getChainConfig(parseAppEnv(appEnv));
  const pool = emergencyPoolAddress(appEnv);
  const db = getDb();
  const [rows, liveCampaigns] = await Promise.all([loadSubpools(db), proposableCampaigns(db)]);
  const themeName = (slug: string) => (tPool.has(`${slug}.name` as never) ? tPool(`${slug}.name` as never) : slug);
  const missing = rows?.filter((r) => !r.onChain && r.poolId > 0) ?? [];

  return (
    <div className="ch-account-page flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <span className="ch-eyebrow">{t("eyebrow")}</span>
        <h1 className="ch-section-heading uppercase text-[var(--ink)]">{t("title")}</h1>
        <p className="text-[var(--ink)] max-w-3xl">{t("intro")}</p>
      </div>
      {rows === null ? (
        <p role="status" className="ch-panel p-5 font-bold text-[var(--ink)]">{t("unavailable")}</p>
      ) : (
        <>
          <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-label={t("title")}>
            <table className="ch-ledger">
              <thead>
                <tr>
                  <th>{t("colTheme")}</th>
                  <th>{t("colId")}</th>
                  <th>{t("colOnChain")}</th>
                  <th>{t("colBalance")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.poolId}>
                    <td className="whitespace-normal font-bold">{themeName(row.slug)}</td>
                    <td className="ch-mono">{row.poolId}</td>
                    <td>{row.onChain ? t("yes") : t("notYet")}</td>
                    <td className="ch-mono">
                      {row.balance === null ? "—" : t("balance", { amount: formatUsdc(row.balance, { minDecimals: 2, maxDecimals: 2 }) })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-base font-bold text-[var(--ink)]">
            {missing.length === 0 ? t("allOnChain") : t("missingCount", { count: missing.length })}
          </p>
          {missing.length > 0 &&
            (pool ? (
              <SubpoolActions
                appEnv={appEnv}
                chainId={chainConfig.chain.id}
                pool={pool}
                roles={consoleContracts(appEnv)}
                explorerUrl={chainConfig.chain.blockExplorerUrl ?? null}
                missing={missing.map((r) => ({ poolId: r.poolId, name: themeName(r.slug) }))}
              />
            ) : (
              <p role="status" className="text-base text-[var(--ink)]">{t("contractMissing")}</p>
            ))}
          {pool && (
            <ProposeAllocation
              appEnv={appEnv}
              chainId={chainConfig.chain.id}
              pool={pool}
              roles={consoleContracts(appEnv)}
              explorerUrl={chainConfig.chain.blockExplorerUrl ?? null}
              pools={rows.filter((r) => r.onChain && r.balance !== null).map((r) => ({ poolId: r.poolId, name: themeName(r.slug), balance: r.balance!.toString() }))}
              campaigns={(liveCampaigns ?? []).map((c) => ({ id: c.id, title: c.title, address: c.address }))}
            />
          )}
        </>
      )}
    </div>
  );
}
