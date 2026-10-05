import { getDb } from "@/lib/db";
import { DemoCoverError, finishDemoCover } from "@/lib/demo/cover";
import { parseCoverModel } from "@/lib/demo/cover-models";
import { handleDemoCover } from "../handler";

export const dynamic = "force-dynamic";

/** POST /api/admin/demo-campaigns/:id/cover/check { requestId, model? } — 202 still working, 201 stored. */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleDemoCover(request, params, (adminId, id, body) => {
    const { requestId, model } = (body ?? {}) as { requestId?: unknown; model?: unknown };
    if (typeof requestId !== "string") throw new DemoCoverError("bad_request");
    return finishDemoCover(getDb(), adminId, id, requestId, { model: parseCoverModel(model) });
  });
}
