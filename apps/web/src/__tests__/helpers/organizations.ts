import { inArray } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { getDb } from "@/lib/db";
import { POST as apply } from "@/app/api/organizations/route";
import { signSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth/session";

// Shared set-up for the organisation integration tests (real handlers, real Postgres).

export const ORIGIN = "http://localhost:3000";
export const PAYOUT_ADDRESS = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"; // EIP-55 test vector
const { organizations, kybSubmissions, orgMembers, privateFiles, auditLog, users, userRoles, campaigns, campaignMedia } =
  schema;

const RUN = Date.now().toString(36); // keeps registry numbers of this run unique
const userIds: string[] = [];
const orgIds: string[] = [];
let n = 0;

export interface TestUser {
  id: string;
  cookie: string;
}

export async function createUser(options: { admin?: boolean } = {}): Promise<TestUser> {
  const [user] = await getDb()
    .insert(users)
    .values({ displayName: "Org test user", privyDid: `privy|org-review-${RUN}-${++n}` })
    .returning();
  userIds.push(user!.id);
  if (options.admin) await getDb().insert(userRoles).values({ userId: user!.id, role: "PLATFORM_ADMIN" });
  const token = await signSessionToken({ userId: user!.id, roles: [] });
  return { id: user!.id, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

/** The two required documents, as private_files rows (no object storage needed). */
export async function createFiles(userId: string): Promise<string[]> {
  const rows = (["KYB_REGISTRATION_EXTRACT", "KYB_AUTHORISATION"] as const).map((kind) => {
    const id = schema.newId();
    return {
      id,
      storageKey: `kyb/unassigned/${id}`,
      kind,
      mimeType: "application/pdf",
      sizeBytes: 1234,
      sha256: "ab".repeat(32),
      uploadedBy: userId,
    };
  });
  await getDb().insert(privateFiles).values(rows);
  return rows.map((row) => row.id);
}

export async function createImportedOrg() {
  const [org] = await getDb()
    .insert(organizations)
    .values({
      source: "IMPORTED",
      name: "Imported Test Charity",
      legalName: "Imported Test Charity Ltd",
      country: "GB",
      registry: "UK_CC",
      registryId: `R${RUN}-${++n}`,
      website: "https://imported.example.org",
      description: "Public data from the registry import.",
      causes: ["humanitarian"],
    })
    .returning();
  orgIds.push(org!.id);
  return org!;
}

/** An organisation with the given KYB status and `admin` as its ORG_ADMIN, inserted directly. */
export async function createOrganization(admin: TestUser, kybStatus: "APPROVED" | "PENDING" | "REJECTED" = "APPROVED") {
  const [org] = await getDb()
    .insert(organizations)
    .values({
      source: "REGISTERED",
      name: "Campaign Test Shelter",
      country: "SI",
      registry: "NONE",
      causes: ["animals"],
      kybStatus,
      payoutAddress: PAYOUT_ADDRESS.toLowerCase(),
    })
    .returning();
  orgIds.push(org!.id);
  await getDb().insert(orgMembers).values({ orgId: org!.id, userId: admin.id, role: "ORG_ADMIN" });
  return org!;
}

/** Submits an application through POST /api/organizations with fresh documents. */
export async function submit(user: TestUser, override: Record<string, unknown> = {}) {
  const body = {
    name: "Test Animal Shelter",
    legalName: "Test Animal Shelter Society",
    country: "SI",
    registry: "SI_AJPES",
    registryId: `N${RUN}-${++n}`,
    website: "https://shelter.example.org",
    description: "A generated organisation for tests.",
    causes: ["animals", "community"],
    payoutAddress: PAYOUT_ADDRESS,
    fileIds: await createFiles(user.id),
    ...override,
  };
  const res = await apply(
    new Request(`${ORIGIN}/api/organizations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, cookie: user.cookie },
      body: JSON.stringify(body),
    })
  );
  const json = (await res.json()) as { organizationId?: string; submissionId?: string; claim?: boolean; error?: string };
  if (json.organizationId) orgIds.push(json.organizationId);
  return { status: res.status, body, ...json };
}

/** Deletes everything the users and organisations of this run created, then closes the connection. */
export async function cleanUp(): Promise<void> {
  const db = getDb();
  await db.delete(privateFiles).where(inArray(privateFiles.uploadedBy, userIds));
  if (orgIds.length > 0) {
    const own = await db.select({ id: campaigns.id }).from(campaigns).where(inArray(campaigns.orgId, orgIds));
    if (own.length > 0) {
      const ids = own.map((campaign) => campaign.id);
      await db.delete(campaignMedia).where(inArray(campaignMedia.campaignId, ids));
      await db.delete(auditLog).where(inArray(auditLog.entityId, ids));
      await db.delete(campaigns).where(inArray(campaigns.id, ids));
    }
    await db.delete(kybSubmissions).where(inArray(kybSubmissions.orgId, orgIds));
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
  }
  await db.delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
  if (orgIds.length > 0) await db.delete(organizations).where(inArray(organizations.id, orgIds));
  await db.delete(userRoles).where(inArray(userRoles.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
  await db.$client.end();
}
