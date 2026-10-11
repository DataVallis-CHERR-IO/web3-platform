import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { StatusChip, type Status } from "@cherrio/ui";
import { formatUsdc } from "@cherrio/shared/money";
import { LocalDateTime } from "@/components/LocalDateTime";
import { getDb } from "@/lib/db";
import { explorerUrls } from "@/lib/campaigns/public";
import { consoleContracts } from "@/lib/contracts/changes";
import { durationParts, formatPercent, paramSpec, type ParamSpec } from "@/lib/contracts/config-params";
import { callRisk, loadScheduledChanges, type CallView, type ChangePhase } from "@/lib/contracts/scheduled";

// TASK-023d-2 (security review M-02): every operation scheduled on the
// TimelockController, read from the indexer, in plain words. Public, read-only,
// server-rendered per request, works without JavaScript.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "contractChanges" });
  return { title: t("metaTitle"), description: t("metaDescription") };
}

const PHASE_CHIP: Record<ChangePhase, Status> = {
  waiting: "pending",
  ready: "in-review",
  executed: "completed",
  cancelled: "rejected",
};

const short = (hex: string) => `${hex.slice(0, 10)}…${hex.slice(-6)}`;

export default async function ContractChangesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("contractChanges");
  const tc = await getTranslations("admin.contracts");
  const contracts = consoleContracts();
  const changes = contracts ? await loadScheduledChanges(getDb(), contracts) : null;
  const explorer = explorerUrls();

  const duration = (seconds: bigint) => {
    const p = durationParts(seconds);
    const parts = [
      p.days ? tc("units.days", { count: p.days }) : null,
      p.hours ? tc("units.hours", { count: p.hours }) : null,
      p.minutes ? tc("units.minutes", { count: p.minutes }) : null,
      p.seconds ? tc("units.seconds", { count: p.seconds }) : null,
    ].filter(Boolean);
    return parts.length ? parts.join(" ") : tc("units.none");
  };
  const value = (spec: ParamSpec, raw: string) => {
    switch (spec.kind) {
      case "percent": return tc("units.percent", { value: formatPercent(BigInt(raw)) });
      case "duration": return duration(BigInt(raw));
      case "usdc": return tc("units.usdc", { value: formatUsdc(BigInt(raw), { minDecimals: 2, maxDecimals: 6 }) });
      case "address": return raw;
    }
  };
  const callText = (call: CallView) => {
    switch (call.kind) {
      case "setting": {
        const spec = paramSpec(call.key);
        return t("call.setting", { label: tc(`params.${call.key}.label`), value: value(spec, call.to) });
      }
      case "role":
        return t(`call.${call.action}`, {
          role: call.role ? t(`role.${call.role}`) : t("role.unknown", { id: short(call.roleId) }),
          contract: t(`contract.${call.on}`),
          account: call.account,
        });
      case "delay":
        return t("call.delay", { value: duration(call.seconds) });
      case "unknown":
        return t("call.unknown", { selector: call.selector, target: call.target });
    }
  };
  const txLink = (hash: string) =>
    explorer ? (
      <a href={`${explorer.tx}${hash}`} target="_blank" rel="noreferrer" className="ch-inline-link">{t("figures.transaction")}</a>
    ) : (
      <span className="ch-mono break-all">{hash}</span>
    );

  return (
    <div className="ch-container py-12 flex flex-col gap-10">
      <header className="flex flex-col gap-4">
        <span className="ch-eyebrow">{t("eyebrow")}</span>
        <h1 className="ch-section-heading">{t("title")}</h1>
        <p className="m-0 max-w-[70ch] text-lg leading-7">{t("intro")}</p>
        <p className="m-0 max-w-[70ch] text-base leading-6">{t("intro2")}</p>
      </header>

      <section aria-labelledby="changes-list" className="flex flex-col gap-4">
        <h2 id="changes-list" className="ch-label m-0">{t("listTitle")}</h2>
        {!contracts ? (
          <p className="ch-notice" role="status">{t("notConfigured")}</p>
        ) : changes === null ? (
          <p className="ch-notice" role="status">{t("unavailable")}</p>
        ) : changes.length === 0 ? (
          <p className="ch-notice" role="status">{t("none")}</p>
        ) : (
          <ol className="m-0 p-0 list-none flex flex-col gap-4">
            {changes.map((c) => (
              <li key={c.id} id={`change-${c.id}`} className="ch-panel p-5 flex flex-col gap-3 min-w-0">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusChip status={PHASE_CHIP[c.phase]}>{t(`phase.${c.phase}`)}</StatusChip>
                  {c.risk !== "setting" && <StatusChip status="needs-review">{t(`risk.${c.risk}`)}</StatusChip>}
                  <span className="ch-mono text-xs text-[var(--ink-muted)]" title={c.id}>{t("operation", { id: short(c.id) })}</span>
                </div>
                <ul className="m-0 pl-5 flex flex-col gap-1">
                  {c.calls.map((call, i) => (
                    <li key={i} className={`text-base break-words${callRisk(call) === "setting" ? "" : " font-bold"}`}>
                      {callText(call)}
                    </li>
                  ))}
                </ul>
                <dl className="m-0 grid grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                  <dt>{t("figures.scheduled")}</dt>
                  <dd className="m-0"><LocalDateTime value={c.scheduledAt} /> · {txLink(c.scheduleTxHash)}</dd>
                  {(c.phase === "waiting" || c.phase === "ready") && (
                    <>
                      <dt>{t("figures.readyAt")}</dt>
                      <dd className="m-0 font-bold"><LocalDateTime value={c.readyAt} /></dd>
                    </>
                  )}
                  {c.executedAt && c.executeTxHash && (
                    <>
                      <dt>{t("figures.executedAt")}</dt>
                      <dd className="m-0"><LocalDateTime value={c.executedAt} /> · {txLink(c.executeTxHash)}</dd>
                    </>
                  )}
                  {c.phase === "cancelled" && c.cancelledAt && c.cancelTxHash && (
                    <>
                      <dt>{t("figures.cancelledAt")}</dt>
                      <dd className="m-0"><LocalDateTime value={c.cancelledAt} /> · {txLink(c.cancelTxHash)}</dd>
                    </>
                  )}
                  <dt>{t("figures.source")}</dt>
                  <dd className="m-0">{c.fromConsole ? t("figures.sourceConsole") : t("figures.sourceOther")}</dd>
                </dl>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
