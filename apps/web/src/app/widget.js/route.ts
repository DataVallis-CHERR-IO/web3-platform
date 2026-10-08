/** GET /widget.js — defines <cherrio-donate> for other websites (TASK-019). */
import { getTranslations } from "next-intl/server";
import { parseAppEnv } from "@cherrio/shared";
import { getExpectedOrigin } from "@/lib/security/origin";
import { widgetJs } from "@/lib/embed/widget";

export const dynamic = "force-dynamic";

export async function GET() {
  const t = await getTranslations({ locale: "en", namespace: "widget" });
  return new Response(widgetJs(getExpectedOrigin(parseAppEnv(process.env.APP_ENV ?? "local")), t("frameTitle")), {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
