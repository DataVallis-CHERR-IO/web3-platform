/**
 * Test-only: a logged-in user for E2E without Privy.
 * Inserts a user row and signs the app's own session cookie with the secret the
 * E2E server is started with (playwright.config.ts). Lives in e2e/, which is
 * never part of the image (.dockerignore) and never imported by the app.
 */
import type { BrowserContext } from "@playwright/test";
import { SignJWT } from "jose";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { E2E_SESSION_SECRET } from "../../playwright.env";

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("E2E needs DATABASE_URL (docker compose -f docker-compose.dev.yml up -d)");
  return schema.createDb(url, { max: 1 });
}

/** Creates a user and logs the browser context in as that user. Returns the user id. */
export async function loginAsNewUser(
  context: BrowserContext,
  label: string,
  options: { admin?: boolean } = {}
): Promise<string> {
  const client = db();
  try {
    const [user] = await client
      .insert(schema.users)
      .values({ displayName: `E2E ${label}`, privyDid: `privy|e2e-${label}-${Date.now()}` })
      .returning();
    if (options.admin) await client.insert(schema.userRoles).values({ userId: user!.id, role: "PLATFORM_ADMIN" });
    const token = await new SignJWT({ sub: user!.id, roles: [] })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(E2E_SESSION_SECRET));
    await context.addCookies([
      { name: "cherrio_session", value: token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
    return user!.id;
  } finally {
    await client.$client.end();
  }
}

/** An APPROVED organisation with this user as its ORG_ADMIN (inserted directly; no KYB flow). */
export async function createApprovedOrganization(userId: string, name: string): Promise<string> {
  const client = db();
  try {
    const [org] = await client
      .insert(schema.organizations)
      .values({
        source: "REGISTERED", name, country: "SI", registry: "NONE", causes: ["animals"], kybStatus: "APPROVED",
        payoutAddress: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
      })
      .returning();
    await client.insert(schema.orgMembers).values({ orgId: org!.id, userId, role: "ORG_ADMIN" });
    return org!.id;
  } finally {
    await client.$client.end();
  }
}

/** A campaign as its organisation submitted it (PENDING_REVIEW) with a cover row. Returns its id. */
export async function createSubmittedCampaign(userId: string, orgId: string, title: string, coverKey: string): Promise<string> {
  const client = db();
  try {
    const [campaign] = await client
      .insert(schema.campaigns)
      .values({
        orgId, starterUserId: userId, beneficiaryType: "ORGANIZATION", title,
        slug: `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`,
        story: { format: "plain", text: "The roof of our shelter leaks.\n\nWith your help we replace it before winter." },
        cause: "animals", country: "SI", targetEurCents: "1200000", durationDays: 30,
        status: "PENDING_REVIEW", submittedAt: new Date(),
      })
      .returning({ id: schema.campaigns.id });
    await client
      .insert(schema.campaignMedia)
      .values({ campaignId: campaign!.id, kind: "COVER", cid: coverKey, storage: "HETZNER_PUBLIC" });
    return campaign!.id;
  } finally {
    await client.$client.end();
  }
}

/** Removes everything the test user created (rows only; s3mock objects are left to the sweep). */
export async function deleteTestUser(userId: string): Promise<void> {
  const client = db();
  const { privateFiles, kybSubmissions, orgMembers, organizations, auditLog, userRoles, users, campaigns, campaignMedia } =
    schema;
  try {
    const orgs = await client.select({ id: orgMembers.orgId }).from(orgMembers).where(eq(orgMembers.userId, userId));
    const own = await client.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.starterUserId, userId));
    if (own.length > 0) {
      await client.delete(campaignMedia).where(inArray(campaignMedia.campaignId, own.map((c) => c.id)));
      await client.delete(auditLog).where(inArray(auditLog.entityId, own.map((c) => c.id)));
      await client.delete(campaigns).where(eq(campaigns.starterUserId, userId));
    }
    await client.delete(privateFiles).where(eq(privateFiles.uploadedBy, userId));
    await client.delete(kybSubmissions).where(eq(kybSubmissions.submittedBy, userId));
    await client.delete(orgMembers).where(eq(orgMembers.userId, userId));
    if (orgs.length > 0) await client.delete(organizations).where(inArray(organizations.id, orgs.map((o) => o.id)));
    await client.delete(auditLog).where(eq(auditLog.actorUserId, userId));
    await client.delete(userRoles).where(eq(userRoles.userId, userId));
    await client.delete(users).where(eq(users.id, userId));
  } finally {
    await client.$client.end();
  }
}
