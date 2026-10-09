"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import type { Address, Hash } from "viem";
import { Button, Field, ProofLink } from "@cherrio/ui";
import { formatUsdc } from "@cherrio/shared/money";
import { CIRCLE_FAUCET, WithDonorWallet, type WalletState } from "@/components/wallet/DonorWallet";
import { MIN_DONATION_USDC, parseUsdcInput } from "@/lib/campaigns/donate";
import { toDonateFailure, waitForTx, type DonateFailure } from "@/lib/campaigns/donate-client";
import { giveToPool, type GiveStep } from "@/lib/pool/give-client";

// "Give to this pool" on a sub-pool card (TASK-014b): an amount in USDC from the
// giver's wallet to EmergencyPool.donate(poolId, amount). Folded by default so
// the cards stay short; the gift shows on the page after the indexer's next cycle.

export interface GivePanelProps {
  pool: Address;
  poolId: number;
  poolName: string;
  chainId: number;
  networkName: string;
  testnet: boolean;
  /** e.g. https://amoy.polygonscan.com/tx/ — null on a local chain. */
  explorerTx: string | null;
  appEnv: string;
}

type Phase =
  | { kind: "form" }
  | { kind: "busy"; step: GiveStep | "mining"; tx?: Hash }
  | { kind: "done"; tx: Hash }
  | { kind: "error"; code: DonateFailure; tx?: Hash };

export function GivePanel(props: GivePanelProps) {
  return (
    <WithDonorWallet chainId={props.chainId} appEnv={props.appEnv}>
      {(wallet) => <GiveUi {...props} wallet={wallet} />}
    </WithDonorWallet>
  );
}

function GiveUi(props: GivePanelProps & { wallet: WalletState }) {
  const t = useTranslations("emergencyPool.give");
  const [input, setInput] = React.useState("10");
  const [touched, setTouched] = React.useState(false);
  const [phase, setPhase] = React.useState<Phase>({ kind: "form" });
  const amount = parseUsdcInput(input);
  const valid = amount !== null && amount >= MIN_DONATION_USDC;
  const fieldError = touched && !valid ? (amount === null ? t("errorInvalid") : t("errorMinimum")) : undefined;
  const busy = phase.kind === "busy";
  const sponsored = props.wallet.kind === "ready" && !!props.wallet.wallet.sendCalls;
  const id = `give-${props.poolId}`;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (props.wallet.kind === "logged_out") return props.wallet.login();
    if (props.wallet.kind !== "ready" || !valid) return;
    let tx: Hash | undefined;
    try {
      setPhase({ kind: "busy", step: "checking" });
      const { account, sendCalls } = props.wallet.wallet;
      const provider = await props.wallet.wallet.provider(props.chainId);
      tx = await giveToPool(
        provider, account,
        { chainId: props.chainId, pool: props.pool, poolId: props.poolId, amount: amount! },
        (step, detail) => setPhase({ kind: "busy", step, tx: detail?.approveTx }),
        sendCalls
      );
      setPhase({ kind: "busy", step: "mining", tx });
      const ok = await waitForTx(provider, tx);
      setPhase(ok ? { kind: "done", tx } : { kind: "error", code: "reverted", tx });
    } catch (e) {
      setPhase({ kind: "error", code: toDonateFailure(e), tx });
    }
  }

  const txLink = (tx: Hash, label: string) =>
    props.explorerTx ? (
      <ProofLink href={`${props.explorerTx}${tx}`} external>{label}</ProofLink>
    ) : (
      <span className="ch-mono text-sm break-all">{tx}</span>
    );

  const errorCode = phase.kind === "error"
    ? phase.code === "insufficient_usdc" && props.testnet ? "insufficient_usdc_testnet" : phase.code
    : null;

  return (
    <details className="ch-donate-details ch-pool-give">
      <summary>{t("open")}</summary>
      {phase.kind === "done" ? (
        <div className="flex flex-col gap-2">
          <p className="m-0 font-bold" role="status">{t("success", { amount: formatUsdc(amount ?? 0n, { minDecimals: 2, maxDecimals: 6 }), pool: props.poolName })}</p>
          <p className="m-0 text-sm">{t("successNote")}</p>
          {txLink(phase.tx, t("proof"))}
          <Button variant="secondary" onClick={() => setPhase({ kind: "form" })}>{t("again")}</Button>
        </div>
      ) : props.wallet.kind === "unavailable" || props.wallet.kind === "preparing" ? (
        <p className="m-0 text-sm" role="status">{t(props.wallet.kind)}</p>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
          <p className="m-0 text-sm">{t("intro")}</p>
          <Field
            id={id}
            label={t("amountLabel")}
            suffix="USDC"
            mono
            inputMode="decimal"
            autoComplete="off"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onBlur={() => setTouched(true)}
            hint={fieldError ? undefined : t("amountHint")}
            error={fieldError}
            disabled={busy}
          />
          <p className="m-0 text-sm">{t(sponsored ? "gasNoteSponsored" : "gasNote")}</p>
          {props.wallet.kind === "no_wallet" && <p className="ch-notice m-0">{t("noWallet")}</p>}
          <Button
            type="submit"
            variant="primary"
            block
            disabled={busy || props.wallet.kind === "no_wallet" || (props.wallet.kind === "ready" && !valid)}
          >
            {props.wallet.kind === "logged_out" ? t("buttonLogin") : t("button", { pool: props.poolName })}
          </Button>
          {phase.kind === "busy" && (
            <p className="m-0 text-sm font-bold" role="status" aria-live="polite">
              {t(sponsored && phase.step === "donating" ? "step.single" : `step.${phase.step}`)}
            </p>
          )}
          {phase.kind === "busy" && phase.tx && txLink(phase.tx, t("pendingProof"))}
          {errorCode && (
            <div className="ch-notice" role="alert">
              <p className="m-0 break-words">{t(`errors.${errorCode}`, { network: props.networkName })}</p>
              {errorCode === "insufficient_usdc_testnet" && (
                <a className="ch-proof" href={CIRCLE_FAUCET} target="_blank" rel="noopener noreferrer">
                  {t("faucet")}<span aria-hidden="true"> ↗</span>
                </a>
              )}
            </div>
          )}
          {phase.kind === "error" && phase.tx && txLink(phase.tx, t("pendingProof"))}
        </form>
      )}
    </details>
  );
}
