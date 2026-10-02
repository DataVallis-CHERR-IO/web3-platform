import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { campaignMedia } from "@cherrio/db";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/files/storage";
import { tryAcquireUploadSlot } from "@/lib/files/upload-slots";
import { DraftRefusedError, loadOwnCampaign } from "@/lib/campaigns/drafts";
import { campaignError } from "@/lib/campaigns/errors";
import { withDraftAccess } from "@/lib/campaigns/route";
import { MAX_IMAGE_BYTES, processCoverImage } from "@/lib/media/image";
import { publicMediaUrl, putPublicImage, removePublicObject } from "@/lib/media/public-store";

export const dynamic = "force-dynamic";

const MULTIPART_ALLOWANCE_BYTES = 64 * 1024;

/**
 * POST /api/campaigns/:id/cover — multipart, one `file`. Replaces the cover of a
 * campaign that is DRAFT or REJECTED. The image is re-encoded to WebP without
 * metadata before it is stored in the public bucket (ADR-037).
 */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withDraftAccess(request, async (userId) => {
    const { id } = await params;
    if (!isUuid(id)) return campaignError("not_found", 404);

    const contentLength = request.headers.get("content-length");
    if (!contentLength || !/^\d+$/.test(contentLength)) return campaignError("length_required", 411);
    if (Number(contentLength) > MAX_IMAGE_BYTES + MULTIPART_ALLOWANCE_BYTES) return campaignError("file_too_large", 413);

    const db = getDb();
    const campaign = await loadOwnCampaign(db, userId, id);
    if (campaign.status !== "DRAFT" && campaign.status !== "REJECTED") throw new DraftRefusedError("not_editable");

    const release = tryAcquireUploadSlot();
    if (!release) return campaignError("busy", 503, { retryAfter: 5 });
    try {
      const file = (await request.formData().catch(() => null))?.get("file");
      if (!(file instanceof File)) return campaignError("bad_request", 400);
      const webp = await processCoverImage(Buffer.from(await file.arrayBuffer()));

      // No file name, no user input: the key is the campaign id and random bytes.
      const key = `campaigns/${id}/${randomBytes(12).toString("hex")}.webp`;
      await putPublicImage(key, webp);

      const cover = and(eq(campaignMedia.campaignId, id), eq(campaignMedia.kind, "COVER"));
      const replaced = await db.transaction(async (tx) => {
        const old = await tx.delete(campaignMedia).where(cover).returning({ cid: campaignMedia.cid });
        await tx.insert(campaignMedia).values({ campaignId: id, kind: "COVER", storage: "HETZNER_PUBLIC", cid: key });
        return old;
      });
      for (const { cid } of replaced) await removePublicObject(cid);

      return NextResponse.json({ url: publicMediaUrl(key) }, { status: 201 });
    } finally {
      release();
    }
  });
}
