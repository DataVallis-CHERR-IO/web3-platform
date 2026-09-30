/**
 * Integration tests for packages/db.
 *
 * Prerequisites: local docker Postgres running (docker-compose.dev.yml).
 * Run: DATABASE_URL=postgres://cherrio:cherrio@localhost:5432/cherrio_dev \
 *        pnpm --filter db test:integration
 *
 * The tests wipe and recreate schema `app` before running so they are
 * fully isolated from any application data. NEVER point DATABASE_URL at
 * the Hetzner server or a production database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { runMigrations } from "../migrate.js";
import { runSeed } from "../seed.js";
import { eraseUser } from "../gdpr.js";
import * as schema from "../schema/index.js";
import { createDb } from "../index.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cherrio:cherrio@localhost:5432/cherrio_dev";

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof createDb>;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function dropAndRecreateAppSchema(): Promise<void> {
  // Wipe everything in schema `app` for a clean slate
  await client.unsafe(`DROP SCHEMA IF EXISTS app CASCADE`);
  await client.unsafe(`DROP TABLE IF EXISTS app."__drizzle_migrations"`);
}

// ── Suite setup ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  client = postgres(DATABASE_URL, { max: 1 });
  db = createDb(DATABASE_URL);
  await dropAndRecreateAppSchema();
});

afterAll(async () => {
  await client.end();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("migrations", () => {
  it("applies from zero without errors", async () => {
    await expect(runMigrations(DATABASE_URL)).resolves.toBeUndefined();
  });

  it("creates schema `app` with all 18 tables", async () => {
    const rows = await client<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'app' AND tablename != '__drizzle_migrations'
      ORDER BY tablename
    `;
    const tableNames = rows.map((r) => r.tablename).sort();
    const expected = [
      "audit_log", "campaign_media", "campaigns", "emergency_subpools",
      "evidence_bundles", "kyb_submissions", "kyc_checks", "onramp_orders",
      "org_members", "organizations", "points_ledger", "ratings",
      "registry_records", "trust_scores", "user_addresses", "user_levels",
      "user_roles", "users",
    ].sort();
    expect(tableNames).toEqual(expected);
  });

  it("stores migrations journal in schema `app`", async () => {
    const rows = await client<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'app' AND table_name = '__drizzle_migrations'
      ) AS exists
    `;
    expect(rows[0]?.exists).toBe(true);
  });

  it("is idempotent (second apply is a no-op)", async () => {
    await expect(runMigrations(DATABASE_URL)).resolves.toBeUndefined();
  });
});

describe("seed", () => {
  it("runs successfully on a fresh schema", async () => {
    await expect(runSeed(DATABASE_URL)).resolves.toBeUndefined();
  });

  it("seeds exactly 5 emergency sub-pools", async () => {
    const rows = await db.select().from(schema.emergencySubpools);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.poolId).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("seeds exactly 3 imported organisations", async () => {
    const rows = await db.select().from(schema.organizations);
    expect(rows).toHaveLength(3);
    rows.forEach((o) => expect(o.source).toBe("IMPORTED"));
  });

  it("is idempotent (second seed produces same row counts)", async () => {
    await expect(runSeed(DATABASE_URL)).resolves.toBeUndefined();
    const pools = await db.select().from(schema.emergencySubpools);
    const orgs  = await db.select().from(schema.organizations);
    expect(pools).toHaveLength(5);
    expect(orgs).toHaveLength(3);
  });

  it("admin idempotency: two seed runs with SEED_ADMIN_ADDRESS leave exactly 1 user, 1 address, 1 role", async () => {
    const TEST_ADMIN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    // First run
    await runSeed(DATABASE_URL, { adminAddress: TEST_ADMIN });
    // Second run — must be a no-op for the admin rows
    await runSeed(DATABASE_URL, { adminAddress: TEST_ADMIN });

    const addresses = await db
      .select()
      .from(schema.userAddresses)
      .where(eq(schema.userAddresses.address, TEST_ADMIN));
    expect(addresses).toHaveLength(1);

    const adminUserId = addresses[0]!.userId;

    const users = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, adminUserId));
    expect(users).toHaveLength(1);

    const roles = await db
      .select()
      .from(schema.userRoles)
      .where(eq(schema.userRoles.userId, adminUserId));
    expect(roles).toHaveLength(1);
    expect(roles[0]!.role).toBe("PLATFORM_ADMIN");

    // Cleanup
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, adminUserId));
    await db.delete(schema.userAddresses).where(eq(schema.userAddresses.userId, adminUserId));
    await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
  });
});

describe("bigint / numeric(78,0) round-trip", () => {
  it("stores and retrieves max uint256 exactly", async () => {
    const MAX_UINT256 = 2n ** 256n - 1n;

    // Need an org and user to anchor the onramp_order FK
    const [org] = await db
      .insert(schema.organizations)
      .values({
        source: "IMPORTED", name: "Test Org", country: "GB",
        registry: "UK_CC", registryId: "TEST-BIG-1",
        causes: [], kybStatus: "NONE",
      })
      .returning({ id: schema.organizations.id });

    const [user] = await db
      .insert(schema.users)
      .values({ displayName: "Bigint Tester" })
      .returning({ id: schema.users.id });

    const [order] = await db
      .insert(schema.onrampOrders)
      .values({
        userId: user!.id,
        provider: "TRANSAK",
        providerOrderId: "bigint-test-001",
        status: "PENDING",
        fiatAmountCents: 10000n,
        fiatCurrency: "EUR",
        usdcAmount: MAX_UINT256,
        walletAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
      })
      .returning();

    const fetched = await db
      .select()
      .from(schema.onrampOrders)
      .where(eq(schema.onrampOrders.id, order!.id))
      .limit(1);

    expect(fetched[0]?.usdcAmount).toBe(MAX_UINT256);
    // Also verify fiatAmountCents round-trips as bigint
    expect(fetched[0]?.fiatAmountCents).toBe(10000n);

    // Clean up
    await db.delete(schema.onrampOrders).where(eq(schema.onrampOrders.id, order!.id));
    await db.delete(schema.users).where(eq(schema.users.id, user!.id));
    void org; // not FK-constrained to onramp
  });
});

describe("eraseUser (GDPR)", () => {
  it("nulls personal fields and deletes personal rows in one transaction", async () => {
    // Setup: create user with personal data
    const [user] = await db
      .insert(schema.users)
      .values({ displayName: "Alice Smith", email: "alice@example.com", privyDid: "privy|alice" })
      .returning({ id: schema.users.id });
    const userId = user!.id;

    await db.insert(schema.userAddresses).values({
      userId, address: "0x1111111111111111111111111111111111111111",
      kind: "EXTERNAL", isPrimary: true,
    });
    await db.insert(schema.kycChecks).values({
      userId, applicantId: "sumsub-alice-001", status: "APPROVED",
    });
    await db.insert(schema.auditLog).values({
      actorUserId: userId, action: "LOGIN", entityType: "user",
      entityId: userId, ip: "192.168.1.1",
    });

    // Act
    await eraseUser(db, userId);

    // Assert: user record anonymised
    const [erased] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(erased?.displayName).toBe("Deleted user");
    expect(erased?.email).toBeNull();
    expect(erased?.privyDid).toBeNull();

    // Assert: personal rows deleted
    const addresses = await db.select().from(schema.userAddresses).where(eq(schema.userAddresses.userId, userId));
    expect(addresses).toHaveLength(0);
    const kyc = await db.select().from(schema.kycChecks).where(eq(schema.kycChecks.userId, userId));
    expect(kyc).toHaveLength(0);

    // Assert: audit log IP nulled
    const logs = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actorUserId, userId));
    expect(logs.length).toBeGreaterThan(0);
    logs.forEach((l) => expect(l.ip).toBeNull());

    // Cleanup
    await db.delete(schema.auditLog).where(eq(schema.auditLog.actorUserId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });
});
