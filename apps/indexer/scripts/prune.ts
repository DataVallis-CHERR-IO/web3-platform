/**
 * pnpm --filter indexer prune [-- --dry-run]
 * Drops old chain_<sha7> schemas; keeps the one the `chain` views read from and
 * the most recent other one. Never touches app, chain or ponder_sync.
 * Env: DATABASE_URL_DIRECT (the indexer role, which owns these schemas).
 */
import postgres from "postgres";
import { prune } from "../lib/prune";

const url = process.env.DATABASE_URL_DIRECT;
if (!url) throw new Error("[Indexer] DATABASE_URL_DIRECT is not set");
const dryRun = process.argv.includes("--dry-run");
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  const plan = await prune({ sql, dryRun });
  console.log(
    `prune${dryRun ? " (dry run)" : ""}: live=${plan.live ?? "none"} kept=[${plan.kept.join(", ")}] ` +
      `${dryRun ? "would drop" : "dropped"}=[${plan.drop.join(", ")}]`
  );
} finally {
  await sql.end();
}
