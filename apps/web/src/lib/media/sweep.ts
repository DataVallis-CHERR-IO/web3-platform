import { isNotNull } from "drizzle-orm";
import { campaignMedia, evidenceBundles, evidenceFiles } from "@cherrio/db/schema";
import type { Database } from "@cherrio/db";
import type { ObjectStore } from "@/lib/files/s3";

// `files:sweep` part 2 (TASK-052) — public campaign media (ADR-037, ADR-039,
// ADR-047). Every public object lives under `campaigns/<campaign id>/` and is
// referenced by exactly one of:
//   - `campaign_media.cid`        (cover, gallery images, PDFs, demo covers);
//   - `evidence_files.public_key` (public evidence files of a draft or sealed round);
//   - `evidence_bundles.public_cids` (keys frozen into a sealed manifest — kept even
//     if their file row were ever removed, because the manifest points at them).
// An object none of them names, older than one hour, is an orphan: a replaced or
// removed file whose delete failed, a deleted draft campaign, or a demo cover
// that lost a race (TASK-038b). Nothing else in the public bucket is touched.

/** Uploads store the object before the row; a fresh object is never an orphan. */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
export const PUBLIC_PREFIX = "campaigns/";

export interface PublicSweepResult {
  dryRun: boolean;
  /** Keys of public objects that no row refers to. */
  orphanObjects: string[];
  failedDeletes: number;
}

export async function sweepPublicMedia(input: {
  db: Database;
  store: ObjectStore;
  dryRun: boolean;
  now?: Date;
  /** A narrower prefix for tests that share the bucket with parallel test files. */
  prefix?: string;
}): Promise<PublicSweepResult> {
  const { db, store, dryRun } = input;
  const now = input.now ?? new Date();
  const prefix = input.prefix ?? PUBLIC_PREFIX;
  if (!prefix.startsWith(PUBLIC_PREFIX)) throw new Error(`[Media] sweep prefix must start with ${PUBLIC_PREFIX}`);

  // List first, read the rows second: a row inserted meanwhile can only keep an object, never lose it.
  const objects = await store.list(prefix);
  const [media, files, bundles] = await Promise.all([
    db.select({ key: campaignMedia.cid }).from(campaignMedia),
    db.select({ key: evidenceFiles.publicKey }).from(evidenceFiles).where(isNotNull(evidenceFiles.publicKey)),
    db.select({ keys: evidenceBundles.publicCids }).from(evidenceBundles),
  ]);
  const keep = new Set<string>([
    ...media.map((row) => row.key),
    ...files.map((row) => row.key!),
    ...bundles.flatMap((row) => row.keys),
  ]);

  const orphanBefore = now.getTime() - ORPHAN_MIN_AGE_MS;
  const orphanObjects = objects
    .filter((o) => !keep.has(o.key) && o.lastModified !== undefined && o.lastModified.getTime() < orphanBefore)
    .map((o) => o.key);

  let failedDeletes = 0;
  if (!dryRun) {
    for (const key of orphanObjects) {
      try {
        await store.delete(key);
      } catch (error) {
        failedDeletes++;
        console.warn(`[Media] sweep delete failed (${error instanceof Error ? error.name : "unknown"})`);
      }
    }
  }
  return { dryRun, orphanObjects, failedDeletes };
}
