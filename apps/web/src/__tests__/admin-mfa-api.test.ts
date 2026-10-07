import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { getDb } from "@/lib/db";
import { POST as enroll } from "@/app/api/admin/mfa/enroll/route";
import { POST as confirm } from "@/app/api/admin/mfa/confirm/route";
import { POST as verify } from "@/app/api/admin/mfa/verify/route";
import { hasValidMfa, MFA_COOKIE_NAME } from "@/lib/auth/admin-mfa";
import { base32Decode, hotp, timeStep } from "@/lib/auth/totp";
import { cleanUp, createUser, ORIGIN, type TestUser } from "./helpers/organizations";

// TASK-049 / ADR-056: the second-factor routes against real Postgres.

type Handler = (request: Request) => Promise<Response>;

function call(handler: Handler, user: TestUser | null, body: unknown = {}, origin = ORIGIN) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin };
  if (user) headers.Cookie = user.cookie;
  return handler(new Request(`${ORIGIN}/api/admin/mfa/x`, { method: "POST", headers, body: JSON.stringify(body) }));
}

function mfaCookieOf(response: Response): string | undefined {
  return response.headers.get("set-cookie")?.match(new RegExp(`${MFA_COOKIE_NAME}=([^;]+)`))?.[1];
}

/** Enrols and confirms; returns the secret, the confirmed step and the cookie. */
async function enrolled(user: TestUser) {
  const started = await call(enroll, user);
  expect(started.status).toBe(200);
  const { secret } = (await started.json()) as { secret: string };
  const key = base32Decode(secret);
  const step = timeStep(Date.now());
  const confirmed = await call(confirm, user, { code: hotp(key, step) });
  expect(confirmed.status).toBe(200);
  const { recoveryCodes } = (await confirmed.json()) as { recoveryCodes: string[] };
  return { key, step, recoveryCodes, cookie: mfaCookieOf(confirmed) };
}

afterAll(cleanUp);

