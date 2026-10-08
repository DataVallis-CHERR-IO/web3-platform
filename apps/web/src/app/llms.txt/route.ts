/** GET /llms.txt — plain description of the site for language models (TASK-018a). */
import { parseAppEnv } from "@cherrio/shared";
import { getExpectedOrigin } from "@/lib/security/origin";
import { llmsTxt } from "@/lib/seo/llms";

export const dynamic = "force-dynamic";

export function GET() {
  const origin = getExpectedOrigin(parseAppEnv(process.env.APP_ENV ?? "local"));
  return new Response(llmsTxt(origin), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
