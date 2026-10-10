"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import type { Address, Hash } from "viem";
import { Button, ProofLink } from "@cherrio/ui";
import { formatUsdc } from "@cherrio/shared/money";
import { WithDonorWallet, type WalletState } from "@/components/wallet/DonorWallet";
import { waitForTx } from "@/lib/campaigns/donate-client";
import { sendPoolVote, toPoolVoteFailure, type PoolVoteAction, type PoolVoteFailure } from "@/lib/pool/vote-client";

// Vote on an Emergency Pool allocation, or count it after the end (TASK-014c-2).
// "open": the visitor's wallet weight is looked up first (contributions to the
// pool before the proposal), then Yes / No. "counting": anyone may send
// closeAllocation. Results show on the page after the indexer's next cycle.

export interface AllocationVoteProps {
  pool: Address;
  allocationId: string;
  phase: "open" | "counting";
  chainId: number;
  explorerTx: string | null;
  appEnv: string;
}

export function AllocationVote(props: AllocationVoteProps) {
  return (
    <WithDonorWallet chainId={props.chainId} appEnv={props.appEnv}>
      {(wallet) => <VoteUi {...props} wallet={wallet} />}
    </WithDonorWallet>
  );
}

type Status =
  | { kind: "idle" }
  | { kind: "busy"; step: "signing" | "mining"; tx?: Hash }
  | { kind: "done"; action: PoolVoteAction; tx: Hash }
  | { kind: "error"; code: PoolVoteFailure | "reverted"; tx?: Hash };

function VoteUi(props: AllocationVoteProps & { wallet: WalletState }) {
  const t = useTranslations("emergencyPool.vote");
  const [voter, setVoter] = React.useState<{ weight: bigint; voted: boolean } | null | "loading">("loading");
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });
  const account = props.wallet.kind === "ready" ? props.wallet.wallet.account : null;

  React.useEffect(() => {
    if (props.phase !== "open" || !account) return;
    let cancelled = false;
    setVoter("loading");
    fetch(`/api/pool/allocations/${props.allocationId}/voter?address=${account}`, { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as { weight: string; voted: boolean }) : (await r.text(), null)))
      .then((j) => { if (!cancelled) setVoter(j ? { weight: BigInt(j.weight), voted: j.voted } : null); })
      .catch(() => { if (!cancelled) setVoter(null); });
    return () => { cancelled = true; };
  }, [props.phase, props.allocationId, account]);

  async function act(action: PoolVoteAction) {
    if (props.wallet.kind === "logged_out") return props.wallet.login();
    if (props.wallet.kind !== "ready") return;
    let tx: Hash | undefined;
    try {
      setStatus({ kind: "busy", step: "signing" });
      const { account: from, sendCalls } = props.wallet.wallet;
      const provider = await props.wallet.wallet.provider(props.chainId);
      tx = await sendPoolVote(provider, from, { chainId: props.chainId, pool: props.pool, allocationId: BigInt(props.allocationId), action }, sendCalls);
      setStatus({ kind: "busy", step: "mining", tx });
      const ok = await waitForTx(provider, tx);
      setStatus(ok ? { kind: "done", action, tx } : { kind: "error", code: "reverted", tx });
    } catch (e) {
      setStatus({ kind: "error", code: toPoolVoteFailure(e), tx });
    }
  }

  const txLink = (tx: Hash) =>
    props.explorerTx ? <ProofLink href={`${props.explorerTx}${tx}`} external>{t("proof")}</ProofLink> : <span className="ch-mono text-sm break-all">{tx}</span>;
  const busy = status.kind === "busy";

  let body: React.ReactNode;
  if (status.kind === "done") {
    body = (
      <p className="m-0 font-bold" role="status">
        {status.action.kind === "count" ? t("counted") : status.action.approve ? t("votedYes") : t("votedNo")}
      </p>
    );
  } else if (props.wallet.kind === "unavailable" || props.wallet.kind === "preparing") {
    body = <p className="m-0 text-sm" role="status">{t(props.wallet.kind)}</p>;
  } else if (props.wallet.kind === "logged_out") {
    body = <Button variant="secondary" onClick={() => props.wallet.kind === "logged_out" && props.wallet.login()}>{t(props.phase === "open" ? "loginToVote" : "loginToCount")}</Button>;
  } else if (props.wallet.kind === "no_wallet") {
    body = <p className="m-0 text-sm">{t("noWallet")}</p>;
  } else if (props.phase === "counting") {
    body = (
      <>
        <p className="m-0 text-sm">{t("countIntro")}</p>
        <div><Button variant="secondary" disabled={busy} onClick={() => void act({ kind: "count" })}>{t("count")}</Button></div>
      </>
    );
  } else if (voter === "loading") {
    body = <p className="m-0 text-sm" role="status">{t("checking")}</p>;
  } else if (voter === null) {
    body = <p className="m-0 text-sm">{t("notIndexedYet")}</p>;
  } else if (voter.voted) {
    body = <p className="m-0 text-sm font-bold">{t("alreadyVoted")}</p>;
  } else if (voter.weight === 0n) {
    body = <p className="m-0 text-sm">{t("noWeight")}</p>;
  } else {
    body = (
      <>
        <p className="m-0 text-sm">{t("yourWeight", { amount: formatUsdc(voter.weight, { minDecimals: 2, maxDecimals: 6 }) })}</p>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" disabled={busy} onClick={() => void act({ kind: "vote", approve: true })}>{t("yes")}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => void act({ kind: "vote", approve: false })}>{t("no")}</Button>
        </div>
      </>
    );
  }

  return (
    <div className="ch-pool-give flex flex-col gap-2" aria-label={t(props.phase === "open" ? "titleVote" : "titleCount")} role="group">
      {body}
      {status.kind === "busy" && <p className="m-0 text-sm font-bold" role="status" aria-live="polite">{t(`step.${status.step}`)}</p>}
      {(status.kind === "busy" || status.kind === "done" || status.kind === "error") && status.tx && txLink(status.tx)}
      {status.kind === "done" && <p className="m-0 text-sm">{t("afterUpdate")}</p>}
      {status.kind === "error" && <p className="ch-notice m-0" role="alert">{t(`errors.${status.code}`)}</p>}
    </div>
  );
}