describe("/api/admin/mfa/*", () => {
  it("is invisible to non-admins (404) and refuses a foreign origin (403)", async () => {
    const plain = await createUser();
    for (const handler of [enroll, confirm, verify]) {
      expect((await call(handler, null)).status).toBe(404);
      expect((await call(handler, plain, { code: "123456" })).status).toBe(404);
    }
    const admin = await createUser({ admin: true, mfa: false });
    expect((await call(enroll, admin, {}, "https://evil.example")).status).toBe(403);
  });

  it("enrolment: QR + key, stored encrypted, confirmed by the first code; recovery codes hashed", async () => {
    const admin = await createUser({ admin: true, mfa: false });
    const started = await call(enroll, admin);
    const body = (await started.json()) as { secret: string; otpauthUri: string; qrDataUrl: string };
    expect(body.secret).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
    expect(body.otpauthUri).toMatch(/^otpauth:\/\/totp\/CHERR\.IO%20local%3AOrg%20test%20user\?secret=[A-Z2-7]{32}&issuer=CHERR\.IO\+local/);
    expect(body.qrDataUrl.startsWith("data:image/svg+xml;utf8,")).toBe(true);

    const [row] = await getDb().select().from(schema.adminMfa).where(eq(schema.adminMfa.userId, admin.id));
    expect(row!.confirmedAt).toBeNull();
    expect(row!.secretEnc.startsWith("v1.")).toBe(true);
    expect(row!.secretEnc).not.toContain(body.secret.replace(/ /g, ""));

    // Not enrolled yet: verify refuses; a wrong first code is refused.
    expect(await (await call(verify, admin, { code: "000000" })).json()).toEqual({ error: "not_enrolled" });
    const key = base32Decode(body.secret);
    const wrong = hotp(key, timeStep(Date.now()) + 5);
    expect((await call(confirm, admin, { code: wrong })).status).toBe(400);

    const confirmed = await call(confirm, admin, { code: hotp(key, timeStep(Date.now())) });
    expect(confirmed.status).toBe(200);
    const { recoveryCodes } = (await confirmed.json()) as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    const cookie = mfaCookieOf(confirmed);
    expect(cookie).toBeTruthy();
    expect(confirmed.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(confirmed.headers.get("set-cookie")).toMatch(/Max-Age=43200/);

    const [after] = await getDb().select().from(schema.adminMfa).where(eq(schema.adminMfa.userId, admin.id));
    expect(after!.confirmedAt).not.toBeNull();
    expect(after!.recoveryCodeHashes).toHaveLength(10);
    expect(after!.recoveryCodeHashes.join()).not.toContain(recoveryCodes[0]!.replace(/-/g, ""));
    const audit = await getDb()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.actorUserId, admin.id), eq(schema.auditLog.action, "admin.mfa_enrolled")));
    expect(audit).toHaveLength(1);
  });

  it("a confirmed factor cannot be replaced by enrolling again (409)", async () => {
    const admin = await createUser({ admin: true, mfa: false });
    const { key } = await enrolled(admin);
    const again = await call(enroll, admin);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_enrolled" });
    const [row] = await getDb().select().from(schema.adminMfa).where(eq(schema.adminMfa.userId, admin.id));
    expect(row!.confirmedAt).not.toBeNull();
    // The original key still works.
    expect((await call(verify, admin, { code: hotp(key, timeStep(Date.now()) + 1) })).status).toBe(200);
  });

  it("verify: a code works once (replay refused), the next step works, a wrong code is 400", async () => {
    const admin = await createUser({ admin: true, mfa: false });
    const { key, step } = await enrolled(admin);
    expect(await (await call(verify, admin, { code: hotp(key, step) })).json()).toEqual({ error: "invalid_code" });
    const ok = await call(verify, admin, { code: hotp(key, step + 1) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ method: "totp", recoveryCodesLeft: 10 });
    expect(mfaCookieOf(ok)).toBeTruthy();
    expect((await call(verify, admin, { code: hotp(key, step + 1) })).status).toBe(400);
    expect((await call(verify, admin, { code: "not a code" })).status).toBe(400);
  });

  it("a recovery code works once, typed in any case and without dashes", async () => {
    const admin = await createUser({ admin: true, mfa: false });
    const { recoveryCodes } = await enrolled(admin);
    const typed = recoveryCodes[3]!.toLowerCase().replace(/-/g, "");
    const first = await call(verify, admin, { code: typed });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ method: "recovery", recoveryCodesLeft: 9 });
    expect((await call(verify, admin, { code: recoveryCodes[3] })).status).toBe(400);
    expect((await call(verify, admin, { code: "AAAA-BBBB-CCCC" })).status).toBe(400);
  });

  it("the cookie belongs to one user and one enrolment", async () => {
    const admin = await createUser({ admin: true, mfa: false });
    const other = await createUser({ admin: true, mfa: false });
    const { cookie } = await enrolled(admin);
    await enrolled(other);
    const db = getDb();
    expect(await hasValidMfa(db, admin.id, cookie)).toBe(true);
    expect(await hasValidMfa(db, other.id, cookie)).toBe(false);
    expect(await hasValidMfa(db, admin.id, undefined)).toBe(false);
    expect(await hasValidMfa(db, admin.id, `${cookie}x`)).toBe(false);

    // A reset (row deleted) and a new enrolment make the old cookie worthless.
    await db.delete(schema.adminMfa).where(eq(schema.adminMfa.userId, admin.id));
    expect(await hasValidMfa(db, admin.id, cookie)).toBe(false);
    const { cookie: fresh } = await enrolled(admin);
    expect(await hasValidMfa(db, admin.id, cookie)).toBe(false);
    expect(await hasValidMfa(db, admin.id, fresh)).toBe(true);
  });

  it("locks after 20 wrong codes in 24 hours (audit log, survives restarts); older failures do not count", async () => {
    const admin = await createUser({ admin: true, mfa: false });
    const { key, step } = await enrolled(admin);
    const db = getDb();
    const failure = { actorUserId: admin.id, action: "admin.mfa_failed", entityType: "user", entityId: admin.id };
    await db.insert(schema.auditLog).values({ ...failure, createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    await db.insert(schema.auditLog).values(Array.from({ length: 19 }, () => failure));

    // 19 recent failures (+1 older): the next wrong code is the 20th recent one and is recorded …
    expect((await call(verify, admin, { code: hotp(key, step + 5) })).status).toBe(400);
    const recent = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.actorUserId, admin.id), eq(schema.auditLog.action, "admin.mfa_failed")));
    expect(recent).toHaveLength(21);
    // … and now even the right code is refused.
    const locked = await call(verify, admin, { code: hotp(key, step + 1) });
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({ error: "locked" });
  });

  it("allows 10 attempts per 15 minutes per user, then 429", async () => {
    const admin = await createUser({ admin: true, mfa: false });
    await call(enroll, admin);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await call(confirm, admin, { code: "000000" })).status);
    expect(statuses.slice(0, 9).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
