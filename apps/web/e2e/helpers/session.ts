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

/** Local-only values; the E2E server runs with APP_ENV=local. */
export const E2E_SESSION_SECRET = "e2e-session-secret-not-a-real-secret-0123456789abcdef";

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

/** Removes everything the test user created (rows only; s3mock objects are left to the sweep). */
export async function deleteTestUser(userId: string): Promise<void> {
  const client = db();
  const { privateFiles, kybSubmissions, orgMembers, organizations, auditLog, userRoles, users } = schema;
  try {
    const orgs = await client.select({ id: orgMembers.orgId }).from(orgMembers).where(eq(orgMembers.userId, userId));
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
