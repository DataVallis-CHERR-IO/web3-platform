/**
 * Private file storage commands, bundled into the image as apps/web/dist/files.mjs.
 *
 *   pnpm --filter web files:check              node apps/web/dist/files.mjs check
 *   pnpm --filter web files:sweep [--dry-run]  node apps/web/dist/files.mjs sweep [--dry-run]
 *
 * Prints counts only — never object keys, file contents or configuration values.
 */
import { createDb } from "@cherrio/db";
import { checkPrivateStorage } from "../src/lib/files/check";
import { defaultDeps } from "../src/lib/files/storage";
import { sweepPrivateFiles } from "../src/lib/files/sweep";
import { publicObjectStore } from "../src/lib/media/public-store";
import { sweepPublicMedia } from "../src/lib/media/sweep";

const [command, ...flags] = process.argv.slice(2);

async function main(): Promise<number> {
  if (command === "check" && flags.length === 0) {
    const { canary } = await checkPrivateStorage();
    console.log(`files:check ok — bucket reachable, probe written/read/deleted, canary ${canary}`);
    return 0;
  }
  if (command === "sweep" && flags.every((flag) => flag === "--dry-run")) {
    const dryRun = flags.length > 0;
    const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
    if (!url) {
      console.error("Neither DATABASE_URL_DIRECT nor DATABASE_URL is set.");
      return 1;
    }
    const db = createDb(url, { max: 1 });
    try {
      const result = await sweepPrivateFiles({ db, deps: defaultDeps(), dryRun });
      console.log(
        `files:sweep${dryRun ? " (dry run — nothing deleted)" : ""}: ` +
          `${result.staleFiles.length} unattached file(s) older than 24 h, ` +
          `${result.rejectedFiles.length} file(s) of applications rejected more than 90 days ago, ` +
          `${result.orphanObjects.length} object(s) without a live row, ` +
          `${result.failedDeletes} failed delete(s)`
      );
      const media = await sweepPublicMedia({ db, store: publicObjectStore(), dryRun });
      console.log(
        `files:sweep public media${dryRun ? " (dry run — nothing deleted)" : ""}: ` +
          `${media.orphanObjects.length} object(s) under campaigns/ that no row refers to (older than 1 h), ` +
          `${media.failedDeletes} failed delete(s)`
      );
      return result.failedDeletes + media.failedDeletes > 0 ? 1 : 0;
    } finally {
      await db.$client.end();
    }
  }
  console.error("Usage: files check | files sweep [--dry-run]");
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
    console.error(`files ${command ?? ""} failed — ${detail}`);
    process.exit(1);
  }
);
