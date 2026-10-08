import { ImageResponse } from "next/og";
import { getTranslations } from "next-intl/server";
import { parseAppEnv } from "@cherrio/shared";
import { getDb } from "@/lib/db";
import { getPublicCampaign } from "@/lib/campaigns/public";
import { percentRaised } from "@/components/campaigns/public-display";
import { getExpectedOrigin } from "@/lib/security/origin";
import { CampaignOgImage, OG_CONTENT_TYPE, OG_SIZE, SiteOgImage, clampTitle, coverDataUri, loadOgFonts } from "@/lib/og/share-image";

// Link preview of a campaign (TASK-055b): cover, title, raised amount and
// progress — what people see when a campaign is shared.

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "CHERR.IO campaign";

export default async function Image({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  const [t, fonts, found] = await Promise.all([
    getTranslations({ locale, namespace: "og" }),
    loadOgFonts(),
    getPublicCampaign(getDb(), slug),
  ]);
  const host = new URL(getExpectedOrigin(parseAppEnv(process.env.APP_ENV ?? "local"))).host;
  if (!found) {
    return new ImageResponse(<SiteOgImage headline={t("siteHeadline")} sub={t("siteSub")} host={host} />, { ...OG_SIZE, fonts });
  }
  const { campaign } = found;
  const raised = campaign.onChain?.raised ?? 0n;
  return new ImageResponse(
    (
      <CampaignOgImage
        title={clampTitle(campaign.title)}
        raisedUsdc={raised}
        percent={percentRaised(raised, campaign.targetUsdc)}
        targetEurCents={campaign.targetEurCents}
        cover={await coverDataUri(campaign.coverUrl)}
        host={host}
        labels={{ raised: t("raised"), of: t("of"), cta: t("cta") }}
      />
    ),
    // Lower-case key: it replaces next/og's one-year "immutable" (the progress changes).
    { ...OG_SIZE, fonts, headers: { "cache-control": "public, max-age=300, s-maxage=300" } }
  );
}
