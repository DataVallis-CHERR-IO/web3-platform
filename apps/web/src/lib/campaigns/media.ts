import { randomBytes } from "node:crypto";
import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import { auditLog, campaignMedia, type Database } from "@cherrio/db";
import { CAMPAIGN_MEDIA_LIMITS, parseVideoUrl, pdfLabel, videoCid } from "@cherrio/shared";
import { FileRejectedError } from "@/lib/files/file-type";
import { processCoverImage } from "@/lib/media/image";
import { putPublicImage, putPublicPdf, removePublicObject } from "@/lib/media/public-store";
import { loadOwnCampaign } from "./drafts";

// Campaign media (ADR-039): gallery images, YouTube/Vimeo links and public PDFs.
// No review: everything is public at once. Allowed in every campaign status,
// because nothing about media is stored on-chain. The cover keeps its own rules
// (TASK-010a) and is never handled here.

export type MediaRefusal = "too_many_images" | "too_many_videos" | "too_many_documents" | "video_url_invalid" | "media_not_found";

/** The request is valid but cannot be done; nothing was written. */
export class MediaRefusedError extends Error {
  constructor(public readonly code: MediaRefusal) {
    super(code);
    this.name = "MediaRefusedError";
  }
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Kind = "GALLERY" | "VIDEO" | "DOCUMENT";
const LIMIT: Record<Kind, { max: number; refusal: MediaRefusal }> = {
  GALLERY: { max: CAMPAIGN_MEDIA_LIMITS.gallery, refusal: "too_many_images" },
  VIDEO: { max: CAMPAIGN_MEDIA_LIMITS.video, refusal: "too_many_videos" },
  DOCUMENT: { max: CAMPAIGN_MEDIA_LIMITS.document, refusal: "too_many_documents" },
};

const PDF_MAGIC = Buffer.from("%PDF-");
export function isPdf(bytes: Buffer): boolean {
  return bytes.length >= PDF_MAGIC.length && bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

async function countOf(db: Database | Tx, campaignId: string, kind: Kind): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(campaignMedia)
    .where(and(eq(campaignMedia.campaignId, campaignId), eq(campaignMedia.kind, kind)));
  return row?.n ?? 0;
}

/**
 * Inserts one media row under a per-campaign lock, so parallel uploads cannot
 * pass the limit. Returns false when the limit is reached (nothing written).
 */
async function insertWithinLimit(
  db: Database,
  values: { campaignId: string; kind: Kind; cid: string; storage: "HETZNER_PUBLIC" | "EXTERNAL"; label?: string; sizeBytes?: number; createdBy: string },
  ip?: string
): Promise<string | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`media:${values.campaignId}`}))`);
    if ((await countOf(tx, values.campaignId, values.kind)) >= LIMIT[values.kind].max) return null;
    const [last] = await tx
      .select({ sort: sql<number>`coalesce(max(${campaignMedia.sort}), 0)` })
      .from(campaignMedia)
      .where(and(eq(campaignMedia.campaignId, values.campaignId), eq(campaignMedia.kind, values.kind)));
    const [row] = await tx
      .insert(campaignMedia)
      .values({ ...values, sort: (last?.sort ?? 0) + 1 })
      .returning({ id: campaignMedia.id });
    await tx.insert(auditLog).values({
      actorUserId: values.createdBy,
      action: "campaign.media_add",
      entityType: "campaign",
      entityId: values.campaignId,
      data: { mediaId: row!.id, kind: values.kind },
      ip,
    });
    return row!.id;
  });
}

/** A gallery image: the cover pipeline (WebP, ≤ 1600 px, no metadata). */
export async function addGalleryImage(db: Database, userId: string, campaignId: string, bytes: Buffer, ip?: string) {
  await loadOwnCampaign(db, userId, campaignId);
  // Fail fast before the expensive re-encode; the limit is checked again under the lock.
  if ((await countOf(db, campaignId, "GALLERY")) >= LIMIT.GALLERY.max) throw new MediaRefusedError("too_many_images");
  const webp = await processCoverImage(bytes);
  const key = `campaigns/${campaignId}/g-${randomBytes(12).toString("hex")}.webp`;
  await putPublicImage(key, webp);
  const id = await insertWithinLimit(
    db,
    { campaignId, kind: "GALLERY", cid: key, storage: "HETZNER_PUBLIC", sizeBytes: webp.length, createdBy: userId },
    ip
  );
  if (!id) {
    await removePublicObject(key);
    throw new MediaRefusedError("too_many_images");
  }
  return { id, key };
}

/** A public PDF, stored unchanged (ADR-039). */
export async function addDocument(db: Database, userId: string, campaignId: string, bytes: Buffer, filename: string, ip?: string) {
  await loadOwnCampaign(db, userId, campaignId);
  if (bytes.length === 0) throw new FileRejectedError("file_empty");
  if (bytes.length > CAMPAIGN_MEDIA_LIMITS.documentBytes) throw new FileRejectedError("file_too_large");
  if (!isPdf(bytes)) throw new FileRejectedError("file_type_not_allowed");
  if ((await countOf(db, campaignId, "DOCUMENT")) >= LIMIT.DOCUMENT.max) throw new MediaRefusedError("too_many_documents");
  const key = `campaigns/${campaignId}/d-${randomBytes(12).toString("hex")}.pdf`;
  await putPublicPdf(key, bytes);
  const label = pdfLabel(filename);
  const id = await insertWithinLimit(
    db,
    { campaignId, kind: "DOCUMENT", cid: key, storage: "HETZNER_PUBLIC", label, sizeBytes: bytes.length, createdBy: userId },
    ip
  );
  if (!id) {
    await removePublicObject(key);
    throw new MediaRefusedError("too_many_documents");
  }
  return { id, key, label };
}

/** A YouTube or Vimeo link; nothing is downloaded or stored but the video id. */
export async function addVideo(db: Database, userId: string, campaignId: string, url: string, ip?: string) {
  await loadOwnCampaign(db, userId, campaignId);
  const video = parseVideoUrl(url);
  if (!video) throw new MediaRefusedError("video_url_invalid");
  const id = await insertWithinLimit(db, { campaignId, kind: "VIDEO", cid: videoCid(video), storage: "EXTERNAL", createdBy: userId }, ip);
  if (!id) throw new MediaRefusedError("too_many_videos");
  return { id, video };
}

/**
 * Removes one media item (never the cover). `as` decides who may: the
 * organisation's ORG_ADMIN, or a platform admin (takedown; checked by the route).
 */
export async function removeMedia(
  db: Database,
  actorId: string,
  campaignId: string,
  mediaId: string,
  as: "owner" | "platform_admin",
  ip?: string
) {
  if (as === "owner") await loadOwnCampaign(db, actorId, campaignId);
  const removed = await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(campaignMedia)
      .where(and(eq(campaignMedia.id, mediaId), eq(campaignMedia.campaignId, campaignId), ne(campaignMedia.kind, "COVER")))
      .returning({ kind: campaignMedia.kind, cid: campaignMedia.cid, storage: campaignMedia.storage });
    if (!row) return null;
    await tx.insert(auditLog).values({
      actorUserId: actorId,
      action: as === "owner" ? "campaign.media_remove" : "campaign.media_takedown",
      entityType: "campaign",
      entityId: campaignId,
      data: { mediaId, kind: row.kind },
      ip,
    });
    return row;
  });
  if (!removed) throw new MediaRefusedError("media_not_found");
  if (removed.storage === "HETZNER_PUBLIC") await removePublicObject(removed.cid);
}

/** All media of a campaign except the cover, in display order. */
export function listMedia(db: Database, campaignId: string) {
  return db
    .select({
      id: campaignMedia.id,
      kind: campaignMedia.kind,
      cid: campaignMedia.cid,
      storage: campaignMedia.storage,
      label: campaignMedia.label,
      sizeBytes: campaignMedia.sizeBytes,
    })
    .from(campaignMedia)
    .where(and(eq(campaignMedia.campaignId, campaignId), ne(campaignMedia.kind, "COVER")))
    .orderBy(asc(campaignMedia.kind), asc(campaignMedia.sort), asc(campaignMedia.createdAt));
}
