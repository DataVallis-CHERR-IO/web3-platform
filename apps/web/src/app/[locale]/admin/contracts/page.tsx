import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getChainConfig, parseAppEnv } from "@cherrio/shared";
import { requireRole } from "@/lib/auth/session";
import { consoleContracts } from "@/lib/contracts/changes";
import { Link } from "@/i18n/routing";
import { ContractConsole } from "./ContractConsole";

/** Admin → Contracts (TASK-034b, ADR-046) — PLATFORM_ADMIN only; 404 for everyone else. */
export default async function AdminContractsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  try {
    await requireRole("PLATFORM_ADMIN");
  } catch {
    notFound();
  }
  const t = await getTranslations("admin.contracts");
  const appEnv = parseAppEnv(process.env.APP_ENV);
  const chainConfig = getChainConfig(appEnv);
  const contracts = consoleContracts(appEnv);

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
      {contracts ? (
        <ContractConsole
          chain={contracts}
          networkName={chainConfig.chain.name}
          explorerUrl={chainConfig.chain.blockExplorerUrl ?? null}
          appEnv={appEnv}
        />
      ) : (
        <p role="status" className="ch-panel p-5 font-bold text-[var(--ink)]">
          {t("notConfigured")}
        </p>
      )}
    </div>
  );
}
