import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { getDb } from "@/lib/db";
import { getNotificationSettings, pointBalances, requestContactEmail } from "@/lib/notifications/preferences";
import { GET as getSettings, PUT as putSettings } from "@/app/api/me/notifications/route";
import { DELETE as deleteEmail, POST as postEmail } from "@/app/api/me/notifications/email/route";
import { GET as confirm } from "@/app/api/notifications/confirm/route";
import { POST as unsubscribe } from "@/app/api/notifications/unsubscribe/route";
import { cleanUp, createUser, ORIGIN, type TestUser } from "./helpers/organizations";

// TASK-033e part 3: email notification settings, double opt-in, one-click unsubscribe, points.

const { auditLog, notificationPreferences, notifications, pointsLedger, users } = schema;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const req = (path: string, user: TestUser | null, init: { method?: string; body?: unknown; origin?: string } = {}) => {
  const headers: Record<string, string> = { Origin: init.origin ?? ORIGIN };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (user) headers.cookie = user.cookie;
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
};
const json = async (res: Response) => ({ status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null });

let withLogin: TestUser;
let walletOnly: TestUser;
const created: string[] = [];

async function confirmTokenOf(userId: string): Promise<string> {
  const rows = await getDb().select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.kind, "EMAIL_CONFIRM")));
  const last = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
  return (last.data as { token: string }).token;
}

