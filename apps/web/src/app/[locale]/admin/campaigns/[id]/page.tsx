import type * as React from "react";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { and, eq } from "drizzle-orm";
import { campaignMedia, campaigns, organizations, users } from "@cherrio/db";
import { checksumAddress, getChainConfig, parseAppEnv, type CampaignStory } from "@cherrio/shared";
import { StatusChip } from "@cherrio/ui";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { SanctionedCountryNotice } from "@/components/admin/SanctionedCountryNotice";
import { isUuid } from "@/lib/files/storage";
import { CAMPAIGN_CHIP } from "@/lib/campaigns/own";
import { publicMediaUrl } from "@/lib/media/public-store";
import { Link } from "@/i18n/routing";
import { linkDeployedCampaign, publishDeployment } from "@/lib/campaigns/publish";
import { CampaignReviewRefusedError } from "@/lib/campaigns/review";
import { CampaignReviewActions } from "./ReviewActions";
import { MediaTakedown } from "./MediaTakedown";
import { listMedia } from "@/lib/campaigns/media";
import { toMediaView } from "@/lib/campaigns/media-view";
import { PublishPanel } from "./PublishPanel";
import { ChainActions } from "./ChainActions";
import { LocalDateTime } from "@/components/LocalDateTime";
import { RatingList } from "@/components/ratings/RatingList";
import { listRatings } from "@/lib/ratings";
import { GoalAmount, UsdcAmount } from "@/components/Amount";
import { campaignGoal } from "@cherrio/shared";

const heading = "text-xl font-display uppercase text-[var(--ink)]";

