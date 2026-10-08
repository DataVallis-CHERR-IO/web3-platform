/** GET /api/v1/openapi.json — OpenAPI 3.1 description of the public API (TASK-018b). */
import { apiJson, apiOptions, siteOrigin } from "@/lib/api/v1";
import { openApiDocument } from "@/lib/api/openapi";

export const dynamic = "force-dynamic";

export function GET() {
  return apiJson(openApiDocument(siteOrigin()), { maxAge: 3600 });
}

export const OPTIONS = apiOptions;
