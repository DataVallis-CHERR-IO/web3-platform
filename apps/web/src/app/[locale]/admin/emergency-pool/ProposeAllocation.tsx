"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import type { Address, Hash, Hex } from "viem";
import { Button, Field } from "@cherrio/ui";
import { formatUsdc } from "@cherrio/shared/money";
import { useRouter } from "@/i18n/routing";
import { LabeledSelect } from "@/components/LabeledSelect";
import { AdminWalletGate, type AdminWallets } from "@/components/admin/AdminWallets";
import { waitForConsoleTx, type ConsoleChain } from "@/lib/contracts/console-client";
import { parseUsdcInput } from "@/lib/campaigns/donate";
import { sendProposeAllocation, toProposeFailure, type ProposeFailure } from "@/lib/pool/allocation-client";
import { useOperator } from "./useOperator";

// Admin → Emergency Pool → "Propose an allocation" (TASK-014c): sub-pool, live
// campaign, amount and a public reason. The reason is saved first (its SHA-256 is
// the on-chain reasonHash), then the Operator's wallet signs proposeAllocation
// after a simulation; the vote opens on the public Emergency Pool page.

export interface ProposeAllocationProps {
  appEnv: string;
  chainId: number;
  pool: Address;
  roles: ConsoleChain | null;
  explorerUrl: string | null;
  /** Sub-pools on chain with their available balance (USDC units, decimal string). */
  pools: { poolId: number; name: string; balance: string }[];
  campaigns: { id: string; title: string; address: string }[];
}

const REASON_MAX = 1000;

export function ProposeAllocation(props: ProposeAllocationProps) {
  const t = useTranslations("admin.guardian.panel");
  return (
    <AdminWalletGate appEnv={props.appEnv} loading={<p role="status" className="text-[var(--ink)]">{t("loading")}</p>}>
      {(w) => <ProposeUi {...props} {...w} />}
    </AdminWalletGate>
  );
}

