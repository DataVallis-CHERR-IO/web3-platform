import { ImageResponse } from "next/og";
import { getTranslations } from "next-intl/server";
import { parseAppEnv } from "@cherrio/shared";
import { getDb } from "@/lib/db";
import { getPublicCampaign } from "@/lib/campaigns/public";
import { getExpectedOrigin } from "@/lib/security/origin";
import {
  CampaignOgImage, OG_CONTENT_TYPE, OG_SIZE, SiteOgImage, clampTitle, coverDataUri, loadOgFonts, loadOgLogo, ogVariant,
} from "@/lib/og/share-image";
import { ogStoreKey, readStoredOg, storeOg } from "@/lib/og/store";

// Link preview of a campaign (TASK-055b; static design TASK-059, David
// 2026-10-08). No live figures: the networks cache the image when the link is
// shared, so a figure would be stale there. Rendered once per content (title,
// cover, outcome …) and kept in the public bucket.

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "CHERR.IO campaign";

/** The outcome can change (funded / ended): networks may ask again after an hour. */
const CACHE = "public, max-age=3600, s-maxage=3600";

export default async function Image({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  const [t, tCause, fonts, logo, found] = await Promise.all([
    getTranslations({ locale, namespace: "og" }),
    getTranslations({ locale, namespace: "organizations.form.causeNames" }),
    loadOgFonts(),
    loadOgLogo(),
    getPublicCampaign(getDb(), slug),
  ]);
  if (!found) {
    const host = new URL(getExpectedOrigin(parseAppEnv(process.env.APP_ENV ?? "local"))).host;
    return new ImageResponse(<SiteOgImage headline={t("siteHeadline")} sub={t("siteSub")} host={host} logo={logo} />, { ...OG_SIZE, fonts });
  }
  const { campaign } = found;
  // The goal in the campaign's goal currency (EUR today; ADR proposal: USD goals) — never USDC.
  const goal = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(
    Number(campaign.targetEurCents / 100n)
  );
  const country = new Intl.DisplayNames([locale], { type: "region" }).of(campaign.country) ?? campaign.country;
  const cause = tCause.has(campaign.cause as never) ? tCause(campaign.cause as never) : campaign.cause;
  const content = {
    locale,
    variant: ogVariant(campaign.onChain?.state),
    title: clampTitle(campaign.title),
    org: campaign.orgName || null,
    orgVerified: campaign.orgVerified,
    tag: `${cause} · ${country}`,
    goal: t("goal", { amount: goal }),
    until: t("until", { date: new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(campaign.deadline) }),
    coverUrl: campaign.coverUrl,
  };
  const key = ogStoreKey(campaign.id, content);
  const stored = await readStoredOg(key);
  if (stored) {
    return new Response(new Uint8Array(stored), { headers: { "content-type": OG_CONTENT_TYPE, "cache-control": CACHE } });
  }
  const { coverUrl, locale: _locale, ...shown } = content;
  const cover = await coverDataUri(coverUrl);
  const rendered = new ImageResponse(
    (
      <CampaignOgImage
        {...shown}
        cover={cover}
        logo={logo}
        labels={{
          verified: t("verified"), successLine: t("successLine"), publicLine: t("publicLine"),
          donate: t("donate"), funded: t("funded"), ended: t("ended"),
        }}
      />
    ),
    { ...OG_SIZE, fonts }
  );
  const png = Buffer.from(await rendered.arrayBuffer());
  // A cover that failed to load is not stored: the next request tries again.
  if (!coverUrl || cover !== null) await storeOg(key, png);
  return new Response(new Uint8Array(png), { headers: { "content-type": OG_CONTENT_TYPE, "cache-control": CACHE } });
}
