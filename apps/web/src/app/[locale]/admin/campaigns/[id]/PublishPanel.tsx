"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { useWallets } from "@privy-io/react-auth";
import { Button } from "@cherrio/ui";
import { useRouter } from "@/i18n/routing";
import { useAppAuth } from "@/components/auth/PrivyClientProvider";
import { postJson as post, publishFlow, type PublishStep } from "@/lib/campaigns/publish-flow";

interface Props {
  campaignId: string;
  /** Hash of an earlier createCampaign transaction, if one was sent. */
  publishTxHash: string | null;
  explorerUrl?: string;
}

type Step = "idle" | PublishStep;

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
      const result = await publishFlow(campaignId, { wallets: external, publishTxHash, onStep: setStep });
      switch (result.kind) {
        case "deployed":
        case "not_linked_yet":
          await check(); // refreshes the page once linked, else says what the indexer sees
          return;
        case "prepare_failed":
          setError(t.has(`errors.${result.code}` as never) ? t(`errors.${result.code}` as never) : t("failed"));
          return;
        case "no_operator_wallet":
          setError(t("errors.no_operator_wallet", { addresses: result.checked.join(", ") || "—" }));
          return;
        case "check_failed":
          setError(t(`errors.${result.code}`));
          return;
        case "record_failed":
          setError(t("errors.record_failed", { txHash: result.txHash }));
          await check();
          return;
        case "reverted":
          setError(t("errors.reverted"));
          return;
        case "rejected_by_user":
          setError(t("errors.rejected_by_user"));
          return;
        default:
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
