/**
 * Idempotent seed script.
 * Safe to run multiple times on the same database (ON CONFLICT DO NOTHING).
 *
 * Seeds:
 *   - 1 platform admin user (address from SEED_ADMIN_ADDRESS env var)
 *   - 5 Emergency Pool sub-pools (pool_id 0–4)
 *   - 3 imported sample organisations (UK_CC, US_IRS, SI_AJPES)
 *
 * Connection: use DATABASE_URL_DIRECT (direct Postgres, not PgBouncer) because
 * the seed uses transactions that require session-level features.
 * Falls back to DATABASE_URL if DATABASE_URL_DIRECT is unset.
 *
 * Run: DATABASE_URL_DIRECT=... tsx src/seed.ts
 *      or: pnpm --filter db seed
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import * as schema from "./schema/index.js";

const SUBPOOLS = [
  { poolId: 0, slug: "general",   nameKey: "pool.general.name",   descriptionKey: "pool.general.description"   },
  { poolId: 1, slug: "medical",   nameKey: "pool.medical.name",   descriptionKey: "pool.medical.description"   },
  { poolId: 2, slug: "disasters", nameKey: "pool.disasters.name", descriptionKey: "pool.disasters.description" },
  { poolId: 3, slug: "animals",   nameKey: "pool.animals.name",   descriptionKey: "pool.animals.description"   },
  { poolId: 4, slug: "climate",   nameKey: "pool.climate.name",   descriptionKey: "pool.climate.description"   },
] as const;

const SAMPLE_ORGS = [
  {
    source: "IMPORTED" as const,
    name: "British Red Cross",
    legalName: "British Red Cross Society",
    country: "GB",
    registry: "UK_CC" as const,
    registryId: "220949",
    website: "https://www.redcross.org.uk",
    description: "Humanitarian charity helping people in crisis across the UK and around the world.",
    causes: ["humanitarian", "disasters"],
    kybStatus: "NONE" as const,
  },
  {
    source: "IMPORTED" as const,
    name: "American Red Cross",
    legalName: "The American National Red Cross",
    country: "US",
    registry: "US_IRS" as const,
    registryId: "53-0196605",
    website: "https://www.redcross.org",
    description: "American humanitarian organization providing emergency assistance, disaster relief, and education.",
    causes: ["humanitarian", "disasters"],
    kybStatus: "NONE" as const,
  },
  {
    source: "IMPORTED" as const,
    name: "Rdeči križ Slovenije",
    legalName: "Rdeči križ Slovenije",
    country: "SI",
    registry: "SI_AJPES" as const,
    registryId: "5156790000",
    website: "https://www.rks.si",
    description: "Slovenska humanitarna organizacija za pomoč v sili in katastrofah.",
    causes: ["humanitarian"],
    kybStatus: "NONE" as const,
  },
] as const;

interface SeedOpts {
  /**
   * Override the admin wallet address (for tests).
   * When omitted, SEED_ADMIN_ADDRESS env var is used.
   */
  adminAddress?: string;
}

export async function runSeed(databaseUrl?: string, opts?: SeedOpts): Promise<void> {
  // Prefer DATABASE_URL_DIRECT: seed uses transactions requiring a session connection,
  // incompatible with PgBouncer transaction-mode pooling.
  const url =
    databaseUrl ??
    process.env.DATABASE_URL_DIRECT ??
    process.env.DATABASE_URL;
  if (!url) throw new Error("Neither DATABASE_URL_DIRECT nor DATABASE_URL is set");

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  // ── 1. Emergency sub-pools ─────────────────────────────────────────────────
  for (const pool of SUBPOOLS) {
    await db
      .insert(schema.emergencySubpools)
      .values(pool)
      .onConflictDoNothing({ target: schema.emergencySubpools.poolId });
  }
  console.log(`Seeded ${SUBPOOLS.length} emergency sub-pools.`);

  // ── 2. Sample imported organisations ──────────────────────────────────────
  for (const org of SAMPLE_ORGS) {
    await db
      .insert(schema.organizations)
      .values({ ...org, causes: [...org.causes] })
      .onConflictDoNothing({
        target: [schema.organizations.registry, schema.organizations.registryId],
      });
  }
  console.log(`Seeded ${SAMPLE_ORGS.length} sample organisations.`);

  // ── 3. Platform admin user ─────────────────────────────────────────────────
  // Gives PLATFORM_ADMIN to the user who owns SEED_ADMIN_ADDRESS once logged in.
  // Does NOT create placeholder users or addresses (which would conflict on real login).
  const rawAdmin = opts?.adminAddress ?? process.env.SEED_ADMIN_ADDRESS;
  const adminAddress = rawAdmin?.toLowerCase();

  if (!adminAddress) {
    console.warn("SEED_ADMIN_ADDRESS not set — skipping platform admin seed.");
  } else if (!/^0x[0-9a-f]{40}$/.test(adminAddress)) {
    console.warn("SEED_ADMIN_ADDRESS is not a valid 0x address — skipping.");
  } else {
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ userId: schema.userAddresses.userId })
        .from(schema.userAddresses)
        .where(eq(schema.userAddresses.address, adminAddress))
        .limit(1);

      if (existing) {
        await tx
          .insert(schema.userRoles)
          .values({ userId: existing.userId, role: "PLATFORM_ADMIN" })
          .onConflictDoNothing({ target: [schema.userRoles.userId, schema.userRoles.role] });
        console.log(`Seeded platform admin for user ${existing.userId}: ${adminAddress}`);
      } else {
        console.log(`SEED_ADMIN_ADDRESS ${adminAddress} has not logged in yet — role will be granted via grant-admin or seed after login.`);
      }
    });
  }

  await client.end();
  console.log("Seed complete.");
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith("/seed.ts") ||
    process.argv[1].endsWith("/seed.js"));

if (isMain) {
  runSeed().catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
}