function ProposeUi(props: ProposeAllocationProps & AdminWallets) {
  const t = useTranslations("admin.pool.propose");
  const tPanel = useTranslations("admin.guardian.panel");
  const tErr = useTranslations("campaignPage.lifecycle.errors");
  const router = useRouter();
  const { reader, operator, wallet, rolesFailed } = useOperator(props);
  const [poolId, setPoolId] = React.useState(String(props.pools[0]?.poolId ?? ""));
  const [campaignId, setCampaignId] = React.useState(props.campaigns[0]?.id ?? "");
  const [amountText, setAmountText] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{ kind: "error" | "ok"; text: string; tx?: Hash } | null>(null);

  const pool = props.pools.find((p) => String(p.poolId) === poolId) ?? null;
  const campaign = props.campaigns.find((c) => c.id === campaignId) ?? null;
  const amount = parseUsdcInput(amountText);
  const amountError = !touched ? undefined
    : amount === null || amount === 0n ? t("errorAmount")
    : pool && amount > BigInt(pool.balance) ? t("errorBalance", { balance: formatUsdc(BigInt(pool.balance), { minDecimals: 2, maxDecimals: 6 }) })
    : undefined;
  const reasonError = touched && (reason.trim().length === 0 || reason.trim().length > REASON_MAX) ? t("errorReason", { max: REASON_MAX }) : undefined;
  const valid = !!pool && !!campaign && amount !== null && amount > 0n && amount <= BigInt(pool.balance) && reason.trim().length > 0 && reason.trim().length <= REASON_MAX;

  const failureText = (f: ProposeFailure) =>
    (["pool_missing", "campaign_not_live", "not_factory_campaign", "insufficient_pool_balance", "deadline_too_soon", "pool_mismatch", "amount_zero"] as string[]).includes(f)
      ? t(`errors.${f}`)
      : tErr(f as Parameters<typeof tErr>[0]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!valid || !wallet || !reader || !pool || !campaign || amount === null) return;
    setMessage(null);
    setBusy(true);
    try {
      const saved = await fetch("/api/admin/emergency-pool/allocations/reason", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolId: pool.poolId, campaignId: campaign.id, amountUsdc: amount.toString(), reason }),
      });
      if (!saved.ok) {
        setMessage({ kind: "error", text: t("saveFailed") });
        return;
      }
      const { reasonHash, campaign: address } = (await saved.json()) as { reasonHash: Hex; campaign: Address };
      let hash: Hash;
      try {
        hash = await sendProposeAllocation(
          await wallet.provider(props.chainId), wallet.account,
          { chainId: props.chainId, pool: props.pool, poolId: pool.poolId, campaign: address, amount, reasonHash },
          { reader }
        );
      } catch (e) {
        console.error("[pool] propose", e);
        setMessage({ kind: "error", text: failureText(toProposeFailure(e)) });
        return;
      }
      await fetch("/api/admin/emergency-pool/allocations/sent", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reasonHash, txHash: hash }),
      }).then((r) => r.text()).catch((e: unknown) => console.error("[pool] sent", e));
      const outcome = await waitForConsoleTx(reader, hash);
      setMessage(
        outcome === "success" ? { kind: "ok", text: t("sent"), tx: hash }
          : outcome === "reverted" ? { kind: "error", text: t("reverted"), tx: hash }
          : { kind: "ok", text: t("unknown"), tx: hash }
      );
      if (outcome === "success") {
        setReason("");
        setAmountText("");
        setTouched(false);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const txLink = (tx: Hash) =>
    props.explorerUrl ? (
      <a href={`${props.explorerUrl}/tx/${tx}`} target="_blank" rel="noreferrer" className="ch-mono underline break-all">{tx}</a>
    ) : <span className="ch-mono break-all">{tx}</span>;

  return (
    <section className="ch-panel p-5 flex flex-col gap-4" aria-labelledby="allocation-propose">
      <h2 id="allocation-propose" className="text-lg font-display uppercase text-[var(--ink)]">{t("title")}</h2>
      <p className="text-sm text-[var(--ink)] max-w-3xl">{t("intro")}</p>
      {props.campaigns.length === 0 ? (
        <p className="text-sm font-bold text-[var(--ink)]">{t("noCampaigns")}</p>
      ) : props.pools.length === 0 ? (
        <p className="text-sm font-bold text-[var(--ink)]">{t("noPools")}</p>
      ) : (
        <form className="grid gap-4 md:grid-cols-2 items-start" onSubmit={(e) => void submit(e)} noValidate>
          <LabeledSelect
            label={t("pool")}
            placeholder={t("pool")}
            value={poolId}
            onChange={setPoolId}
            options={props.pools.map((p) => ({ value: String(p.poolId), label: `${p.name} — ${formatUsdc(BigInt(p.balance), { minDecimals: 2, maxDecimals: 2 })} USDC` }))}
            disabled={busy}
          />
          <LabeledSelect
            label={t("campaign")}
            placeholder={t("campaign")}
            value={campaignId}
            onChange={setCampaignId}
            options={props.campaigns.map((c) => ({ value: c.id, label: c.title }))}
            disabled={busy}
          />
          <Field
            id="allocation-amount"
            label={t("amount")}
            suffix="USDC"
            mono
            inputMode="decimal"
            autoComplete="off"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            onBlur={() => setTouched(true)}
            error={amountError}
            disabled={busy}
          />
          <div className={`ch-field md:col-span-2${reasonError ? " ch-field-error" : ""}`}>
            <label htmlFor="allocation-reason" className="ch-label">{t("reason")}</label>
            <div className="ch-field-row">
              <textarea
                id="allocation-reason"
                className="ch-input ch-textarea"
                value={reason}
                maxLength={REASON_MAX + 200}
                onChange={(e) => setReason(e.target.value)}
                onBlur={() => setTouched(true)}
                aria-invalid={reasonError ? true : undefined}
                aria-describedby="allocation-reason-hint"
                disabled={busy}
              />
            </div>
            <span id="allocation-reason-hint" className="ch-field-hint">
              {reasonError ?? t("reasonHint", { count: reason.trim().length, max: REASON_MAX })}
            </span>
          </div>
          <div className="md:col-span-2 flex flex-col gap-2">
            {!props.walletsReady ? null : props.wallets.length === 0 ? (
              <p className="text-sm font-bold text-[var(--ink)]">{t("noWallet")}</p>
            ) : rolesFailed ? (
              <p role="alert" className="text-sm font-bold text-[var(--ink)]">{tPanel("readFailed")}</p>
            ) : operator === null ? (
              <p className="text-sm font-bold text-[var(--ink)]">{t("needsOperator")}</p>
            ) : null}
            <div>
              <Button type="submit" disabled={busy || !wallet || !reader}>{t("submit")}</Button>
            </div>
            {busy && <p role="status" className="text-sm text-[var(--ink)]">{tPanel("working")}</p>}
            {message && (
              <div role={message.kind === "error" ? "alert" : "status"} className="text-sm font-bold text-[var(--ink)] flex flex-col gap-1">
                <span>{message.text}</span>
                {message.tx && txLink(message.tx)}
              </div>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
