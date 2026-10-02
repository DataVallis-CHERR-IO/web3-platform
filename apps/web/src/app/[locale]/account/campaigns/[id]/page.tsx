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
  const story = (campaign.story as CampaignStory).text;
  const targetEur = (BigInt(campaign.targetEurCents) / 100n).toString();
  const editable = campaign.status === "DRAFT" || campaign.status === "REJECTED";
  const t = await getTranslations("campaigns");

  return (
    <div className="ch-container py-12">
      <div className="max-w-3xl mx-auto flex flex-col gap-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl md:text-4xl font-display uppercase tracking-tight text-[var(--ink)]">
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
              targetEur,
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
              {t("target", { amount: targetEur })} · {t("duration", { days: campaign.durationDays })}
            </p>
            {/* Plain text: React escapes it; paragraphs are kept by white-space. */}
            <p className="text-base text-[var(--ink)] whitespace-pre-line">{story}</p>
          </div>
        )}
      </div>
    </div>
  );
}
