/**
 * GET /embed/campaigns/<slug> — the donate widget's page (TASK-019), loaded in an
 * iframe by /widget.js on other websites. Plain HTML, no app bundle, no cookies
 * read; may be framed by any site (frame-ancestors *), the rest of the app may not.
 */
import { getTranslations } from "next-intl/server";
import { getDb } from "@/lib/db";
import { getPublicCampaign } from "@/lib/campaigns/public";
import { getExpectedOrigin } from "@/lib/security/origin";
import { parseAppEnv } from "@cherrio/shared";
import { embedHtml, parseEmbedTheme } from "@/lib/embed/widget";

export const dynamic = "force-dynamic";

const LOCALE = "en";
const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "public, max-age=60",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors *; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const found = /^[a-z0-9-]{1,200}$/.test(slug) ? await getPublicCampaign(getDb(), slug) : null;
  if (!found) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const t = await getTranslations({ locale: LOCALE, namespace: "widget" });
  const origin = getExpectedOrigin(parseAppEnv(process.env.APP_ENV ?? "local"));
  const html = embedHtml(
    found.campaign,
    {
      verified: t("verified"),
      donate: t("donate"),
      seeCampaign: t("seeCampaign"),
      ended: t("ended"),
      ofGoal: (percent, goal) => t("ofGoal", { percent, goal }),
      donors: (count) => t("donors", { count }),
      daysLeft: (days) => t("daysLeft", { days }),
      lastDay: t("lastDay"),
      poweredBy: t("poweredBy"),
      label: t("label"),
    },
    {
      campaignUrl: `${origin}/${LOCALE}/campaigns/${slug}?utm_source=widget`,
      homeUrl: `${origin}/${LOCALE}`,
      theme: parseEmbedTheme(new URL(request.url).searchParams.get("theme")),
      locale: LOCALE,
    }
  );
  return new Response(html, { headers: HEADERS });
}
