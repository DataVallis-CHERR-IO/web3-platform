import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { and, eq } from "drizzle-orm";
import { campaignMedia } from "@cherrio/db";
import type { CampaignStory } from "@cherrio/shared";
import { StatusChip } from "@cherrio/ui";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/files/storage";
import { loadOwnCampaign } from "@/lib/campaigns/drafts";
import { CAMPAIGN_CHIP, countryOptions } from "@/lib/campaigns/own";
import { publicMediaUrl } from "@/lib/media/public-store";
import { CampaignForm } from "../CampaignForm";
import { listMedia } from "@/lib/campaigns/media";
import { toMediaView } from "@/lib/campaigns/media-view";
import { CampaignMediaManager } from "./CampaignMediaManager";
import { GoalAmount } from "@/components/Amount";
import { campaignGoal } from "@cherrio/shared";
import { goalWholeUnits } from "@/lib/campaigns/goal";
import { getChainConfig, parseAppEnv } from "@cherrio/shared";
import { LifecyclePanel, type LifecyclePanelProps } from "@/components/campaigns/LifecyclePanel";
import { lifecycleJson, loadLifecycle, nowSeconds } from "@/lib/campaigns/lifecycle";
import { listOwnEvidence } from "@/lib/campaigns/evidence";
import { explorerUrls } from "@/lib/campaigns/public";
import { EvidenceManager, type EvidenceManagerProps } from "./EvidenceManager";

export default async function CampaignPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) redirect(`/${locale}`);
  if (!isUuid(id)) notFound();

  const db = getDb();
  // Not this user's organisation, or no such campaign: the page does not exist.
  const campaign = await loadOwnCampaign(db, session.userId, id).catch(() => notFound());
  const [cover] = await db
    .select({ cid: campaignMedia.cid })
    .from(campaignMedia)
    .where(and(eq(campaignMedia.campaignId, id), eq(campaignMedia.kind, "COVER")))
    .limit(1);
  const coverUrl = cover ? publicMediaUrl(cover.cid) : undefined;
  const media = toMediaView(await listMedia(db, id));
  const story = (campaign.story as CampaignStory).text;
  const goal = campaignGoal(campaign.goalCurrency, campaign.goalAmountMinor);
  const editable = campaign.status === "DRAFT" || campaign.status === "REJECTED";
  const t = await getTranslations("campaigns");

  // Deployed (TASK-033c part 2): the contract's state with the due actions, and milestone evidence.
  let lifecycle: LifecyclePanelProps | null = null;
  let evidence: EvidenceManagerProps | null = null;
  if (campaign.status === "DEPLOYED" && campaign.onchainAddress && campaign.beneficiaryAddress) {
    const lc = await loadLifecycle(db, campaign.onchainAddress);
    const appEnv = parseAppEnv(process.env.APP_ENV ?? "local");
    const chainId = getChainConfig(appEnv).chain.id;
    const explorerTx = explorerUrls()?.tx ?? null;
    if (lc && (lc.state !== "LIVE" || nowSeconds() >= lc.deadline)) {
      lifecycle = { campaign: lc.address as `0x${string}`, chainId, explorerTx, appEnv, initial: lifecycleJson(lc, nowSeconds()) };
    }
    if (lc) {
      evidence = {
        campaignId: campaign.id, campaign: lc.address as `0x${string}`, beneficiary: campaign.beneficiaryAddress as `0x${string}`,
        chainId, appEnv, explorerTx, initial: await listOwnEvidence(db, session.userId, campaign.id),
      };
    }
  }

  return (
    <div className="ch-account-page">
      <div className="flex flex-col gap-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="ch-section-heading uppercase text-[var(--ink)]">
            {editable ? t("editTitle") : campaign.title}
          </h1>
          <StatusChip status={CAMPAIGN_CHIP[campaign.status]!}>{t(`status.${campaign.status}`)}</StatusChip>
        </div>

        {campaign.status === "REJECTED" && campaign.reviewNote && (
          <div className="p-4 border-2 border-[var(--ink)] bg-[var(--surface)] flex flex-col gap-1">
            <span className="ch-label">{t("reviewNote")}</span>
            <p className="text-sm text-[var(--ink)] whitespace-pre-line">{campaign.reviewNote}</p>
          </div>
        )}

        {editable ? (
          <CampaignForm
            campaignId={campaign.id}
            organizations={[]}
            countries={countryOptions(locale)}
            coverUrl={coverUrl}
            initial={{
              organizationId: campaign.orgId ?? "",
              title: campaign.title,
              story,
              cause: campaign.cause,
              country: campaign.country,
              goalCurrency: goal.currency,
              goal: goalWholeUnits(goal),
              durationDays: String(campaign.durationDays),
            }}
          />
        ) : (
          <div className="ch-panel p-6 md:p-8 flex flex-col gap-4">
            <p className="text-sm font-bold text-[var(--ink)]">
              {t(`statusNote.${campaign.status as "PENDING_REVIEW" | "APPROVED" | "DEPLOYED"}`)}
            </p>
            {coverUrl && (
              // A plain <img>: the file is served by the public media bucket, not by Next.
              <img src={coverUrl} alt={t("coverAlt")} className="w-full max-w-xl border-2 border-[var(--ink)]" />
            )}
            <p className="text-base text-[var(--ink)]">
              {t("target")}: <GoalAmount goal={goal} /> · {t("duration", { days: campaign.durationDays })}
            </p>
            {/* Plain text: React escapes it; paragraphs are kept by white-space. */}
            <p className="text-base text-[var(--ink)] whitespace-pre-line">{story}</p>
          </div>
        )}

        {lifecycle && <LifecyclePanel {...lifecycle} />}
        {evidence && <EvidenceManager {...evidence} />}

        <CampaignMediaManager campaignId={campaign.id} media={media} />
      </div>
    </div>
  );
}
