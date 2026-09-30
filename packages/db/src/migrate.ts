import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Apply all pending Drizzle migrations.
 * Migrations journal is stored in schema `app` (not `public`) so all
 * CHERR.IO objects stay isolated from the Ponder `chain` schema and defaults.
 *
 * Connection: use DATABASE_URL_DIRECT (direct Postgres, not PgBouncer) because
 * Drizzle's migrator uses advisory locks and session-level features that are
 * incompatible with PgBouncer transaction-mode pooling.
 * Falls back to DATABASE_URL if DATABASE_URL_DIRECT is unset.
 */
export async function runMigrations(databaseUrl?: string): Promise<void> {
  const url =
    databaseUrl ??
    process.env.DATABASE_URL_DIRECT ??
    process.env.DATABASE_URL;
  if (!url) {
    throw new Error("Neither DATABASE_URL_DIRECT nor DATABASE_URL is set");
  }

  // max: 1 — migrations must run serially in a single connection
  const migrationClient = postgres(url, { max: 1 });
  const db = drizzle(migrationClient);

  const migrationsFolder = join(__dirname, "../drizzle");

  console.log("Running migrations...");
  await migrate(db, {
    migrationsFolder,
    migrationsSchema: "app",
    migrationsTable: "__drizzle_migrations",
  });
  console.log("Migrations complete.");

  await migrationClient.end();
}

// Allow running directly: `tsx src/migrate.ts` or `pnpm --filter db migrate`
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith("/migrate.ts") ||
    process.argv[1].endsWith("/migrate.js"));

if (isMain) {
  runMigrations().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
