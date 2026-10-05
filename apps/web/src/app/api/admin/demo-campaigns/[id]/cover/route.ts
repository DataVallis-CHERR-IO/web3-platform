import { getDb } from "@/lib/db";
import { startDemoCover } from "@/lib/demo/cover";
import { parseCoverModel } from "@/lib/demo/cover-models";
import { handleDemoCover } from "./handler";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/demo-campaigns/:id/cover { model? } — start generating a cover
 * (202 pending, 201 if one exists). `model`: "flux-2-pro" (default) or "nano-banana-pro".
 */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleDemoCover(request, params, (_adminId, id, body) =>
    startDemoCover(getDb(), id, { model: parseCoverModel((body as { model?: unknown } | null)?.model) })
  );
}
