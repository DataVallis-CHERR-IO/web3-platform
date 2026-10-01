import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import * as schema from "@cherrio/db";
import { signSessionToken, requireRole, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { GET as handleUserGet, PATCH as handleUserPatch } from "@/app/api/auth/user/route";

let isDbAvailable = false;

describe("DB-backed session & role tests", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ?? "postgres://cherrio:cherrio@localhost:5432/cherrio_dev";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    process.env.APP_ENV = "local";

    try {
      const client = postgres(process.env.DATABASE_URL, {
        max: 1,
        connect_timeout: 1,
      });
      await client`SELECT 1`;
      await client.end();
      isDbAvailable = true;
    } catch {
      isDbAvailable = false;
    }
  });

  describe("erased user access revocation", () => {
    it("valid signed cookie for an erased user (privy_did=null) returns 401 on GET and PATCH /api/auth/user", async () => {
      if (!isDbAvailable) return;
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

      // Cleanup
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    });

    it("valid signed cookie for an erased former admin throws on requireRole", async () => {
      if (!isDbAvailable) return;
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
      const token = await signSessionToken({ userId, roles: ["PLATFORM_ADMIN"] });

      const req = new Request("http://localhost:3000/api/admin", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
      });

      // Erased user must fail authentication before role check
      await expect(requireRole("PLATFORM_ADMIN", req)).rejects.toThrow("UNAUTHORIZED");

      // Cleanup
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    });
  });

  describe("requireRole authorization against DB", () => {
    it("passes for a user with the role in DB", async () => {
      if (!isDbAvailable) return;
      const db = getDb();
      const [adminUser] = await db
        .insert(schema.users)
        .values({ displayName: "Admin User", privyDid: "privy|admin-live" })
        .returning();

      await db
        .insert(schema.userRoles)
        .values({ userId: adminUser!.id, role: "PLATFORM_ADMIN" });

      const token = await signSessionToken({ userId: adminUser!.id, roles: ["PLATFORM_ADMIN"] });
      const req = new Request("http://localhost:3000/api/admin", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
      });

      const session = await requireRole("PLATFORM_ADMIN", req);
      expect(session.userId).toBe(adminUser!.id);

      // Cleanup
      await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, adminUser!.id));
      await db.delete(schema.users).where(eq(schema.users.id, adminUser!.id));
    });

    it("throws FORBIDDEN for an active user without the role in DB", async () => {
      if (!isDbAvailable) return;
      const db = getDb();
      const [normalUser] = await db
        .insert(schema.users)
        .values({ displayName: "Normal User", privyDid: "privy|normal-live" })
        .returning();

      const token = await signSessionToken({ userId: normalUser!.id, roles: [] });
      const req = new Request("http://localhost:3000/api/admin", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
      });

      await expect(requireRole("PLATFORM_ADMIN", req)).rejects.toThrow("FORBIDDEN");

      // Cleanup
      await db.delete(schema.users).where(eq(schema.users.id, normalUser!.id));
    });

    it("throws FORBIDDEN when cookie claims PLATFORM_ADMIN but DB has no role (proves cookie claim is ignored)", async () => {
      if (!isDbAvailable) return;
      const db = getDb();
      const [userWithForgedCookie] = await db
        .insert(schema.users)
        .values({ displayName: "Sneaky User", privyDid: "privy|sneaky-live" })
        .returning();

      // Cookie payload claims PLATFORM_ADMIN, but no role exists in DB
      const forgedRoleToken = await signSessionToken({
        userId: userWithForgedCookie!.id,
        roles: ["PLATFORM_ADMIN"],
      });

      const req = new Request("http://localhost:3000/api/admin", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${forgedRoleToken}` },
      });

      await expect(requireRole("PLATFORM_ADMIN", req)).rejects.toThrow("FORBIDDEN");

      // Cleanup
      await db.delete(schema.users).where(eq(schema.users.id, userWithForgedCookie!.id));
    });
  });
});
