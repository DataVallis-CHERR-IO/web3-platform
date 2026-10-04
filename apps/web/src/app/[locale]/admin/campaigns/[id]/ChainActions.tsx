import type * as React from "react";
import { getTranslations } from "next-intl/server";
import { getAddress } from "viem";
import type { Database } from "@cherrio/db";
import { getChainConfig, parseAppEnv } from "@cherrio/shared";
import { isMissingRelation } from "@/lib/campaigns/publish";
import { loadLifecycle, voteTally, type CampaignLifecycle } from "@/lib/campaigns/lifecycle";
import { bpsPercent } from "@/lib/campaigns/lifecycle-view";
import { listAdminEvidence } from "@/lib/campaigns/evidence";
import { listChainActionLog, loadPayoutSuggestion, openChainActions } from "@/lib/admin/guardian";
import { consoleContracts } from "@/lib/contracts/changes";
import { LocalDateTime } from "@/components/LocalDateTime";
import { UsdcAmount } from "@/components/Amount";
import { GuardianPanel } from "./GuardianPanel";

// Admin campaign page, deployed campaigns (TASK-033d): the indexed chain state,
// the vote result, the fundraiser's evidence (private files downloadable,
// audited), the CHERR.IO actions and their notes/transactions.

const heading = "text-xl font-display uppercase text-[var(--ink)]";
const subheading = "text-lg font-display uppercase text-[var(--ink)]";

