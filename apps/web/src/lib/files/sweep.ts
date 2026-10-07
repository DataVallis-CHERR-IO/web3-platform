import { and, eq, inArray, isNull, lt, ne } from "drizzle-orm";
import { kybSubmissions, privateFiles } from "@cherrio/db/schema";
import type { Database } from "@cherrio/db";
import { removeStoredObject, type StorageDeps } from "./storage";

// `files:sweep` — housekeeping for private files (ADR-034):
//   1. KYB files uploaded but never submitted, older than 24 hours (evidence
//      files, TASK-033c, are never attached to a submission and are not swept);
//   2. files of applications rejected more than 90 days ago (by reviewed_at);
//   3. objects under `kyb/` and `evidence/` (TASK-052) without a live row (no
//      row, or a row with deleted_at). Evidence rows are marked deleted together
//      with their `evidence_files` row, so an evidence object without a live row
//      is left over from a failed delete or an upload that stopped half-way.
// A row is always marked deleted before its object is deleted.

const UNATTACHED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REJECTED_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** An upload stores the object before it inserts the row; never treat a fresh object as an orphan. */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
/** Prefixes of the private bucket the orphan rule looks at (`check/` is never touched). */
export const ORPHAN_PREFIXES = ["kyb/", "evidence/"] as const;

export interface SweepResult {
  dryRun: boolean;
  /** Storage keys of unattached files older than 24 h. */
  staleFiles: string[];
  /** Storage keys of files whose application was rejected more than 90 days ago. */
  rejectedFiles: string[];
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
  /** Narrower prefixes for tests that share the bucket with parallel test files; default `ORPHAN_PREFIXES`. */
  orphanPrefixes?: readonly string[];
}): Promise<SweepResult> {
  const { db, deps, dryRun } = input;
  const now = input.now ?? new Date();

  const stale = and(
    isNull(privateFiles.kybSubmissionId),
    ne(privateFiles.kind, "EVIDENCE"),
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

  // Rejected more than 90 days ago. Approved and pending applications are never touched.
  let rejectedRows = await db
    .select({ id: privateFiles.id, storageKey: privateFiles.storageKey })
    .from(privateFiles)
    .innerJoin(kybSubmissions, eq(kybSubmissions.id, privateFiles.kybSubmissionId))
    .where(
      and(
        isNull(privateFiles.deletedAt),
        eq(kybSubmissions.status, "REJECTED"),
        lt(kybSubmissions.reviewedAt, new Date(now.getTime() - REJECTED_MAX_AGE_MS))
      )
    );
  if (!dryRun && rejectedRows.length > 0) {
    rejectedRows = await db
      .update(privateFiles)
      .set({ deletedAt: new Date() })
      .where(and(inArray(privateFiles.id, rejectedRows.map((row) => row.id)), isNull(privateFiles.deletedAt)))
      .returning({ id: privateFiles.id, storageKey: privateFiles.storageKey });
  }
  const rejectedFiles = rejectedRows.map((row) => row.storageKey);

  const liveRows = await db
    .select({ storageKey: privateFiles.storageKey })
    .from(privateFiles)
    .where(isNull(privateFiles.deletedAt));
  // In a dry run the rows found above are still live; their objects are counted once, by their rule.
  const keep = new Set([...liveRows.map((row) => row.storageKey), ...staleFiles, ...rejectedFiles]);
  const orphanBefore = now.getTime() - ORPHAN_MIN_AGE_MS;
  const listed = [];
  for (const prefix of input.orphanPrefixes ?? ORPHAN_PREFIXES) listed.push(...(await deps.store.list(prefix)));
  const orphanObjects = listed
    .filter((o) => !keep.has(o.key) && o.lastModified !== undefined && o.lastModified.getTime() < orphanBefore)
    .map((o) => o.key);

  let failedDeletes = 0;
  if (!dryRun) {
    for (const key of [...staleFiles, ...rejectedFiles, ...orphanObjects]) {
      if (!(await removeStoredObject(key, deps))) failedDeletes++;
    }
  }
  return { dryRun, staleFiles, rejectedFiles, orphanObjects, failedDeletes };
}
