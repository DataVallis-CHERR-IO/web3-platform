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
import { grantAdmin } from "../grant-admin.js";
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

  it("creates schema `app` with all 22 tables", async () => {
    const rows = await client<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'app' AND tablename != '__drizzle_migrations'
      ORDER BY tablename
    `;
    const tableNames = rows.map((r) => r.tablename).sort();
    const expected = [
      "audit_log", "campaign_media", "campaigns", "contract_changes", "emergency_subpools",
      "evidence_bundles", "evidence_files", "fx_rates", "kyb_submissions", "kyc_checks", "onramp_orders",
      "org_members", "organizations", "points_ledger", "private_files", "ratings",
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

  it("admin seeding: SEED_ADMIN_ADDRESS grants role only when user has logged in first", async () => {
    const TEST_ADMIN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    // 1. Seed without user in DB: does NOT create placeholder user
    await runSeed(DATABASE_URL, { adminAddress: TEST_ADMIN });
    const noAddr = await db
      .select()
      .from(schema.userAddresses)
      .where(eq(schema.userAddresses.address, TEST_ADMIN));
    expect(noAddr).toHaveLength(0);

    // 2. User logs in (created in DB)
    const [user] = await db
      .insert(schema.users)
      .values({ displayName: "Admin User", privyDid: "privy|admin-1" })
      .returning();
    await db
      .insert(schema.userAddresses)
      .values({ userId: user!.id, address: TEST_ADMIN, kind: "EXTERNAL", isPrimary: true });

    // 3. Seed with user present: grants PLATFORM_ADMIN
    await runSeed(DATABASE_URL, { adminAddress: TEST_ADMIN });
    // Second run is idempotent
    await runSeed(DATABASE_URL, { adminAddress: TEST_ADMIN });

    const roles = await db
      .select()
      .from(schema.userRoles)
      .where(eq(schema.userRoles.userId, user!.id));
    expect(roles).toHaveLength(1);
    expect(roles[0]!.role).toBe("PLATFORM_ADMIN");

    // Cleanup
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, user!.id));
    await db.delete(schema.userAddresses).where(eq(schema.userAddresses.userId, user!.id));
    await db.delete(schema.users).where(eq(schema.users.id, user!.id));
  });
});

describe("grantAdmin script helper", () => {
  const TEST_ADDR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  it("fails if user has not logged in yet", async () => {
    const res = await grantAdmin(DATABASE_URL, TEST_ADDR);
    expect(res.success).toBe(false);
    expect(res.message).toBe("User has not logged in yet — log in with this wallet first, then rerun.");
  });

  it("fails on invalid address format", async () => {
    const res = await grantAdmin(DATABASE_URL, "invalid-address");
    expect(res.success).toBe(false);
    expect(res.message).toContain("Invalid wallet address format");
  });

  it("grants PLATFORM_ADMIN role to existing user and is idempotent", async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ displayName: "Future Admin", privyDid: "privy|future-admin" })
      .returning();

    await db
      .insert(schema.userAddresses)
      .values({ userId: user!.id, address: TEST_ADDR, kind: "EXTERNAL", isPrimary: true });

    // First grant
    const res1 = await grantAdmin(DATABASE_URL, TEST_ADDR);
    expect(res1.success).toBe(true);
    expect(res1.userId).toBe(user!.id);

    // Second grant (idempotent)
    const res2 = await grantAdmin(DATABASE_URL, TEST_ADDR);
    expect(res2.success).toBe(true);

    const roles = await db
      .select()
      .from(schema.userRoles)
      .where(eq(schema.userRoles.userId, user!.id));
    expect(roles).toHaveLength(1);
    expect(roles[0]!.role).toBe("PLATFORM_ADMIN");

    // Cleanup
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, user!.id));
    await db.delete(schema.userAddresses).where(eq(schema.userAddresses.userId, user!.id));
    await db.delete(schema.users).where(eq(schema.users.id, user!.id));
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
  it("nulls personal fields and deletes personal rows, roles, and org memberships in one transaction", async () => {
    // Setup: create user with personal data, roles, and org membership
    const [user] = await db
      .insert(schema.users)
      .values({ displayName: "Alice Smith", email: "alice@example.com", privyDid: "privy|alice" })
      .returning({ id: schema.users.id });
    const userId = user!.id;

    // Create a sample org to anchor org_members
    const [org] = await db
      .insert(schema.organizations)
      .values({
        source: "REGISTERED",
        name: "Alice Org",
        country: "SI",
        registry: "SI_AJPES",
        registryId: "ALICE-ORG-1",
        causes: [],
        kybStatus: "NONE",
      })
      .returning({ id: schema.organizations.id });

    await db.insert(schema.userAddresses).values({
      userId, address: "0x1111111111111111111111111111111111111111",
      kind: "EXTERNAL", isPrimary: true,
    });
    await db.insert(schema.userRoles).values({
      userId, role: "PLATFORM_ADMIN",
    });
    await db.insert(schema.orgMembers).values({
      orgId: org!.id, userId, role: "ORG_ADMIN",
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

    // Assert: personal rows, roles, and memberships deleted
    const addresses = await db.select().from(schema.userAddresses).where(eq(schema.userAddresses.userId, userId));
    expect(addresses).toHaveLength(0);
    const roles = await db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, userId));
    expect(roles).toHaveLength(0);
    const memberships = await db.select().from(schema.orgMembers).where(eq(schema.orgMembers.userId, userId));
    expect(memberships).toHaveLength(0);
    const kyc = await db.select().from(schema.kycChecks).where(eq(schema.kycChecks.userId, userId));
    expect(kyc).toHaveLength(0);

    // Assert: audit log IP nulled
    const logs = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actorUserId, userId));
    expect(logs.length).toBeGreaterThan(0);
    logs.forEach((l) => expect(l.ip).toBeNull());

    // Cleanup
    await db.delete(schema.auditLog).where(eq(schema.auditLog.actorUserId, userId));
    await db.delete(schema.organizations).where(eq(schema.organizations.id, org!.id));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });
});

describe("eraseUser — KYB submissions and private files (ADR-034)", () => {
  it("closes pending submissions, marks the right files deleted and returns their storage keys", async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ displayName: "Bob Example", email: "bob@example.com", privyDid: "privy|bob-files" })
      .returning({ id: schema.users.id });
    const userId = user!.id;
    const org = async (source: "REGISTERED" | "IMPORTED", kybStatus: "PENDING" | "APPROVED" | "REJECTED") =>
      (
        await db
          .insert(schema.organizations)
          .values({ source, name: `Erase test ${source} ${kybStatus}`, country: "SI", registry: "NONE", causes: [], kybStatus })
          .returning({ id: schema.organizations.id })
      )[0]!.id;
    const submissionWithFile = async (orgId: string, status: "PENDING" | "APPROVED" | "REJECTED") => {
      const [submission] = await db
        .insert(schema.kybSubmissions)
        .values({ orgId, submittedBy: userId, status, reviewNote: status === "REJECTED" ? "A note about the organisation." : null })
        .returning({ id: schema.kybSubmissions.id });
      const storageKey = `kyb/unassigned/${schema.newId()}`;
      await db.insert(schema.privateFiles).values({
        storageKey, kind: "KYB_STATUTE", mimeType: "application/pdf", sizeBytes: 10,
        sha256: "b".repeat(64), uploadedBy: userId, kybSubmissionId: submission!.id,
      });
      return { id: submission!.id, storageKey };
    };

    const approvedOrg = await org("REGISTERED", "APPROVED");
    const rejectedOrg = await org("REGISTERED", "REJECTED");
    const importedOrg = await org("IMPORTED", "PENDING");
    const approved = await submissionWithFile(approvedOrg, "APPROVED");
    const rejected = await submissionWithFile(rejectedOrg, "REJECTED");
    const pendingClaim = await submissionWithFile(importedOrg, "PENDING");
    const unattachedKey = `kyb/unassigned/${schema.newId()}`;
    await db.insert(schema.privateFiles).values({
      storageKey: unattachedKey, kind: "KYB_OTHER", mimeType: "image/png", sizeBytes: 10,
      sha256: "c".repeat(64), uploadedBy: userId,
    });
    await db.insert(schema.orgMembers).values({ orgId: importedOrg, userId, role: "ORG_ADMIN" });
    // An evidence file (TASK-033c) belongs to the campaign's record: never erased with its uploader (ADR-047).
    const evidenceKey = `evidence/${schema.newId()}/${schema.newId()}`;
    await db.insert(schema.privateFiles).values({
      storageKey: evidenceKey, kind: "EVIDENCE", mimeType: "application/pdf", sizeBytes: 10,
      sha256: "d".repeat(64), uploadedBy: userId,
    });

    const result = await eraseUser(db, userId);
    expect([...result.storageKeys].sort()).toEqual([rejected.storageKey, pendingClaim.storageKey, unattachedKey].sort());

    const files = await db.select().from(schema.privateFiles).where(eq(schema.privateFiles.uploadedBy, userId));
    const deleted = files.filter((file) => file.deletedAt !== null).map((file) => file.storageKey);
    expect(deleted.sort()).toEqual([...result.storageKeys].sort());
    expect(files.find((file) => file.storageKey === approved.storageKey)!.deletedAt).toBeNull();
    expect(files.find((file) => file.storageKey === evidenceKey)!.deletedAt).toBeNull();

    const submissions = await db.select().from(schema.kybSubmissions).where(eq(schema.kybSubmissions.submittedBy, userId));
    const byId = (id: string) => submissions.find((s) => s.id === id)!;
    expect(byId(pendingClaim.id)).toMatchObject({ status: "REJECTED", reviewNote: null, reviewerId: null });
    expect(byId(pendingClaim.id).reviewedAt).toBeInstanceOf(Date);
    expect(byId(approved.id).status).toBe("APPROVED");
    expect(byId(rejected.id).reviewNote).toBe("A note about the organisation."); // kept: not personal data
    const statusOf = async (id: string) =>
      (await db.select().from(schema.organizations).where(eq(schema.organizations.id, id)))[0]!.kybStatus;
    expect(await statusOf(importedOrg)).toBe("NONE"); // a claim never leaves a real charity marked
    expect(await statusOf(approvedOrg)).toBe("APPROVED");
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, pendingClaim.id));
    expect(audit).toMatchObject([{ action: "kyb.closed_on_erase", actorUserId: null, data: null }]);

    // A second erase finds nothing more to do.
    expect((await eraseUser(db, userId)).storageKeys).toEqual([]);

    // A pending application for a NEW organisation is closed as REJECTED.
    const [other] = await db
      .insert(schema.users)
      .values({ displayName: "Carol Example", privyDid: "privy|carol-files" })
      .returning({ id: schema.users.id });
    const newOrg = await org("REGISTERED", "PENDING");
    await db.insert(schema.kybSubmissions).values({ orgId: newOrg, submittedBy: other!.id });
    await eraseUser(db, other!.id);
    expect(await statusOf(newOrg)).toBe("REJECTED");
  });
});

describe("private_files (ADR-033)", () => {
  const sha256 = "a".repeat(64);
  const row = (userId: string, over: Partial<typeof schema.privateFiles.$inferInsert> = {}) => ({
    storageKey: `kyb/unassigned/${schema.newId()}`,
    kind: "KYB_STATUTE" as const,
    mimeType: "application/pdf",
    sizeBytes: 1234,
    sha256,
    uploadedBy: userId,
    ...over,
  });

  it("stores a file row with defaults and enforces its constraints", async () => {
    const [user] = await db.insert(schema.users).values({ displayName: "File owner" }).returning();
    const userId = user!.id;
    try {
      const [file] = await db.insert(schema.privateFiles).values(row(userId)).returning();
      expect(file).toMatchObject({ keyVersion: 1, kybSubmissionId: null, deletedAt: null, sizeBytes: 1234 });
      expect(file!.createdAt).toBeInstanceOf(Date);

      // unique storage key
      await expect(
        db.insert(schema.privateFiles).values(row(userId, { storageKey: file!.storageKey }))
      ).rejects.toThrow();
      // size: more than 0, at most 10 MB
      await expect(db.insert(schema.privateFiles).values(row(userId, { sizeBytes: 0 }))).rejects.toThrow();
      await expect(
        db.insert(schema.privateFiles).values(row(userId, { sizeBytes: 10 * 1024 * 1024 + 1 }))
      ).rejects.toThrow();
      // sha256: 64 lowercase hex characters
      await expect(
        db.insert(schema.privateFiles).values(row(userId, { sha256: "A".repeat(64) }))
      ).rejects.toThrow();
      // uploader and submission must exist
      await expect(db.insert(schema.privateFiles).values(row(schema.newId()))).rejects.toThrow();
      await expect(
        db.insert(schema.privateFiles).values(row(userId, { kybSubmissionId: schema.newId() }))
      ).rejects.toThrow();

      const stored = await db
        .select()
        .from(schema.privateFiles)
        .where(eq(schema.privateFiles.uploadedBy, userId));
      expect(stored).toHaveLength(1);
    } finally {
      await db.delete(schema.privateFiles).where(eq(schema.privateFiles.uploadedBy, userId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
  });
});
