import { and, inArray, isNull, lt } from "drizzle-orm";
import { privateFiles } from "@cherrio/db/schema";
import type { Database } from "@cherrio/db";
import { removeStoredObject, type StorageDeps } from "./storage";

// `files:sweep` — housekeeping for private files (ADR-034):
//   1. files uploaded but never submitted, older than 24 hours;
//   2. objects under `kyb/` without a live row (no row, or a row with deleted_at).
// A row is always marked deleted before its object is deleted.

const UNATTACHED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** An upload stores the object before it inserts the row; never treat a fresh object as an orphan. */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
const PREFIX = "kyb/";

export interface SweepResult {
  dryRun: boolean;
  /** Storage keys of unattached files older than 24 h. */
  staleFiles: string[];
  /** Storage keys of objects without a live row. */
  orphanObjects: string[];
  /** Objects that could not be deleted; the next run retries them as orphans. */
  failedDeletes: number;
}

export async function sweepPrivateFiles(input: {
  db: Database;
  deps: StorageDeps;
  dryRun: boolean;
  now?: Date;
}): Promise<SweepResult> {
  const { db, deps, dryRun } = input;
  const now = input.now ?? new Date();

  const stale = and(
    isNull(privateFiles.kybSubmissionId),
    isNull(privateFiles.deletedAt),
    lt(privateFiles.createdAt, new Date(now.getTime() - UNATTACHED_MAX_AGE_MS))
  );
  let staleRows = await db
    .select({ id: privateFiles.id, storageKey: privateFiles.storageKey })
    .from(privateFiles)
    .where(stale);
  if (!dryRun && staleRows.length > 0) {
    // Mark first; only rows that are still unattached at this moment are returned.
    staleRows = await db
      .update(privateFiles)
      .set({ deletedAt: new Date() })
      .where(and(inArray(privateFiles.id, staleRows.map((row) => row.id)), stale))
      .returning({ id: privateFiles.id, storageKey: privateFiles.storageKey });
  }
  const staleFiles = staleRows.map((row) => row.storageKey);

  const liveRows = await db
    .select({ storageKey: privateFiles.storageKey })
    .from(privateFiles)
    .where(isNull(privateFiles.deletedAt));
  // In a dry run the stale rows are still live; their objects are counted once, as stale files.
  const keep = new Set([...liveRows.map((row) => row.storageKey), ...staleFiles]);
  const orphanBefore = now.getTime() - ORPHAN_MIN_AGE_MS;
  const orphanObjects = (await deps.store.list(PREFIX))
    .filter((o) => !keep.has(o.key) && o.lastModified !== undefined && o.lastModified.getTime() < orphanBefore)
    .map((o) => o.key);

  let failedDeletes = 0;
  if (!dryRun) {
    for (const key of [...staleFiles, ...orphanObjects]) {
      if (!(await removeStoredObject(key, deps))) failedDeletes++;
    }
  }
  return { dryRun, staleFiles, orphanObjects, failedDeletes };
}