describe("notification settings (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("notification tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    withLogin = await createUser();
    walletOnly = await createUser();
    await getDb().update(users).set({ email: `login-${withLogin.id}@example.com` }).where(eq(users.id, withLogin.id));
    await getDb().update(users).set({ email: null }).where(eq(users.id, walletOnly.id));
    created.push(withLogin.id, walletOnly.id);
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(notifications).where(inArray(notifications.userId, created));
    await db.delete(notificationPreferences).where(inArray(notificationPreferences.userId, created));
    await db.delete(pointsLedger).where(inArray(pointsLedger.userId, created));
    await db.delete(auditLog).where(inArray(auditLog.entityId, created));
    await cleanUp();
  });

  it("login email by default; switching off is stored and audited; login and origin are required", async () => {
    expect((await getSettings(req("/api/me/notifications", null))).status).toBe(401);
    const first = await json(await getSettings(req("/api/me/notifications", withLogin)));
    expect(first).toEqual({
      status: 200,
      body: {
        emailEnabled: true, loginEmail: `login-${withLogin.id}@example.com`, contactEmail: null, pendingEmail: null, pendingUntil: null,
        sendsTo: `login-${withLogin.id}@example.com`,
      },
    });
    expect((await putSettings(req("/api/me/notifications", withLogin, { method: "PUT", body: { emailEnabled: false }, origin: "https://evil.example" }))).status).toBe(403);
    const off = await json(await putSettings(req("/api/me/notifications", withLogin, { method: "PUT", body: { emailEnabled: false } })));
    expect(off.body).toMatchObject({ emailEnabled: false, sendsTo: null });
    const [audit] = await getDb().select().from(auditLog).where(and(eq(auditLog.entityId, withLogin.id), eq(auditLog.action, "notifications.email_enabled")));
    expect(audit!.data).toEqual({ enabled: false });
    await putSettings(req("/api/me/notifications", withLogin, { method: "PUT", body: { emailEnabled: true } }));
  });

  it("double opt-in for a wallet-only user: invalid, same as login, confirm link, second click, wrong token, limit", async () => {
    expect(await json(await postEmail(req("/api/me/notifications/email", walletOnly, { method: "POST", body: { email: "not-an-email" } })))).toEqual({
      status: 400, body: { error: "email_invalid" },
    });
    expect((await json(await postEmail(req("/api/me/notifications/email", withLogin, { method: "POST", body: { email: `LOGIN-${withLogin.id}@example.com` } })))).body).toEqual({
      error: "same_as_login",
    });
    const asked = await json(await postEmail(req("/api/me/notifications/email", walletOnly, { method: "POST", body: { email: " Donor@Example.com " } })));
    expect(asked.body).toMatchObject({ pendingEmail: "donor@example.com", contactEmail: null, sendsTo: null });

    const token = await confirmTokenOf(walletOnly.id);
    const [prefs] = await getDb().select().from(notificationPreferences).where(eq(notificationPreferences.userId, walletOnly.id));
    expect(prefs!.confirmTokenHash).toBe(sha256(token));
    expect(prefs!.confirmTokenHash).not.toBe(token);

    const bad = await confirm(req(`/api/notifications/confirm?token=wrong`, null));
    expect([bad.status, bad.headers.get("location")]).toEqual([303, `${ORIGIN}/en/notifications/confirmed?ok=0`]);
    const ok = await confirm(req(`/api/notifications/confirm?token=${token}`, null));
    expect(ok.headers.get("location")).toBe(`${ORIGIN}/en/notifications/confirmed?ok=1`);
    expect(await getNotificationSettings(getDb(), walletOnly.id)).toMatchObject({ contactEmail: "donor@example.com", pendingEmail: null, sendsTo: "donor@example.com" });
    expect((await confirm(req(`/api/notifications/confirm?token=${token}`, null))).headers.get("location")).toBe(`${ORIGIN}/en/notifications/confirmed?ok=1`);

    // Three requests per hour (one used above, plus two) — the fourth is refused.
    await requestContactEmail(getDb(), walletOnly.id, "second@example.com");
    await requestContactEmail(getDb(), walletOnly.id, "third@example.com");
    expect(await json(await postEmail(req("/api/me/notifications/email", walletOnly, { method: "POST", body: { email: "fourth@example.com" } })))).toEqual({
      status: 429, body: { error: "too_many_requests" },
    });

    const removed = await json(await deleteEmail(req("/api/me/notifications/email", walletOnly, { method: "DELETE" })));
    expect(removed.body).toMatchObject({ contactEmail: null, pendingEmail: null, sendsTo: null });
  });

  it("behind the proxy the redirect uses the environment's public origin, not the container address", async () => {
    const before = process.env.APP_ENV;
    process.env.APP_ENV = "dev";
    try {
      const res = await confirm(new Request("http://0.0.0.0:3000/api/notifications/confirm?token=unknown"));
      expect([res.status, res.headers.get("location")]).toEqual([303, "https://dev.cherr.io/en/notifications/confirmed?ok=0"]);
    } finally {
      process.env.APP_ENV = before;
    }
  });

  it("an expired confirmation link does not confirm", async () => {
    const u = await createUser();
    created.push(u.id);
    await requestContactEmail(getDb(), u.id, "late@example.com", new Date(Date.now() - 25 * 3_600_000));
    const token = await confirmTokenOf(u.id);
    expect((await confirm(req(`/api/notifications/confirm?token=${token}`, null))).headers.get("location")).toBe(`${ORIGIN}/en/notifications/confirmed?ok=0`);
    expect((await getNotificationSettings(getDb(), u.id)).contactEmail).toBeNull();
  });

  it("one-click unsubscribe with the token from the email; an unknown token is 404", async () => {
    await getSettings(req("/api/me/notifications", withLogin));
    await putSettings(req("/api/me/notifications", withLogin, { method: "PUT", body: { emailEnabled: true } }));
    const [prefs] = await getDb().select().from(notificationPreferences).where(eq(notificationPreferences.userId, withLogin.id));
    expect((await unsubscribe(req(`/api/notifications/unsubscribe?token=nope`, null, { method: "POST", origin: "https://mail.example" }))).status).toBe(404);
    const res = await json(await unsubscribe(req(`/api/notifications/unsubscribe?token=${prefs!.unsubscribeToken}`, null, { method: "POST", origin: "https://mail.example" })));
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect((await getNotificationSettings(getDb(), withLogin.id)).emailEnabled).toBe(false);
  });

  it("point balances sum the ledger without voided entries", async () => {
    const db = getDb();
    const base = { userId: withLogin.id, reason: "VOTE" as const, delta: 200n };
    await db.insert(pointsLedger).values([
      { ...base, bucket: "STATUS", refKey: "vote:0xa:1" }, { ...base, bucket: "REWARD", refKey: "vote:0xa:1" },
      { ...base, bucket: "STATUS", refKey: "vote:0xa:2" }, { ...base, bucket: "REWARD", refKey: "vote:0xa:2" },
      { ...base, bucket: "STATUS", refKey: "vote:0xb:1", voidedAt: new Date(), voidedReason: "test" },
    ]);
    expect(await pointBalances(db, withLogin.id)).toEqual({ status: 400n, reward: 400n, votes: 2 });
  });
});
