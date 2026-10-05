import { getDb } from "@/lib/db";
import { startDemoCover } from "@/lib/demo/cover";
import { handleDemoCover } from "./handler";

export const dynamic = "force-dynamic";

/** POST /api/admin/demo-campaigns/:id/cover — start generating a cover (202 pending, 201 if one exists). */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleDemoCover(request, params, (_adminId, id) => startDemoCover(getDb(), id));
}