export async function ChainActions(props: { db: Database; campaignId: string; address: string; individual: boolean }) {
  const t = await getTranslations("admin.guardian");
  const appEnv = parseAppEnv(process.env.APP_ENV);
  const chainConfig = getChainConfig(appEnv);
  const explorerUrl = chainConfig.chain.blockExplorerUrl ?? null;

  let lc: CampaignLifecycle | null = null;
  let unavailable = false;
  try {
    lc = await loadLifecycle(props.db, props.address.toLowerCase());
  } catch (e) {
    if (!isMissingRelation(e)) throw e;
    unavailable = true;
  }
  const [evidence, log, suggestion] = await Promise.all([
    listAdminEvidence(props.db, props.campaignId, props.address),
    listChainActionLog(props.db, props.campaignId),
    lc?.state === "SUCCEEDED" ? loadPayoutSuggestion(props.db, props.campaignId) : Promise.resolve(null),
  ]);

  const tally = lc ? voteTally(lc) : null;
  const modeText = (m: 0 | 1 | null) => (m === 0 ? t("modes.single") : m === 1 ? t("modes.milestones") : t("modes.notSet"));
  const rows: [string, React.ReactNode][] = lc
    ? [
        [t("fields.state"), t(`states.${lc.state}`)],
        [t("fields.payoutMode"), modeText(lc.payoutMode)],
        [t("fields.raised"), <UsdcAmount key="r" usdc={lc.totalRaised} />],
        [t("fields.released"), <UsdcAmount key="p" usdc={lc.released} />],
        [t("fields.tranches"), String(lc.tranchesReleased)],
        ...(lc.round && tally
          ? ([
              [t("fields.round"), String(lc.round.round)],
              [
                t("fields.turnout", { quorum: lc.snapshot.quorumBps === null ? "—" : `${bpsPercent(lc.snapshot.quorumBps)} %` }),
                `${bpsPercent(Number(tally.turnoutBps))} %`,
              ],
              [
                t("fields.approval", { approval: lc.snapshot.approvalBps === null ? "—" : `${bpsPercent(lc.snapshot.approvalBps)} %` }),
                `${bpsPercent(Number(tally.yesBps))} %`,
              ],
              [t("fields.voteEnd"), <LocalDateTime key="v" value={new Date(Number(lc.round.voteEnd) * 1000)} />],
            ] as [string, React.ReactNode][])
          : []),
      ]
    : [];

  const roles = consoleContracts(appEnv);
  const logText = (e: (typeof log)[number]) =>
    e.action === "setPayoutMode"
      ? t("logActions.setPayoutMode", { mode: modeText(e.mode) })
      : e.action === "resolve"
        ? t(e.approve ? "logActions.resolveApprove" : "logActions.resolveReject")
        : t("logActions.freeze");

  return (
    <section className="flex flex-col gap-4" aria-labelledby="chain-actions">
      <h2 id="chain-actions" className={heading}>{t("sectionTitle")}</h2>
      {unavailable ? (
        <p role="status" className="text-base text-[var(--ink)]">{t("unavailable")}</p>
      ) : !lc ? (
        <p role="status" className="text-base text-[var(--ink)]">{t("notIndexed")}</p>
      ) : (
        <>
          <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-label={t("sectionTitle")}>
            <table className="ch-ledger">
              <tbody>
                {rows.map(([field, value]) => (
                  <tr key={field}>
                    <th scope="row">{field}</th>
                    <td className="whitespace-normal break-all">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <GuardianPanel
            campaignId={props.campaignId}
            campaign={getAddress(props.address)}
            chain={{ chainId: chainConfig.chain.id, roles }}
            explorerUrl={explorerUrl}
            appEnv={appEnv}
            state={lc.state}
            open={openChainActions(lc)}
            individual={props.individual}
            suggestion={suggestion}
          />
        </>
      )}

      <h3 className={subheading}>{t("evidenceTitle")}</h3>
      {evidence.length === 0 ? (
        <p className="text-base text-[var(--ink)]">{t("evidenceNone")}</p>
      ) : (
        <ul className="flex flex-col gap-4" aria-label={t("evidenceTitle")}>
          {evidence.map((b) => (
            <li key={b.id} className="ch-panel p-4 flex flex-col gap-2 text-sm text-[var(--ink)]">
              <span className="font-bold">
                {t("evidenceRound", { payment: b.round + 1 })} · {b.onChain ? t("evidenceOnChain") : t("evidenceDraft")}
              </span>
              {b.note && <p className="whitespace-pre-line">{b.note}</p>}
              {b.bundleHash && (
                <span>
                  {t("evidenceFingerprint")}: <span className="ch-mono break-all">{b.bundleHash}</span>
                </span>
              )}
              <ul className="flex flex-col gap-1">
                {b.files.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-2">
                    <span className="ch-label">{f.visibility === "PRIVATE" ? t("evidencePrivate") : t("evidencePublic")}</span>
                    <span>{f.mimeType} · {Math.max(1, Math.round(f.sizeBytes / 1024))} KB</span>
                    <span className="ch-mono text-xs break-all">{f.sha256}</span>
                    {f.url ? (
                      <a href={f.url} target="_blank" rel="noreferrer" className="font-bold underline">{t("evidenceOpen")}</a>
                    ) : f.privateFileId ? (
                      <a href={`/api/admin/files/${f.privateFileId}`} className="font-bold underline">{t("evidenceDownload")}</a>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <h3 className={subheading}>{t("logTitle")}</h3>
      {log.length === 0 ? (
        <p className="text-base text-[var(--ink)]">{t("logEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t("logTitle")}>
          {log.map((e) => (
            <li key={e.id} className="text-sm text-[var(--ink)] flex flex-col gap-1">
              <span>
                <LocalDateTime value={new Date(e.at)} /> ·{" "}
                {e.phase === "requested" ? t("logRequested", { who: e.actor ?? "—", action: logText(e) }) : t("logSent")}
              </span>
              {e.note && <span className="whitespace-pre-line">{e.note}</span>}
              {e.txHash &&
                (explorerUrl ? (
                  <a href={`${explorerUrl}/tx/${e.txHash}`} target="_blank" rel="noreferrer" className="ch-mono underline break-all">{e.txHash}</a>
                ) : (
                  <span className="ch-mono break-all">{e.txHash}</span>
                ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
