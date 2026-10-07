import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivyClient } from "@privy-io/server-auth";
import { and, eq, inArray, sql } from "drizzle-orm";
import { MFA_COOKIE_NAME } from "@/lib/auth/admin-mfa";
import { enrolTestAdmin } from "./helpers/organizations";
import * as schema from "@cherrio/db";
import messages from "../../messages/en.json";
import { getDb } from "@/lib/db";
import { POST as upload } from "@/app/api/files/kyb/route";
import { DELETE as remove } from "@/app/api/files/kyb/[id]/route";
import { GET as download } from "@/app/api/admin/files/[id]/route";
import { DELETE as eraseAccount } from "@/app/api/auth/account/route";
import { setPrivyClientForTesting } from "@/lib/auth/privy";
import { signSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { filesRateLimiter } from "@/lib/security/rate-limit";
import { canaryKey, checkPrivateStorage } from "@/lib/files/check";
import { FILES_ERROR_CODES } from "@/lib/files/errors";
import { MAX_FILE_BYTES } from "@/lib/files/file-type";
import { defaultDeps, kybStorageKey } from "@/lib/files/storage";
import { sweepPrivateFiles } from "@/lib/files/sweep";
import { MAX_CONCURRENT_UPLOADS, tryAcquireUploadSlot } from "@/lib/files/upload-slots";

// Integration tests for private files: real route handlers, Postgres and the
// local s3mock (docker-compose.dev.yml / the CI service). One file on purpose:
// the sweep looks at the whole bucket, so these tests must not run in parallel.

const ORIGIN = "http://localhost:3000";
const { privateFiles, auditLog, users } = schema;
const pdf = Buffer.concat([Buffer.from("%PDF-1.7\ngenerated dummy statute\n"), randomBytes(256)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);

const userIds: string[] = [];
let userCookie = "";
let otherCookie = "";
let adminCookie = "";
let userId = "";
let adminId = "";

async function createUser(label: string, admin = false) {
  const [user] = await getDb()
    .insert(users)
    .values({ displayName: `Files test ${label}`, privyDid: `privy|files-test-${label}-${Date.now()}` })
    .returning();
  userIds.push(user!.id);
  const token = await signSessionToken({ userId: user!.id, roles: [] });
  if (!admin) return { id: user!.id, cookie: `${SESSION_COOKIE_NAME}=${token}` };
  await getDb().insert(schema.userRoles).values({ userId: user!.id, role: "PLATFORM_ADMIN" });
  // An admin who typed a code (ADR-056).
  return { id: user!.id, cookie: `${SESSION_COOKIE_NAME}=${token}; ${MFA_COOKIE_NAME}=${await enrolTestAdmin(user!.id)}` };
}

async function uploadRequest(
  cookie: string | null,
  bytes: Buffer,
  options: { contentLength?: string | null; name?: string } = {}
) {
  const form = new FormData();
  form.set("kind", "KYB_STATUTE");
  form.set("file", new File([new Uint8Array(bytes)], options.name ?? "upload.pdf", { type: "application/pdf" }));
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  const headers: Record<string, string> = { Origin: ORIGIN, "Content-Type": encoded.headers.get("content-type")! };
  if (cookie) headers.cookie = cookie;
  const length = options.contentLength === undefined ? String(body.length) : options.contentLength;
  if (length !== null) headers["Content-Length"] = length;
  return new Request(`${ORIGIN}/api/files/kyb`, { method: "POST", headers, body });
}

async function uploadOk(cookie: string, bytes: Buffer = pdf): Promise<string> {
  const res = await upload(await uploadRequest(cookie, bytes));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const downloadAs = (cookie: string | null, id: string) =>
  download(new Request(`${ORIGIN}/api/admin/files/${id}`, { headers: cookie ? { cookie } : {} }), idParams(id));
const removeAs = (cookie: string, id: string) =>
  remove(
    new Request(`${ORIGIN}/api/files/kyb/${id}`, { method: "DELETE", headers: { Origin: ORIGIN, cookie } }),
    idParams(id)
  );
const storedObject = (id: string) => defaultDeps().store.get(kybStorageKey(id));
const fileRow = async (id: string) =>
  (await getDb().select().from(privateFiles).where(eq(privateFiles.id, id)))[0];
/** Marks the test user's unattached files deleted and removes their objects. */
async function clearUnattached() {
  const rows = await getDb()
    .update(privateFiles)
    .set({ deletedAt: new Date() })
    .where(and(inArray(privateFiles.uploadedBy, userIds), sql`${privateFiles.deletedAt} is null`))
    .returning({ storageKey: privateFiles.storageKey });
  for (const row of rows) await defaultDeps().store.delete(row.storageKey);
}

describe("private files — routes, sweep and check (Postgres + s3mock)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("files integration tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    // The public fake key from apps/web/.env.example.
    process.env.PRIVATE_FILES_KEY = "Y2hlcnJpby1sb2NhbC1kZXYta2V5LW5vdC1zZWNyZXQ=";

    await getDb().execute(sql`select 1`);
    // s3mock (a JVM) may still be starting in CI: wait up to 30 s, then fail — never skip.
    for (let attempt = 1; ; attempt++) {
      try {
        await defaultDeps().store.check();
        break;
      } catch (error) {
        if (attempt === 30) {
          throw new Error("files integration tests need s3mock on 127.0.0.1:9090 (docker compose up -d)", {
            cause: error,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    ({ id: userId, cookie: userCookie } = await createUser("user"));
    ({ cookie: otherCookie } = await createUser("other"));
    ({ id: adminId, cookie: adminCookie } = await createUser("admin", true));
  }, 60_000);

  beforeEach(() => filesRateLimiter.reset());

  afterAll(async () => {
    const db = getDb();
    const rows = await db.select().from(privateFiles).where(inArray(privateFiles.uploadedBy, userIds));
    for (const row of rows) await defaultDeps().store.delete(row.storageKey);
    await db.delete(privateFiles).where(inArray(privateFiles.uploadedBy, userIds));
    await db.delete(schema.kybSubmissions).where(inArray(schema.kybSubmissions.submittedBy, userIds));
    await db.delete(schema.organizations).where(eq(schema.organizations.name, "Files test organisation"));
    await db.delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
    await db.delete(schema.adminMfa).where(inArray(schema.adminMfa.userId, userIds));
    await db.delete(schema.userRoles).where(inArray(schema.userRoles.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
    await db.$client.end();
  });

  it("upload: the object in the bucket is not the plaintext; the row describes the plaintext", async () => {
    const res = await upload(await uploadRequest(userCookie, pdf, { name: "Jane Doe passport.pdf" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; kind: string; sizeBytes: number };
    expect(body).toEqual({ id: body.id, kind: "KYB_STATUTE", sizeBytes: pdf.length });

    const object = await storedObject(body.id);
    expect(object).not.toBeNull();
    expect(object!.includes(pdf.subarray(0, 8))).toBe(false); // "%PDF-1.7"
    expect(object!.includes(Buffer.from("generated dummy statute"))).toBe(false);

    const row = await fileRow(body.id);
    expect(row).toMatchObject({
      storageKey: `kyb/unassigned/${body.id}`, // no file name, no user input
      mimeType: "application/pdf",
      sizeBytes: pdf.length,
      uploadedBy: userId,
      kybSubmissionId: null,
      deletedAt: null,
    });
  });

  it("admin download returns the original bytes as an attachment and writes audit_log", async () => {
    const id = await uploadOk(userCookie, png);
    const res = await downloadAs(adminCookie, id);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="kyb_statute-${id.slice(-8)}.png"`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const audit = await getDb().select().from(auditLog).where(eq(auditLog.entityId, id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorUserId: adminId,
      action: "private_file.download",
      entityType: "private_file",
      data: { kind: "KYB_STATUTE" },
    });
  });

  it("download by the uploader, another user or nobody is 404 and is not audited", async () => {
    const id = await uploadOk(userCookie);
    for (const cookie of [userCookie, otherCookie, null]) {
      const res = await downloadAs(cookie, id);
      expect(res.status).toBe(404);
      expect((await res.arrayBuffer()).byteLength).toBe(0);
    }
    expect(await getDb().select().from(auditLog).where(eq(auditLog.entityId, id))).toHaveLength(0);
  });

  it("upload is refused: anonymous 401, no Content-Length 411, too large 413, wrong type 400", async () => {
    const before = await getDb().select().from(privateFiles).where(inArray(privateFiles.uploadedBy, userIds));
    const expectError = async (request: Request, status: number, error: string) => {
      const res = await upload(request);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
    };
    await expectError(await uploadRequest(null, pdf), 401, "unauthorized");
    await expectError(await uploadRequest(userCookie, pdf, { contentLength: null }), 411, "length_required");
    await expectError(
      await uploadRequest(userCookie, pdf, { contentLength: String(MAX_FILE_BYTES + 64 * 1024 + 1) }),
      413,
      "file_too_large"
    );
    // The declared length is small, the real file is over 10 MB: caught after parsing.
    await expectError(
      await uploadRequest(userCookie, Buffer.concat([pdf, Buffer.alloc(MAX_FILE_BYTES)]), { contentLength: "1000" }),
      413,
      "file_too_large"
    );
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    await expectError(await uploadRequest(userCookie, html, { name: "statute.pdf" }), 400, "file_type_not_allowed");

    const after = await getDb().select().from(privateFiles).where(inArray(privateFiles.uploadedBy, userIds));
    expect(after).toHaveLength(before.length);
  });

  it("a user may hold at most 10 unattached files; the refused object is not kept", async () => {
    await clearUnattached();
    for (let i = 0; i < 10; i++) await uploadOk(userCookie);
    const objectsBefore = (await defaultDeps().store.list("kyb/")).length;

    const res = await upload(await uploadRequest(userCookie, pdf));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "too_many_files" });
    expect((await defaultDeps().store.list("kyb/")).length).toBe(objectsBefore);

    await uploadOk(otherCookie); // the limit is per user
    await clearUnattached();
  }, 30_000); // 12 uploads; on a busy machine the default 5 s was exceeded once

  it("only 2 uploads run at once per instance; the next gets 503 with Retry-After", async () => {
    const slots = Array.from({ length: MAX_CONCURRENT_UPLOADS }, () => tryAcquireUploadSlot());
    expect(slots.every((slot) => slot !== null)).toBe(true);
    try {
      const res = await upload(await uploadRequest(userCookie, pdf));
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(await res.json()).toEqual({ error: "busy" });
    } finally {
      slots.forEach((release) => release!());
    }
    await uploadOk(userCookie); // slots were released
  });

  it("delete: not by another user, not when attached; own unattached file → no object, no live row, also after a sweep", async () => {
    const db = getDb();
    const attached = await uploadOk(userCookie);
    const own = await uploadOk(userCookie);

    expect((await removeAs(otherCookie, own)).status).toBe(404);
    expect(await storedObject(own)).not.toBeNull();

    const [org] = await db
      .insert(schema.organizations)
      .values({ source: "REGISTERED", name: "Files test organisation", country: "SI", registry: "NONE" })
      .returning();
    const [submission] = await db
      .insert(schema.kybSubmissions)
      .values({ orgId: org!.id, submittedBy: userId })
      .returning();
    await db.update(privateFiles).set({ kybSubmissionId: submission!.id }).where(eq(privateFiles.id, attached));
    const refused = await removeAs(userCookie, attached);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "file_attached" });
    expect(await storedObject(attached)).not.toBeNull();
    expect((await fileRow(attached))!.deletedAt).toBeNull();

    expect((await removeAs(userCookie, own)).status).toBe(204);
    expect(await storedObject(own)).toBeNull();
    expect((await fileRow(own))!.deletedAt).not.toBeNull();
    expect((await removeAs(userCookie, own)).status).toBe(404); // already deleted

    await sweepPrivateFiles({ db, deps: defaultDeps(), dryRun: false });
    expect(await storedObject(own)).toBeNull();
    expect((await fileRow(own))!.deletedAt).not.toBeNull();
    expect(await storedObject(attached)).not.toBeNull(); // the sweep keeps attached files
  });

  it("sweep: dry run lists and deletes nothing; the real run deletes exactly what was listed", async () => {
    const db = getDb();
    const deps = defaultDeps();
    const fresh = await uploadOk(userCookie);
    const stale = await uploadOk(userCookie);
    const markedDeleted = await uploadOk(userCookie); // row marked, object delete "failed"
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db.update(privateFiles).set({ createdAt: yesterday }).where(eq(privateFiles.id, stale));
    await db.update(privateFiles).set({ deletedAt: new Date() }).where(eq(privateFiles.id, markedDeleted));
    const noRow = "kyb/unassigned/00000000-0000-7000-8000-00000000dead";
    await deps.store.put(noRow, randomBytes(40));
    await deps.store.put("check/not-for-the-sweep", randomBytes(40));

    // Objects count as orphans only when older than 1 h: now, nothing is.
    const tooEarly = await sweepPrivateFiles({ db, deps, dryRun: true });
    expect(tooEarly.orphanObjects).not.toContain(noRow);

    const inTwoHours = new Date(Date.now() + 2 * 60 * 60 * 1000);
    // evidence-db.test.ts writes `evidence/` objects into the same bucket in parallel; the sweep never touches them.
    const keysOf = async () => (await deps.store.list("")).map((o) => o.key).filter((k) => !k.startsWith("evidence/")).sort();
    const keysBefore = await keysOf();
    const dry = await sweepPrivateFiles({ db, deps, dryRun: true, now: inTwoHours });
    expect(dry.staleFiles).toContain(kybStorageKey(stale));
    expect(dry.orphanObjects).toEqual(expect.arrayContaining([noRow, kybStorageKey(markedDeleted)]));
    expect(await keysOf()).toEqual(keysBefore);
    expect((await fileRow(stale))!.deletedAt).toBeNull();

    const real = await sweepPrivateFiles({ db, deps, dryRun: false, now: inTwoHours });
    expect(real.failedDeletes).toBe(0);
    expect([...real.staleFiles].sort()).toEqual([...dry.staleFiles].sort());
    expect([...real.orphanObjects].sort()).toEqual([...dry.orphanObjects].sort());
    expect([...real.rejectedFiles].sort()).toEqual([...dry.rejectedFiles].sort());
    const listed = new Set([...dry.staleFiles, ...dry.rejectedFiles, ...dry.orphanObjects]);
    const keysAfter = new Set((await deps.store.list("")).map((o) => o.key));
    expect(keysBefore.filter((key) => !keysAfter.has(key)).sort()).toEqual([...listed].sort());

    expect((await fileRow(stale))!.deletedAt).not.toBeNull();
    expect(await storedObject(fresh)).not.toBeNull();
    expect((await fileRow(fresh))!.deletedAt).toBeNull();
    expect(keysAfter.has("check/not-for-the-sweep")).toBe(true);
    await deps.store.delete("check/not-for-the-sweep");

    const again = await sweepPrivateFiles({ db, deps, dryRun: false, now: inTwoHours });
    expect([...again.staleFiles, ...again.rejectedFiles, ...again.orphanObjects]).toEqual([]); // idempotent
  });

  /** A file of `owner`, uploaded through the route and attached to a submission with this status. */
  async function attachedFile(
    owner: { id: string; cookie: string },
    status: "PENDING" | "APPROVED" | "REJECTED",
    reviewedDaysAgo?: number,
    claimOf?: string
  ) {
    const db = getDb();
    const orgId =
      claimOf ??
      (
        await db
          .insert(schema.organizations)
          .values({ source: "REGISTERED", name: "Files test organisation", country: "SI", registry: "NONE", kybStatus: status })
          .returning()
      )[0]!.id;
    const [submission] = await db
      .insert(schema.kybSubmissions)
      .values({
        orgId,
        submittedBy: owner.id,
        status,
        reviewNote: status === "REJECTED" ? "Rejected in a test." : null,
        reviewedAt: reviewedDaysAgo === undefined ? null : new Date(Date.now() - reviewedDaysAgo * 24 * 60 * 60 * 1000),
      })
      .returning();
    const fileId = await uploadOk(owner.cookie);
    await db.update(privateFiles).set({ kybSubmissionId: submission!.id }).where(eq(privateFiles.id, fileId));
    return { fileId, orgId, submissionId: submission!.id };
  }
  const isGone = async (fileId: string) =>
    (await storedObject(fileId)) === null && (await fileRow(fileId))!.deletedAt !== null;
  const isKept = async (fileId: string) =>
    (await storedObject(fileId)) !== null && (await fileRow(fileId))!.deletedAt === null;

  it("sweep: files of an application rejected 91 days ago are deleted; 89 days, approved and pending ones are kept", async () => {
    const db = getDb();
    const deps = defaultDeps();
    const owner = { id: userId, cookie: userCookie };
    const old = await attachedFile(owner, "REJECTED", 91);
    const recent = await attachedFile(owner, "REJECTED", 89);
    const approved = await attachedFile(owner, "APPROVED", 400);
    const pending = await attachedFile(await createUser("pending"), "PENDING"); // one pending per user

    const dry = await sweepPrivateFiles({ db, deps, dryRun: true });
    expect(dry.rejectedFiles).toEqual([kybStorageKey(old.fileId)]);
    expect(dry.orphanObjects).not.toContain(kybStorageKey(old.fileId)); // counted once
    expect(await isKept(old.fileId)).toBe(true); // a dry run deletes nothing

    const real = await sweepPrivateFiles({ db, deps, dryRun: false });
    expect(real.rejectedFiles).toEqual([kybStorageKey(old.fileId)]);
    expect(real.failedDeletes).toBe(0);
    expect(await isGone(old.fileId)).toBe(true);
    for (const kept of [recent, approved, pending]) expect(await isKept(kept.fileId)).toBe(true);
    // The submission and its note stay; only the documents go.
    const [submission] = await db.select().from(schema.kybSubmissions).where(eq(schema.kybSubmissions.id, old.submissionId));
    expect(submission).toMatchObject({ status: "REJECTED", reviewNote: "Rejected in a test." });

    expect((await sweepPrivateFiles({ db, deps, dryRun: false })).rejectedFiles).toEqual([]); // idempotent
  });

  it("account erase: unattached files and files of non-approved applications are deleted from storage; approved ones stay; a pending application is closed", async () => {
    const db = getDb();
    const leaving = await createUser("leaving");
    const unattached = await uploadOk(leaving.cookie);
    const rejected = await attachedFile(leaving, "REJECTED", 1);
    const approved = await attachedFile(leaving, "APPROVED", 1);
    const [imported] = await db
      .insert(schema.organizations)
      .values({ source: "IMPORTED", name: "Files test organisation", country: "GB", registry: "NONE", kybStatus: "PENDING" })
      .returning();
    const pendingClaim = await attachedFile(leaving, "PENDING", undefined, imported!.id);
    const someoneElse = await uploadOk(userCookie);

    setPrivyClientForTesting({ deleteUser: vi.fn().mockResolvedValue(undefined) } as unknown as PrivyClient);
    try {
      const res = await eraseAccount(
        new Request(`${ORIGIN}/api/auth/account`, { method: "DELETE", headers: { Origin: ORIGIN, cookie: leaving.cookie } })
      );
      expect(res.status).toBe(200);
    } finally {
      setPrivyClientForTesting(null);
    }

    for (const fileId of [unattached, rejected.fileId, pendingClaim.fileId]) expect(await isGone(fileId)).toBe(true);
    expect(await isKept(approved.fileId)).toBe(true); // the organisation's proof of verification
    expect(await isKept(someoneElse)).toBe(true);

    // The pending claim is closed like a rejection, without a note; the imported organisation is back to NONE.
    const [closed] = await db.select().from(schema.kybSubmissions).where(eq(schema.kybSubmissions.id, pendingClaim.submissionId));
    expect(closed).toMatchObject({ status: "REJECTED", reviewNote: null, reviewerId: null });
    expect(closed!.reviewedAt).toBeInstanceOf(Date);
    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, imported!.id));
    expect(org!.kybStatus).toBe("NONE");
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, pendingClaim.submissionId));
    expect(audit).toMatchObject([{ action: "kyb.closed_on_erase", entityType: "kyb_submission", actorUserId: null, data: null }]);
    await db.delete(auditLog).where(eq(auditLog.entityId, pendingClaim.submissionId));
    // The reviewer's note of the earlier rejection is kept.
    const [kept] = await db.select().from(schema.kybSubmissions).where(eq(schema.kybSubmissions.id, rejected.submissionId));
    expect(kept!.reviewNote).toBe("Rejected in a test.");
  });

  it("files:check creates the canary once, verifies it afterwards, and fails with another key", async () => {
    const deps = defaultDeps();
    await deps.store.delete(canaryKey());
    expect(await checkPrivateStorage(deps)).toEqual({ canary: "created" });
    expect(await checkPrivateStorage(deps)).toEqual({ canary: "verified" });
    await expect(checkPrivateStorage({ store: deps.store, key: randomBytes(32) })).rejects.toThrow(
      "PRIVATE_FILES_KEY does not match"
    );
    expect(await deps.store.list("check/probe-")).toEqual([]); // probes are always removed
    expect(canaryKey()).toBe("check/canary-v1");
  });

  it("every error code of the file routes has a next-intl message", () => {
    expect(Object.keys(messages.files.errors).sort()).toEqual([...FILES_ERROR_CODES].sort());
  });
});
