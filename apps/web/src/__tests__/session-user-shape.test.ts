import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { PrivyClient } from "@privy-io/server-auth";
import * as schema from "@cherrio/db";
import { getDb } from "@/lib/db";
import { POST as sessionPost } from "@/app/api/auth/session/route";
import { setPrivyClientForTesting } from "@/lib/auth/privy";
import { authRateLimiter } from "@/lib/security/rate-limit";

// Regression (David, dev test 2026-10-02): after a login the account page crashed,
// because POST /api/auth/session returned the user without `addresses`.

const DID = `did:privy:session-shape-${Date.now().toString(36)}`;
const EXTERNAL = "0x7a3c5f0000000000000000000000000000c0ffee";
const EMBEDDED = "0x7a3c5f0000000000000000000000000000beef01";

describe("POST /api/auth/session returns the same user shape as GET /api/auth/user (Postgres)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("this test needs DATABASE_URL");
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    setPrivyClientForTesting({
      verifyAuthToken: async () => ({ userId: DID }),
      getUser: async () => ({
        id: DID,
        linkedAccounts: [
          { type: "wallet", address: EXTERNAL, walletClientType: "metamask", connectorType: "injected" },
          { type: "wallet", address: EMBEDDED, walletClientType: "privy", connectorType: "embedded" },
        ],
      }),
    } as unknown as PrivyClient);
    authRateLimiter.reset();
  });
  afterAll(async () => {
    setPrivyClientForTesting(null);
    const db = getDb();
    const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.privyDid, DID));
    if (user) {
      await db.delete(schema.auditLog).where(eq(schema.auditLog.actorUserId, user.id));
      await db.delete(schema.userAddresses).where(eq(schema.userAddresses.userId, user.id));
      await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, user.id));
      await db.delete(schema.users).where(inArray(schema.users.id, [user.id]));
    }
    await db.$client.end();
  });

  it("includes the user's wallet addresses", async () => {
    const res = await sessionPost(
      new Request("http://localhost:3000/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
        body: JSON.stringify({ accessToken: "fake-token" }),
      })
    );
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { roles: string[]; addresses: { address: string; kind: string }[] } };
    expect(user.roles).toEqual([]);
    expect(user.addresses.map((a) => `${a.kind}:${a.address}`).sort()).toEqual([`EMBEDDED:${EMBEDDED}`, `EXTERNAL:${EXTERNAL}`]);
  });
});
