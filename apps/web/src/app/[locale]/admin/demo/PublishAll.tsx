"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useWallets } from "@privy-io/react-auth";
import { Button } from "@cherrio/ui";
import { useAppAuth } from "@/components/auth/PrivyClientProvider";
import { publishFlow, type OperatorWallet, type PublishStep, type WalletLike } from "@/lib/campaigns/publish-flow";

export interface WaitingCampaign {
  id: string;
  title: string;
  publishTxHash: string | null;
}

export type BatchOutcome = "deployed" | "not_linked_yet" | "failed";
export interface BatchSummary {
  deployed: number;
  notLinked: number;
  failed: string[];
  stopped: "rejected_by_user" | "no_operator_wallet" | null;
}

/**
 * Publishes campaigns one after another with one operator wallet (TASK-038c).
 * The wallet is found once; the admin confirms one transaction per campaign.
 * A rejected signature or a missing operator wallet stops the batch; any other
 * failure is noted and the next campaign follows.
 */
export async function publishBatch(
  campaigns: WaitingCampaign[],
  wallets: WalletLike[],
  onProgress: (index: number, step: PublishStep) => void,
  flow: typeof publishFlow = publishFlow
): Promise<BatchSummary> {
  let operator: OperatorWallet | null = null;
  const summary: BatchSummary = { deployed: 0, notLinked: 0, failed: [], stopped: null };
  for (const [index, campaign] of campaigns.entries()) {
    const result = await flow(campaign.id, {
      wallets,
      operator,
      publishTxHash: campaign.publishTxHash,
      onStep: (step) => onProgress(index, step),
      onOperator: (found) => {
        operator = found;
      },
    });
    if (result.kind === "deployed") summary.deployed++;
    else if (result.kind === "not_linked_yet" || result.kind === "record_failed") summary.notLinked++;
    else if (result.kind === "rejected_by_user" || result.kind === "no_operator_wallet") {
      summary.stopped = result.kind;
      break;
    } else summary.failed.push(campaign.title);
  }
  return summary;
}

export function PublishAll({ campaigns }: { campaigns: WaitingCampaign[] }) {
  const { isAvailable } = useAppAuth();
  const t = useTranslations("admin.demo.publishAll");
  if (campaigns.length === 0) return null;
  if (!isAvailable) return <p className="text-sm font-bold text-[var(--ink)]">{t("walletUnavailable")}</p>;
  return <PublishAllWithWallet campaigns={campaigns} />;
}

function PublishAllWithWallet({ campaigns }: { campaigns: WaitingCampaign[] }) {
  const t = useTranslations("admin.demo.publishAll");
  const tSteps = useTranslations("admin.campaigns.publish.steps");
  const router = useRouter();
  const { wallets, ready } = useWallets();
  const external = wallets.filter((wallet) => wallet.walletClientType !== "privy");
  const [progress, setProgress] = React.useState<{ index: number; step: PublishStep } | null>(null);
  const [summary, setSummary] = React.useState<string | null>(null);

  async function run() {
    setSummary(null);
    try {
      const result = await publishBatch(campaigns, external, (index, step) => setProgress({ index, step }));
      const parts = [t("deployed", { count: result.deployed })];
      if (result.notLinked > 0) parts.push(t("notLinked", { count: result.notLinked }));
      if (result.failed.length > 0) parts.push(t("failed", { count: result.failed.length, titles: result.failed.join(", ") }));
      if (result.stopped) parts.push(t(`stopped.${result.stopped}`));
      setSummary(parts.join(" "));
    } finally {
      setProgress(null);
      router.refresh();
    }
  }

  return (
    <div className="ch-panel p-5 flex flex-col gap-3 max-w-2xl">
      <p className="text-[var(--ink)]">{t("intro", { count: campaigns.length })}</p>
      {ready && external.length === 0 && <p className="text-sm font-bold text-[var(--ink)]">{t("noWallet")}</p>}
      <div>
        <Button variant="primary" disabled={progress !== null || !ready || external.length === 0} onClick={() => void run()}>
          {progress ? t("working") : t("button", { count: campaigns.length })}
        </Button>
      </div>
      {progress && (
        <p role="status" className="text-sm text-[var(--ink)]">
          {t("progress", { current: progress.index + 1, total: campaigns.length, title: campaigns[progress.index]!.title })}{" "}
          {tSteps(progress.step)}
        </p>
      )}
      {summary && (
        <p role="status" className="text-sm font-bold text-[var(--ink)]">
          {summary}
        </p>
      )}
    </div>
  );
}
