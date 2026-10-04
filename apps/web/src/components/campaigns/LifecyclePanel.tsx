"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { createPublicClient, custom, http, type Address, type Hash, type PublicClient } from "viem";
import { Button, ProofLink } from "@cherrio/ui";
import { formatUsdc } from "@cherrio/shared/money";
import { useRouter } from "@/i18n/routing";
import { useAppAuth } from "@/components/auth/PrivyClientProvider";
import { LocalDateTime } from "@/components/LocalDateTime";
import { sendLifecycle, toLifecycleFailure, type LifecycleAction } from "@/lib/campaigns/lifecycle-client";
import {
  bpsPercent, panelView, shortAddress, type LifecycleData, type PositionData, type Trigger,
} from "@/lib/campaigns/lifecycle-view";
import {
  anySigner, signerFor, useE2eSigner, usePrivySigners, type Signer, type SignerState,
} from "./lifecycle-signers";

// The campaign page after LIVE (TASK-033b part 3): finish the campaign, the
// payout, the donor vote, refunds and Emergency Pool settlements. Data from
// `GET /api/lifecycle/:campaign`; every action is simulated through the
// same-origin `/api/rpc` reader and signed in the user's wallet (sendLifecycle).

export interface LifecyclePanelProps {
  campaign: Address;
  chainId: number;
  explorerTx: string | null;
  appEnv: string;
  initial: LifecycleData;
}

export function LifecyclePanel(props: LifecyclePanelProps) {
  const { isAvailable } = useAppAuth();
  const e2e = useE2eSigner(props.appEnv);
  if (isAvailable) return <PrivyLifecycle {...props} />;
  return <LifecycleUi {...props} signers={e2e ? { kind: "ready", signers: [e2e] } : { kind: "unavailable" }} e2e={e2e} />;
}

function PrivyLifecycle(props: LifecyclePanelProps) {
  const signers = usePrivySigners(props.chainId);
  return <LifecycleUi {...props} signers={signers} e2e={null} />;
}

type Busy = null | { key: string };
type Message = { kind: "ok" | "error"; text: string; tx?: Hash } | null;

const POLL_MS = 5_000;
const POLL_FOR_MS = 120_000;

