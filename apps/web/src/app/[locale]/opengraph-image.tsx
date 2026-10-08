import { ImageResponse } from "next/og";
import { getTranslations } from "next-intl/server";
import { parseAppEnv } from "@cherrio/shared";
import { getExpectedOrigin } from "@/lib/security/origin";
import { OG_CONTENT_TYPE, OG_SIZE, SiteOgImage, loadOgFonts, loadOgLogo } from "@/lib/og/share-image";

// Default link preview for every page without its own (TASK-055b). Replaces
// the missing /brand/og-placeholder.png the layout pointed to.

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "CHERR.IO — transparent charitable donations";

export default async function Image({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const [t, fonts, logo] = await Promise.all([getTranslations({ locale, namespace: "og" }), loadOgFonts(), loadOgLogo()]);
  const host = new URL(getExpectedOrigin(parseAppEnv(process.env.APP_ENV ?? "local"))).host;
  return new ImageResponse(<SiteOgImage headline={t("siteHeadline")} sub={t("siteSub")} host={host} logo={logo} />, { ...OG_SIZE, fonts });
}