/** One campaign for review — PLATFORM_ADMIN only; 404 for everyone else. */
export default async function AdminCampaignPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  let adminId: string;
  try {
    adminId = (await requireRole("PLATFORM_ADMIN")).userId;
  } catch {
    notFound();
  }
  if (!isUuid(id)) notFound();

  const db = getDb();
  const deployment = publishDeployment();
  // An approved campaign is linked as soon as the indexer has seen it (ADR-035).
  // A failure here must not hide the page; the "Check status" action reports it.
  await linkDeployedCampaign(db, adminId, id, deployment).catch((e) => {
    if (!(e instanceof CampaignReviewRefusedError)) console.error("[campaign.link] on page load:", e);
  });
  const [row] = await db
    .select({ campaign: campaigns, organization: organizations, starter: users })
    .from(campaigns)
    // Left join: a campaign for an individual has no organisation (org_id null); the page must still open.
    .leftJoin(organizations, eq(organizations.id, campaigns.orgId))
    .innerJoin(users, eq(users.id, campaigns.starterUserId))
    .where(eq(campaigns.id, id))
    .limit(1);
  // Platform admins see every campaign, drafts included (read-only; decisions only for PENDING_REVIEW).
  if (!row) notFound();
  const { campaign, organization, starter } = row;
  const [cover] = await db
    .select({ cid: campaignMedia.cid })
    .from(campaignMedia)
    .where(and(eq(campaignMedia.campaignId, id), eq(campaignMedia.kind, "COVER")))
    .limit(1);

  const media = toMediaView(await listMedia(db, id));
  const t = await getTranslations("admin.campaigns");
  const tRatings = await getTranslations("ratings");
  const tStatus = await getTranslations("campaigns.status");
  const tCause = await getTranslations("organizations.form.causeNames");
  const format = await getFormatter();
  const explorerUrl = getChainConfig(parseAppEnv(process.env.APP_ENV)).chain.blockExplorerUrl;
  const countries = new Intl.DisplayNames([locale], { type: "region" });

  // Before approval the address that will be copied; after it the one that was copied.
  const payout = campaign.beneficiaryAddress ?? organization?.payoutAddress;
  const payoutAddress = payout ? checksumAddress(payout) : "—";
  const story = (campaign.story as CampaignStory).text;
  const data: [string, React.ReactNode][] = [
    [t("fields.title"), campaign.title],
    [t("fields.slug"), campaign.slug],
    [t("fields.cause"), tCause.has(campaign.cause as never) ? tCause(campaign.cause as never) : campaign.cause],
    [t("fields.country"), countries.of(campaign.country) ?? campaign.country],
    [t("fields.goal"), <GoalAmount key="t" goal={campaignGoal(campaign.goalCurrency, campaign.goalAmountMinor)} />],
    [t("fields.durationDays"), t("days", { days: campaign.durationDays })],
    [t("fields.submittedAt"), campaign.submittedAt ? <LocalDateTime key="s" value={campaign.submittedAt} /> : "—"],
    [t("fields.payoutAddress"), payoutAddress],
  ];
  const snapshot: [string, React.ReactNode][] =
    campaign.targetUsdc !== null && campaign.rateAt && (campaign.eurUsdRate || campaign.rateSource === "USD_PEG")
      ? [
          campaign.eurUsdRate
            ? [t("snapshotFields.eurUsdRate"), campaign.eurUsdRate]
            : [t("snapshotFields.usdPeg"), t("snapshotFields.usdPegValue")],
          [t("snapshotFields.rateAt"), format.dateTime(campaign.rateAt, { dateStyle: "medium", timeZone: "UTC" })],
          [t("snapshotFields.targetUsdc"), <UsdcAmount key="u" usdc={campaign.targetUsdc} maxDecimals={6} />],
          [t("snapshotFields.beneficiary"), payoutAddress],
          [t("snapshotFields.offchainId"), campaign.offchainId ? `0x${campaign.offchainId.toString("hex")}` : "—"],
          [
            t("snapshotFields.reviewedAt"),
            campaign.reviewedAt ? <LocalDateTime key="r" value={campaign.reviewedAt} /> : "—",
          ],
        ]
      : [];

  const table = (label: string, rows: [string, React.ReactNode][]) => (
    <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-label={label}>
      <table className="ch-ledger">
        <thead>
          <tr>
            <th>{t("colField")}</th>
            <th>{t("colValue")}</th>
          </tr>
        </thead>
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
  );

  return (
    <div className="ch-container py-12 flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Link href="/admin/campaigns?view=all" className="text-sm font-bold underline text-[var(--ink)]">
          {t("back")}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="ch-section-heading uppercase text-[var(--ink)] break-words">
            {t("detailTitle", { title: campaign.title })}
          </h1>
          <StatusChip status={CAMPAIGN_CHIP[campaign.status]!}>{tStatus(campaign.status)}</StatusChip>
        </div>
        <p className="text-base text-[var(--ink)]">
          {t("organisation")}:{" "}
          {organization ? (
            <Link href={`/admin/organizations/${organization.id}`} className="underline">
              {organization.name}
            </Link>
          ) : (
            t("individual")
          )}{" "}
          · {t("starter")}: {starter.displayName}
        </p>
      </div>

      <SanctionedCountryNotice codes={[campaign.country, organization?.country]} locale={locale} />
      <section className="flex flex-col gap-3">
        <h2 className={heading}>{t("data")}</h2>
        {table(t("data"), data)}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className={heading}>{t("cover")}</h2>
        {cover ? (
          // A plain <img>: the file is served by the public media bucket, not by Next.
          <img
            src={publicMediaUrl(cover.cid)}
            alt={t("cover")}
            className="w-full max-w-xl border-2 border-[var(--ink)]"
          />
        ) : (
          <p className="text-base text-[var(--ink)]">{t("noCover")}</p>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className={heading}>{t("media.title")}</h2>
        <p className="text-sm text-[var(--ink)]">{t("media.note")}</p>
        {media.images.length + media.videos.length + media.documents.length === 0 ? (
          <p className="text-base text-[var(--ink)]">{t("media.none")}</p>
        ) : (
          <>
            {media.images.length > 0 && (
              <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3" aria-label={t("media.gallery")}>
                {media.images.map((image, index) => (
                  <li key={image.id} className="flex flex-col gap-2">
                    <img
                      src={image.url}
                      alt={t("media.imageAlt", { n: index + 1 })}
                      className="w-full aspect-[4/3] object-cover border-2 border-[var(--ink)]"
                    />
                    <MediaTakedown campaignId={campaign.id} mediaId={image.id} label={t("media.imageAlt", { n: index + 1 })} />
                  </li>
                ))}
              </ul>
            )}
            {media.videos.length + media.documents.length > 0 && (
              <ul className="flex flex-col gap-2" aria-label={t("media.links")}>
                {media.videos.map((video) => (
                  <li key={video.id} className="flex flex-wrap items-center gap-3">
                    <span className="ch-label">{t("media.video")}</span>
                    <a href={video.url} target="_blank" rel="noreferrer" className="ch-mono text-sm underline break-all text-[var(--ink)]">
                      {video.url}
                    </a>
                    <MediaTakedown campaignId={campaign.id} mediaId={video.id} label={video.url} />
                  </li>
                ))}
                {media.documents.map((doc) => (
                  <li key={doc.id} className="flex flex-wrap items-center gap-3">
                    <span className="ch-label">{t("media.document")}</span>
                    <a href={doc.url} target="_blank" rel="noreferrer" className="text-sm font-bold underline break-all text-[var(--ink)]">
                      {doc.label}
                    </a>
                    <span className="text-xs text-[var(--ink-muted)]">{t("media.sizeKb", { size: doc.sizeKb })}</span>
                    <MediaTakedown campaignId={campaign.id} mediaId={doc.id} label={doc.label} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className={heading}>{t("story")}</h2>
        {/* Plain text: React escapes it; paragraphs are kept by white-space. */}
        <p className="text-base text-[var(--ink)] whitespace-pre-line max-w-3xl">{story}</p>
      </section>

      {snapshot.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className={heading}>{t("snapshot")}</h2>
          {table(t("snapshot"), snapshot)}
        </section>
      )}

      {campaign.status === "APPROVED" && (
        <section className="flex flex-col gap-3">
          <h2 className={heading}>{t("publish.title")}</h2>
          <PublishPanel campaignId={campaign.id} publishTxHash={campaign.publishTxHash} explorerUrl={explorerUrl} />
        </section>
      )}

      {campaign.status === "DEPLOYED" && campaign.onchainAddress && (
        <section className="flex flex-col gap-3">
          <h2 className={heading}>{t("onChainTitle")}</h2>
          {table(t("onChainTitle"), [
            [t("onChainFields.address"), checksumAddress(campaign.onchainAddress)],
            [t("onChainFields.tx"), campaign.publishTxHash ?? "—"],
            [
              t("onChainFields.deployedAt"),
              campaign.deployedAt ? <LocalDateTime key="d" value={campaign.deployedAt} /> : "—",
            ],
          ])}
          {explorerUrl && (
            <a
              href={`${explorerUrl}/address/${campaign.onchainAddress}`}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-bold underline text-[var(--ink)]"
            >
              {explorerUrl.replace(/^https?:\/\//, "")}
            </a>
          )}
        </section>
      )}

      {campaign.status === "DEPLOYED" && campaign.onchainAddress && (
        <ChainActions
          db={db}
          campaignId={campaign.id}
          address={campaign.onchainAddress}
          individual={campaign.beneficiaryType === "INDIVIDUAL"}
        />
      )}

      {organization && (
        <section className="flex flex-col gap-3">
          <h2 className={heading}>{tRatings("adminHeading")}</h2>
          <p className="m-0 text-sm text-[var(--ink-muted)]">{tRatings("adminNote")}</p>
          <RatingList entries={await listRatings(db, { campaignId: campaign.id })} showCampaign={false} />
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className={heading}>{t("decision")}</h2>
        {campaign.status === "PENDING_REVIEW" ? (
          <CampaignReviewActions campaignId={campaign.id} payoutAddress={payoutAddress} />
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-base text-[var(--ink)]">{t("decided")}</p>
            {campaign.status === "REJECTED" && campaign.reviewNote && (
              <p className="text-sm text-[var(--ink)] whitespace-pre-line">
                {t("note")}: {campaign.reviewNote}
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