function LifecycleUi(props: LifecyclePanelProps & { signers: SignerState; e2e: Signer | null }) {
  const t = useTranslations("campaignPage.lifecycle");
  const router = useRouter();
  const [data, setData] = React.useState<{ lifecycle: LifecycleData; positions: PositionData[] | null; now: bigint }>({
    lifecycle: props.initial, positions: null, now: BigInt(Math.floor(Date.now() / 1000)),
  });
  const [busy, setBusy] = React.useState<Busy>(null);
  const [message, setMessage] = React.useState<Message>(null);
  const signedIn = props.signers.kind === "ready";

  const load = React.useCallback(async () => {
    const res = await fetch(`/api/lifecycle/${props.campaign}`, { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as { now: string; lifecycle: LifecycleData; positions: PositionData[] | null };
    const next = { lifecycle: json.lifecycle, positions: json.positions, now: BigInt(json.now) };
    setData(next);
    return next;
  }, [props.campaign]);

  React.useEffect(() => { void load(); }, [load, signedIn]);

  // Reads and simulations: the E2E wallet locally, else the same-origin RPC proxy. No retries: a revert is final.
  const reader = React.useMemo<PublicClient | null>(() => {
    if (props.e2e) return null; // resolved per call from the E2E wallet's provider
    if (typeof window === "undefined") return null;
    return createPublicClient({ transport: http(`${window.location.origin}/api/rpc`, { retryCount: 0 }) });
  }, [props.e2e]);

  const view = panelView(data.lifecycle, data.positions, data.now);
  const lc = data.lifecycle;
  const signers = props.signers.kind === "ready" ? props.signers.signers : [];
  const usdc = (v: string) => formatUsdc(BigInt(v), { maxDecimals: 2 });

  async function run(key: string, signer: Signer, action: LifecycleAction) {
    setBusy({ key });
    setMessage(null);
    let tx: Hash | undefined;
    try {
      const provider = await signer.provider(props.chainId);
      const read = reader ?? createPublicClient({ transport: custom(provider, { retryCount: 0 }) });
      tx = await sendLifecycle(provider, signer.account, { chainId: props.chainId, campaign: props.campaign, action }, {
        reader: read, sendCalls: signer.sendCalls,
      });
      setMessage({ kind: "ok", text: t("sent"), tx });
      const receipt = await read.waitForTransactionReceipt({ hash: tx, timeout: 180_000, pollingInterval: 3_000 }).catch((e: unknown) => {
        console.error("[lifecycle] receipt", tx, e);
        return null;
      });
      if (receipt && receipt.status !== "success") {
        setMessage({ kind: "error", text: t("errors.reverted"), tx });
        return;
      }
      setMessage({ kind: "ok", text: t("confirmed"), tx });
      // The indexer sees the transaction within about a minute; refresh until the state moves.
      const before = JSON.stringify([data.lifecycle.state, data.lifecycle.round, data.positions]);
      const until = Date.now() + POLL_FOR_MS;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const next = await load();
        if (next && JSON.stringify([next.lifecycle.state, next.lifecycle.round, next.positions]) !== before) break;
      }
      router.refresh();
    } catch (e) {
      console.error("[lifecycle] action", action.kind, e);
      const code = toLifecycleFailure(e);
      setMessage({ kind: "error", text: t.has(`errors.${code}` as never) ? t(`errors.${code}` as never) : t("errors.failed"), tx });
    } finally {
      setBusy(null);
    }
  }

  const txLink = (tx: Hash) =>
    props.explorerTx ? (
      <ProofLink href={`${props.explorerTx}${tx}`} external>{t("viewTx")}</ProofLink>
    ) : <span className="ch-mono text-sm break-all">{tx}</span>;

  const triggerAction: Record<Trigger, LifecycleAction> = {
    finalize: { kind: "finalize" }, closeVote: { kind: "closeVote" }, release: { kind: "release" },
  };
  const triggerSigner = anySigner(signers);
  const at = (seconds: string) => new Date(Number(seconds) * 1000).toISOString();

  if (view.stage === "live") return null;

  return (
    <div id="lifecycle" className="ch-donate" aria-live="polite">
      <h2 className="ch-label m-0">{t(`title.${view.stage}`, { payment: view.payment ?? 0 })}</h2>
      <p className="m-0">{t(`body.${view.stage}`, { payment: view.payment ?? 0, released: lc.tranchesReleased })}</p>

      {view.stage === "release-wait" && lc.due.releaseAt && (
        <p className="m-0 text-sm">{t("releaseAt")} <LocalDateTime value={at(lc.due.releaseAt)} /></p>
      )}

      {(view.stage === "voting" || view.stage === "vote-over" || view.stage === "needs-review") && lc.round && lc.tally && (
        <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt>{t("tally.ends")}</dt>
          <dd className="m-0"><LocalDateTime value={at(lc.round.voteEnd)} /></dd>
          <dt>{t("tally.turnout")}</dt>
          <dd className="m-0">
            {lc.snapshot.quorumBps === null
              ? t("tally.percent", { value: bpsPercent(lc.tally.turnoutBps) })
              : t("tally.ofNeeded", { value: bpsPercent(lc.tally.turnoutBps), needed: bpsPercent(lc.snapshot.quorumBps) })}
          </dd>
          <dt>{t("tally.yes")}</dt>
          <dd className="m-0">
            {lc.snapshot.approvalBps === null
              ? t("tally.percent", { value: bpsPercent(lc.tally.yesBps) })
              : t("tally.ofNeeded", { value: bpsPercent(lc.tally.yesBps), needed: bpsPercent(lc.snapshot.approvalBps) })}
          </dd>
        </dl>
      )}

      {view.positions.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label={t("yourPositions")}>
          {view.positions.map((p) => {
            const signer = signerFor(signers, p.address);
            const key = `pos:${p.address}`;
            const disabled = busy !== null;
            return (
              <li key={p.address} className="flex flex-col gap-2">
                <span className="text-sm">
                  {t("position", { address: shortAddress(p.address), amount: usdc(p.donated) })}
                </span>
                {p.kind === "voted" && (
                  <span className="text-sm font-bold">{t(p.approve ? "votedYes" : "votedNo", { amount: usdc(p.amount ?? "0") })}</span>
                )}
                {p.kind === "settled" && <span className="text-sm font-bold">{t("settled")}</span>}
                {(p.kind === "vote" || p.kind === "refund" || p.kind === "pool") && !signer && (
                  <span className="text-sm">{t("connectWallet", { address: shortAddress(p.address) })}</span>
                )}
                {p.kind === "vote" && signer && (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" disabled={disabled} onClick={() => void run(`${key}:yes`, signer, { kind: "vote", approve: true })}>
                      {busy?.key === `${key}:yes` ? t("working") : t("approve", { payment: view.payment ?? 0 })}
                    </Button>
                    <Button variant="secondary" disabled={disabled} onClick={() => void run(`${key}:no`, signer, { kind: "vote", approve: false })}>
                      {busy?.key === `${key}:no` ? t("working") : t("reject")}
                    </Button>
                  </div>
                )}
                {p.kind === "refund" && signer && (
                  <Button variant="primary" disabled={disabled} onClick={() => void run(key, signer, { kind: "claimRefund" })}>
                    {busy?.key === key ? t("working") : t("refund", { amount: usdc(p.amount ?? "0") })}
                  </Button>
                )}
                {p.kind === "pool" && signer && (
                  <Button variant="primary" disabled={disabled}
                    onClick={() => void run(key, signer, { kind: "settleToPool", donor: signer.account })}>
                    {busy?.key === key ? t("working") : t("toPool", { amount: usdc(p.amount ?? "0") })}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {view.triggers.length > 0 && (
        <div className="flex flex-col gap-2">
          {view.triggers.map((tr) =>
            triggerSigner ? (
              <Button key={tr} variant={view.positions.length > 0 ? "secondary" : "primary"} disabled={busy !== null}
                onClick={() => void run(`trigger:${tr}`, triggerSigner, triggerAction[tr])}>
                {busy?.key === `trigger:${tr}` ? t("working") : t(`trigger.${tr}`)}
              </Button>
            ) : null
          )}
          {!triggerSigner && <p className="m-0 text-sm">{t(props.signers.kind === "logged_out" ? "loginToAct" : "walletToAct")}</p>}
          <p className="m-0 text-sm">{t("anyoneCan")}</p>
        </div>
      )}

      {props.signers.kind === "logged_out" && (view.stage === "failed" || view.stage === "rejected" || view.stage === "voting") && (
        <Button variant="secondary" onClick={props.signers.login}>{t("login")}</Button>
      )}

      {message && (
        <div role={message.kind === "error" ? "alert" : "status"} className="flex flex-col gap-1 text-sm">
          <span className="font-bold">{message.text}</span>
          {message.tx && txLink(message.tx)}
        </div>
      )}
    </div>
  );
}
