import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import * as schema from "@cherrio/db";
import { signSessionToken, requireRole, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { MFA_COOKIE_NAME } from "@/lib/auth/admin-mfa";
import { enrolTestAdmin } from "./helpers/organizations";
import { GET as handleUserGet, PATCH as handleUserPatch } from "@/app/api/auth/user/route";

async function deleteUser(userId: string): Promise<void> {
  const db = getDb();
  await db.delete(schema.adminMfa).where(eq(schema.adminMfa.userId, userId));
  await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, userId));
  await db.delete(schema.users).where(eq(schema.users.id, userId));
}

describe("DB-backed session & role tests", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("session-db tests need a reachable DATABASE_URL");
    }
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    process.env.APP_ENV = "local";

    try {
      await getDb().execute(sql`select 1`);
    } catch (err) {
      throw new Error("session-db tests need a reachable DATABASE_URL", { cause: err });
    }
  });

  afterAll(async () => {
    if (process.env.DATABASE_URL) await getDb().$client.end();
  });

  describe("erased user access revocation", () => {
    it("valid signed cookie for an erased user (privy_did=null) returns 401 on GET and PATCH /api/auth/user", async () => {
      const db = getDb();
      // 1. Create erased user in DB (privy_did is null)
      const [erasedUser] = await db
        .insert(schema.users)
        .values({
          displayName: "Deleted user",
          email: null,
          privyDid: null,
        })
        .returning();

      const userId = erasedUser!.id;
      try {
        const validCookie = await signSessionToken({ userId, roles: [] });

        // 2. GET /api/auth/user with this cookie
        const getReq = new Request("http://localhost:3000/api/auth/user", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${validCookie}` },
        });
        const getRes = await handleUserGet(getReq);
        expect(getRes.status).toBe(401);

        // 3. PATCH /api/auth/user with this cookie
        const patchReq = new Request("http://localhost:3000/api/auth/user", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost:3000",
            cookie: `${SESSION_COOKIE_NAME}=${validCookie}`,
          },
          body: JSON.stringify({ displayName: "Trying to update" }),
        });
        const patchRes = await handleUserPatch(patchReq);
        expect(patchRes.status).toBe(401);
      } finally {
        await deleteUser(userId);
      }
    });

    it("valid signed cookie for an erased former admin throws on requireRole", async () => {
      const db = getDb();
      const [erasedAdmin] = await db
        .insert(schema.users)
        .values({
          displayName: "Deleted user",
          email: null,
          privyDid: null,
        })
        .returning();

      const userId = erasedAdmin!.id;
      try {
        const token = await signSessionToken({ userId, roles: ["PLATFORM_ADMIN"] });

        const req = new Request("http://localhost:3000/api/admin", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
        });

        // Erased user must fail authentication before role check
        await expect(requireRole("PLATFORM_ADMIN", req)).rejects.toThrow("UNAUTHORIZED");
      } finally {
        await deleteUser(userId);
      }
    });
  });

  describe("requireRole authorization against DB", () => {
    it("passes for a user with the role in DB and a valid second factor (ADR-056)", async () => {
      const db = getDb();
      const [adminUser] = await db
        .insert(schema.users)
        .values({ displayName: "Admin User", privyDid: "privy|admin-live" })
        .returning();

      const userId = adminUser!.id;
      try {
        await db.insert(schema.userRoles).values({ userId, role: "PLATFORM_ADMIN" });

        const token = await signSessionToken({ userId, roles: ["PLATFORM_ADMIN"] });
        const withoutFactor = new Request("http://localhost:3000/api/admin", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
        });
        // Role alone (no factor enrolled) is not enough.
        await expect(requireRole("PLATFORM_ADMIN", withoutFactor)).rejects.toThrow("MFA_REQUIRED");

        const mfa = await enrolTestAdmin(userId);
        // Enrolled but no proof cookie: still refused.
        await expect(requireRole("PLATFORM_ADMIN", withoutFactor)).rejects.toThrow("MFA_REQUIRED");

        const req = new Request("http://localhost:3000/api/admin", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${token}; ${MFA_COOKIE_NAME}=${mfa}` },
        });
        const session = await requireRole("PLATFORM_ADMIN", req);
        expect(session.userId).toBe(userId);
      } finally {
        await deleteUser(userId);
      }
    });

    it("throws FORBIDDEN for an active user without the role in DB", async () => {
      const db = getDb();
      const [normalUser] = await db
        .insert(schema.users)
        .values({ displayName: "Normal User", privyDid: "privy|normal-live" })
        .returning();

      const userId = normalUser!.id;
      try {
        const token = await signSessionToken({ userId, roles: [] });
        const req = new Request("http://localhost:3000/api/admin", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
        });

        await expect(requireRole("PLATFORM_ADMIN", req)).rejects.toThrow("FORBIDDEN");
      } finally {
        await deleteUser(userId);
      }
    });

    it("throws FORBIDDEN when cookie claims PLATFORM_ADMIN but DB has no role (proves cookie claim is ignored)", async () => {
      const db = getDb();
      const [userWithForgedCookie] = await db
        .insert(schema.users)
        .values({ displayName: "Sneaky User", privyDid: "privy|sneaky-live" })
        .returning();

      const userId = userWithForgedCookie!.id;
      try {
        // Cookie payload claims PLATFORM_ADMIN, but no role exists in DB
        const forgedRoleToken = await signSessionToken({
          userId,
          roles: ["PLATFORM_ADMIN"],
        });

        const req = new Request("http://localhost:3000/api/admin", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${forgedRoleToken}` },
        });

        await expect(requireRole("PLATFORM_ADMIN", req)).rejects.toThrow("FORBIDDEN");
      } finally {
        await deleteUser(userId);
      }
    });
  });
});
