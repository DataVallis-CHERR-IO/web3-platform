"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { useWallets } from "@privy-io/react-auth";
import { getAddress, type Address, type EIP1193Provider, type Hash } from "viem";
import { Button } from "@cherrio/ui";
import { useRouter } from "@/i18n/routing";
import { useAppAuth } from "@/components/auth/PrivyClientProvider";
import {
  isOperator, publishCampaign, PublishCheckError, waitForPublish, type PreparedPublishCall,
} from "@/lib/campaigns/publish-client";

interface Props {
  campaignId: string;
  /** Hash of an earlier createCampaign transaction, if one was sent. */
  publishTxHash: string | null;
  explorerUrl?: string;
}

type Step = "idle" | "preparing" | "checking" | "signing" | "mining" | "linking";

async function post<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; code: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    return res.ok ? { ok: true, data: json } : { ok: false, code: json.error ?? `http_${res.status}` };
  } catch {
    return { ok: false, code: "network" };
  }
}

/**
 * Publish an APPROVED campaign on Polygon (ADR-035): prepare on the server,
 * sign CampaignFactory.createCampaign with the operator wallet, report the hash,
 * then link through the indexer. "Check status" links without signing.
 */
export function PublishPanel(props: Props) {
  const { isAvailable } = useAppAuth();
  return isAvailable ? <PublishWithWallet {...props} /> : <PublishUnavailable {...props} />;
}

function StatusLine({ publishTxHash, explorerUrl }: Props) {
  const t = useTranslations("admin.campaigns.publish");
  if (!publishTxHash) return null;
  return (
    <p className="text-sm text-[var(--ink)] break-all">
      {t("sentTx")}:{" "}
      {explorerUrl ? (
        <a href={`${explorerUrl}/tx/${publishTxHash}`} target="_blank" rel="noreferrer" className="ch-mono underline">
          {publishTxHash}
        </a>
      ) : (
        <span className="ch-mono">{publishTxHash}</span>
      )}
    </p>
  );
}

function useCheckStatus(campaignId: string) {
  const t = useTranslations("admin.campaigns.publish");
  const router = useRouter();
  const [message, setMessage] = React.useState<string | null>(null);
  const check = React.useCallback(async () => {
    const result = await post<{ status: string; onChain?: string }>(`/api/admin/campaigns/${campaignId}/publish/check`, {});
    if (!result.ok) {
      setMessage(t("failed"));
      return false;
    }
    if (result.data.status === "DEPLOYED") {
      setMessage(null);
      router.refresh();
      return true;
    }
    setMessage(t(`onChain.${(result.data.onChain ?? "not_found") as "not_found"}`));
    return false;
  }, [campaignId, router, t]);
  return { check, message, setMessage };
}

function PublishUnavailable(props: Props) {
  const t = useTranslations("admin.campaigns.publish");
  const { check, message } = useCheckStatus(props.campaignId);
  return (
    <div className="flex flex-col gap-3 max-w-2xl">
      <p className="text-sm font-bold text-[var(--ink)]">{t("walletUnavailable")}</p>
      <StatusLine {...props} />
      <div>
        <Button variant="ghost" onClick={() => void check()}>
          {t("check")}
        </Button>
      </div>
      {message && <p role="status" className="text-sm text-[var(--ink)]">{message}</p>}
    </div>
  );
}

function PublishWithWallet(props: Props) {
  const { campaignId, publishTxHash } = props;
  const t = useTranslations("admin.campaigns.publish");
  const { wallets, ready } = useWallets();
  const { check, message, setMessage } = useCheckStatus(campaignId);
  const [step, setStep] = React.useState<Step>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const external = wallets.filter((wallet) => wallet.walletClientType !== "privy");

  async function publish() {
    setError(null);
    setMessage(null);
    try {
      setStep("preparing");
      const prepared = await post<PreparedPublishCall>(`/api/admin/campaigns/${campaignId}/publish/prepare`, {});
      if (!prepared.ok) {
        setError(t.has(`errors.${prepared.code}` as never) ? t(`errors.${prepared.code}` as never) : t("failed"));
        return;
      }
      const call = prepared.data;

      // The first connected external wallet that holds OPERATOR_ROLE on this chain.
      setStep("checking");
      let chosen: { provider: EIP1193Provider; account: Address } | null = null;
      for (const wallet of external) {
        await wallet.switchChain(call.chainId).catch(() => undefined);
        const provider = (await wallet.getEthereumProvider()) as EIP1193Provider;
        const account = getAddress(wallet.address);
        if (await isOperator(provider, account, call.platformConfig).catch(() => false)) {
          chosen = { provider, account };
          break;
        }
      }
      if (!chosen) {
        setError(t("errors.not_operator"));
        return;
      }

      setStep("signing");
      const outcome = await publishCampaign(chosen.provider, chosen.account, call, (publishTxHash as Hash | null) ?? null);
      if (outcome.kind === "sent") {
        const sent = await post(`/api/admin/campaigns/${campaignId}/publish/sent`, { txHash: outcome.txHash });
        if (!sent.ok) setError(t("errors.record_failed", { txHash: outcome.txHash }));
        setStep("mining");
        if (!(await waitForPublish(chosen.provider, outcome.txHash))) {
          setError(t("errors.reverted"));
          return;
        }
      }

      // The indexer needs a few blocks; try for about a minute.
      setStep("linking");
      for (let attempt = 0; attempt < 12; attempt++) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    } catch (e) {
      if (e instanceof PublishCheckError) setError(t(`errors.${e.code}`));
      else if ((e as { code?: number })?.code === 4001) setError(t("errors.rejected_by_user"));
      else {
        console.error("[publish]", e);
        setError(t("failed"));
      }
    } finally {
      setStep("idle");
    }
  }

  const working = step !== "idle";
  return (
    <div className="flex flex-col gap-3 max-w-2xl">
      <p className="text-sm text-[var(--ink)]">{t("intro")}</p>
      <StatusLine {...props} />
      {ready && external.length === 0 && <p className="text-sm font-bold text-[var(--ink)]">{t("noWallet")}</p>}
      <div className="flex flex-wrap gap-3">
        <Button variant="primary" disabled={working || !ready || external.length === 0} onClick={() => void publish()}>
          {working ? t(`steps.${step as Exclude<Step, "idle">}`) : publishTxHash ? t("publishAgain") : t("publish")}
        </Button>
        <Button variant="ghost" disabled={working} onClick={() => void check()}>
          {t("check")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="p-3 border-2 border-[var(--ink)] bg-[var(--surface)] text-sm font-bold text-[var(--ink)] break-all">
          {error}
        </p>
      )}
      {message && <p role="status" className="text-sm text-[var(--ink)]">{message}</p>}
    </div>
  );
}
