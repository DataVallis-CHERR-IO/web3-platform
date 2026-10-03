import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { KYB_DOCUMENT_RULES, ORGANIZATION_REGISTRIES } from "@cherrio/shared";
import messages from "../../messages/en.json";
import { getDb } from "@/lib/db";
import { POST as apply } from "@/app/api/organizations/route";
import { signSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { applicationRateLimiter } from "@/lib/security/rate-limit";
import { ORGANIZATION_ERROR_CODES } from "@/lib/organizations/errors";

// Integration tests for POST /api/organizations: real handler, real Postgres.
// Documents are private_files rows inserted directly (no object storage needed).

const ORIGIN = "http://localhost:3000";
const { organizations, kybSubmissions, orgMembers, privateFiles, auditLog, users } = schema;
type FileKind = (typeof schema.privateFileKindEnum.enumValues)[number];

const RUN = Date.now().toString(36); // keeps registry numbers of this run unique
const userIds: string[] = [];
const orgIds: string[] = [];
let n = 0;

async function createUser() {
  const [user] = await getDb()
    .insert(users)
    .values({ displayName: "Org test applicant", privyDid: `privy|org-test-${RUN}-${++n}` })
    .returning();
  userIds.push(user!.id);
  const token = await signSessionToken({ userId: user!.id, roles: [] });
  return { id: user!.id, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

async function createFiles(
  userId: string,
  kinds: FileKind[] = ["KYB_REGISTRATION_EXTRACT", "KYB_AUTHORISATION"]
): Promise<string[]> {
  const rows = kinds.map((kind) => {
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

async function createImportedOrg() {
  const [org] = await getDb()
    .insert(organizations)
    .values({
      source: "IMPORTED",
      name: "Imported Test Charity",
      legalName: "Imported Test Charity Ltd",
      country: "GB",
      registry: "UK_CC",
      registryId: `T${RUN}-${++n}`,
      website: "https://imported.example.org",
      description: "Public data from the registry import.",
      causes: ["humanitarian"],
    })
    .returning();
  orgIds.push(org!.id);
  return org!;
}

function application(fileIds: string[], override: Record<string, unknown> = {}) {
  return {
    name: "Test Animal Shelter",
    legalName: "Test Animal Shelter Society",
    country: "SI",
    registry: "SI_AJPES",
    registryId: `S${RUN}-${++n}`,
    website: "https://shelter.example.org",
    description: "A generated organisation for tests.",
    causes: ["animals", "community"],
    payoutAddress: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    fileIds,
    ...override,
  };
}

async function post(cookie: string | null, body: unknown, origin = ORIGIN) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin };
  if (cookie) headers.cookie = cookie;
  const res = await apply(
    new Request(`${ORIGIN}/api/organizations`, { method: "POST", headers, body: JSON.stringify(body) })
  );
  const json = (await res.json()) as Record<string, unknown>;
  if (typeof json.organizationId === "string") orgIds.push(json.organizationId);
  return { status: res.status, json };
}

const orgRow = async (id: string) => (await getDb().select().from(organizations).where(eq(organizations.id, id)))[0]!;
const submissionsOf = (userId: string) =>
  getDb().select().from(kybSubmissions).where(eq(kybSubmissions.submittedBy, userId));
const fileRows = (ids: string[]) => getDb().select().from(privateFiles).where(inArray(privateFiles.id, ids));
/** Rows a refused application must not have written. */
async function expectNothingWritten(userId: string, fileIds: string[]) {
  expect(await submissionsOf(userId)).toHaveLength(0);
  expect(await getDb().select().from(orgMembers).where(eq(orgMembers.userId, userId))).toHaveLength(0);
  expect(await getDb().select().from(auditLog).where(eq(auditLog.actorUserId, userId))).toHaveLength(0);
  expect((await fileRows(fileIds)).every((file) => file.kybSubmissionId === null)).toBe(true);
}
const reject = (submissionId: string, orgId: string) =>
  getDb().transaction(async (tx) => {
    await tx.update(kybSubmissions).set({ status: "REJECTED" }).where(eq(kybSubmissions.id, submissionId));
    await tx.update(organizations).set({ kybStatus: "REJECTED" }).where(eq(organizations.id, orgId));
  });

describe("POST /api/organizations (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("organisation API tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await getDb().execute(sql`select 1`);
  });

  beforeEach(() => applicationRateLimiter.reset());

  afterAll(async () => {
    const db = getDb();
    await db.delete(privateFiles).where(inArray(privateFiles.uploadedBy, userIds));
    await db.delete(kybSubmissions).where(inArray(kybSubmissions.submittedBy, userIds));
    await db.delete(orgMembers).where(inArray(orgMembers.userId, userIds));
    await db.delete(auditLog).where(inArray(auditLog.actorUserId, userIds));
    if (orgIds.length > 0) await db.delete(organizations).where(inArray(organizations.id, orgIds));
    await db.delete(users).where(inArray(users.id, userIds));
    await db.$client.end();
  });

  it("new organisation: rows in organizations, org_members, kyb_submissions, private_files and audit_log", async () => {
    const user = await createUser();
    const fileIds = await createFiles(user.id, ["KYB_REGISTRATION_EXTRACT", "KYB_AUTHORISATION", "KYB_STATUTE"]);
    const body = application(fileIds);
    const { status, json } = await post(user.cookie, body);
    expect(status).toBe(201);
    expect(json.claim).toBe(false);

    const org = await orgRow(json.organizationId as string);
    expect(org).toMatchObject({
      source: "REGISTERED",
      kybStatus: "PENDING",
      name: body.name,
      country: "SI",
      registry: "SI_AJPES",
      registryId: body.registryId,
      causes: ["animals", "community"],
      payoutAddress: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", // stored lowercase
      claimedByUserId: null,
    });
    const members = await getDb().select().from(orgMembers).where(eq(orgMembers.orgId, org.id));
    expect(members).toMatchObject([{ userId: user.id, role: "ORG_ADMIN" }]);
    const [submission] = await submissionsOf(user.id);
    expect(submission).toMatchObject({ id: json.submissionId, orgId: org.id, status: "PENDING" });
    expect(submission!.application).toMatchObject({ name: body.name, payoutAddress: org.payoutAddress });
    expect(submission!.application).not.toHaveProperty("fileIds");
    const files = await fileRows(fileIds);
    expect(files).toHaveLength(3);
    expect(files.every((file) => file.kybSubmissionId === submission!.id)).toBe(true);
    expect(files.every((file) => file.storageKey === `kyb/unassigned/${file.id}`)).toBe(true); // keys never move
    const audit = await getDb().select().from(auditLog).where(eq(auditLog.actorUserId, user.id));
    expect(audit).toMatchObject([
      { action: "organization.apply", entityType: "organization", entityId: org.id },
    ]);
    expect(audit[0]!.data).toEqual({ submissionId: submission!.id, resubmission: false });
  });

  it("claim of an imported organisation: same row, PENDING, still IMPORTED, public data unchanged", async () => {
    const imported = await createImportedOrg();
    const user = await createUser();
    const fileIds = await createFiles(user.id);
    const body = application(fileIds, { registry: "UK_CC", registryId: imported.registryId, country: "GB" });
    const { status, json } = await post(user.cookie, body);
    expect(status).toBe(201);
    expect(json).toMatchObject({ organizationId: imported.id, claim: true });

    const after = await orgRow(imported.id);
    expect(after).toMatchObject({
      source: "IMPORTED",
      kybStatus: "PENDING",
      claimedByUserId: null,
      name: imported.name,
      legalName: imported.legalName,
      description: imported.description,
      website: imported.website,
      causes: imported.causes,
      payoutAddress: null,
    });
    const [submission] = await submissionsOf(user.id);
    expect(submission!.application).toEqual({
      name: body.name,
      legalName: body.legalName,
      country: "GB",
      website: body.website,
      description: body.description,
      causes: body.causes,
      payoutAddress: body.payoutAddress.toLowerCase(),
    });
    const audit = await getDb().select().from(auditLog).where(eq(auditLog.actorUserId, user.id));
    expect(audit.map((row) => row.action)).toEqual(["organization.claim"]);

    // A second claim while the first is pending is refused, with nothing written.
    const other = await createUser();
    const otherFiles = await createFiles(other.id);
    const second = await post(other.cookie, application(otherFiles, { registry: "UK_CC", registryId: imported.registryId }));
    expect(second).toEqual({ status: 409, json: { error: "organization_exists" } });
    await expectNothingWritten(other.id, otherFiles);

    // A rejected claim puts the organisation back to NONE and removes the claimant's
    // membership (see the review, kyb-review.test.ts). The claimant may then claim
    // again with the organisation id ("Submit again"), and so may a different user.
    const rejectClaim = async (submissionId: string, claimantId: string) => {
      await getDb().update(kybSubmissions).set({ status: "REJECTED" }).where(eq(kybSubmissions.id, submissionId));
      await getDb().update(organizations).set({ kybStatus: "NONE" }).where(eq(organizations.id, imported.id));
      await getDb().delete(orgMembers).where(eq(orgMembers.userId, claimantId));
    };
    await rejectClaim(submission!.id, user.id);
    const again = await post(
      user.cookie,
      application(await createFiles(user.id), { registry: "UK_CC", registryId: imported.registryId, organizationId: imported.id })
    );
    expect(again.status).toBe(201);
    expect(again.json).toMatchObject({ organizationId: imported.id, claim: true });
    await rejectClaim(again.json.submissionId as string, user.id);
    const third = await post(other.cookie, application(otherFiles, { registry: "UK_CC", registryId: imported.registryId }));
    expect(third.status).toBe(201);
    expect(third.json).toMatchObject({ organizationId: imported.id, claim: true });
  });

  it("an organisation that is registered, approved or already claimed is refused and nothing is written", async () => {
    const owner = await createUser();
    const first = application(await createFiles(owner.id));
    expect((await post(owner.cookie, first)).status).toBe(201);
    const approvedImport = await createImportedOrg();
    await getDb().update(organizations).set({ kybStatus: "APPROVED" }).where(eq(organizations.id, approvedImport.id));
    const claimedImport = await createImportedOrg();
    await getDb().update(organizations).set({ claimedByUserId: owner.id }).where(eq(organizations.id, claimedImport.id));

    const user = await createUser();
    const fileIds = await createFiles(user.id);
    const targets = [
      { registry: first.registry, registryId: first.registryId },
      { registry: "UK_CC", registryId: approvedImport.registryId },
      { registry: "UK_CC", registryId: claimedImport.registryId },
    ];
    // Count only this test's registry ids: other test files create organisations in parallel.
    const orgCount = async () =>
      (await getDb().select({ id: organizations.id }).from(organizations)
        .where(inArray(organizations.registryId, targets.map((t) => t.registryId as string)))).length;
    const before = await orgCount();
    expect(before).toBe(3);
    for (const target of targets) {
      expect(await post(user.cookie, application(fileIds, target))).toEqual({
        status: 409,
        json: { error: "organization_exists" }, // no detail about who holds it
      });
    }
    expect(await orgCount()).toBe(before);
    await expectNothingWritten(user.id, fileIds);
  });

  it("a second application while one is pending is refused — by the check and by the unique index", async () => {
    const user = await createUser();
    const first = await post(user.cookie, application(await createFiles(user.id)));
    expect(first.status).toBe(201);
    const secondFiles = await createFiles(user.id);
    expect(await post(user.cookie, application(secondFiles))).toEqual({
      status: 409,
      json: { error: "application_pending" },
    });
    expect(await submissionsOf(user.id)).toHaveLength(1);
    expect((await fileRows(secondFiles)).every((file) => file.kybSubmissionId === null)).toBe(true);

    await expect(
      getDb().insert(kybSubmissions).values({ orgId: first.json.organizationId as string, submittedBy: user.id })
    ).rejects.toMatchObject({ constraint_name: "kyb_submissions_one_pending_per_submitter" });
  });

  it("files: foreign, attached, deleted or incomplete → the whole submit is refused", async () => {
    const user = await createUser();
    const stranger = await createUser();
    const own = await createFiles(user.id);
    const foreign = await createFiles(stranger.id);
    const [deleted] = await createFiles(user.id, ["KYB_AUTHORISATION"]);
    await getDb().update(privateFiles).set({ deletedAt: new Date() }).where(eq(privateFiles.id, deleted!));
    const onlyExtract = await createFiles(user.id, ["KYB_REGISTRATION_EXTRACT", "KYB_STATUTE"]);
    const attachedOwner = await createUser();
    const attached = await createFiles(attachedOwner.id);
    expect((await post(attachedOwner.cookie, application(attached))).status).toBe(201);

    const attempts: [string, string[], string | null][] = [
      ["another user's files", foreign, user.cookie],
      ["one own and one foreign file", [own[0]!, foreign[1]!], user.cookie],
      ["a deleted file", [own[0]!, deleted!], user.cookie],
      ["no authorisation document", onlyExtract, user.cookie],
      ["an id that does not exist", [own[0]!, schema.newId()], user.cookie],
    ];
    const ownOrgs = () =>
      getDb().select().from(organizations).where(eq(organizations.description, `Refused ${user.id}`));
    for (const [label, fileIds, cookie] of attempts) {
      const result = await post(cookie, application(fileIds, { description: `Refused ${user.id}` }));
      expect(result, label).toEqual({ status: 409, json: { error: "files_invalid" } });
    }
    await expectNothingWritten(user.id, [...own, ...foreign, ...onlyExtract]);
    expect(await ownOrgs()).toHaveLength(0); // the organisation insert was rolled back too

    // Files that are already part of a submission cannot be used again (after a rejection).
    const [submission] = await submissionsOf(attachedOwner.id);
    await reject(submission!.id, submission!.orgId);
    const again = await post(attachedOwner.cookie, application(attached));
    expect(again).toEqual({ status: 409, json: { error: "files_invalid" } });
    expect(await submissionsOf(attachedOwner.id)).toHaveLength(1);
  });

  it("resubmission after a rejection: new submission with new files, same organisation, row unchanged", async () => {
    const user = await createUser();
    const firstBody = application(await createFiles(user.id));
    const first = await post(user.cookie, firstBody);
    const orgId = first.json.organizationId as string;
    await reject(first.json.submissionId as string, orgId);

    const newFiles = await createFiles(user.id);
    const secondBody = { ...firstBody, fileIds: newFiles, name: "Test Animal Shelter (corrected)" };
    const second = await post(user.cookie, secondBody);
    expect(second.status).toBe(201);
    expect(second.json).toMatchObject({ organizationId: orgId, claim: false });

    const org = await orgRow(orgId);
    expect(org).toMatchObject({ kybStatus: "PENDING", name: firstBody.name }); // applied on approval (008c)
    const submissions = await submissionsOf(user.id);
    expect(submissions.map((s) => s.status).sort()).toEqual(["PENDING", "REJECTED"]);
    const latest = submissions.find((s) => s.status === "PENDING")!;
    expect(latest.application).toMatchObject({ name: "Test Animal Shelter (corrected)" });
    expect((await fileRows(newFiles)).every((file) => file.kybSubmissionId === latest.id)).toBe(true);
    expect(await getDb().select().from(orgMembers).where(eq(orgMembers.orgId, orgId))).toHaveLength(1);

    // Somebody who is not its ORG_ADMIN cannot resubmit a rejected organisation.
    await reject(latest.id, orgId);
    const stranger = await createUser();
    const strangerFiles = await createFiles(stranger.id);
    expect(await post(stranger.cookie, { ...firstBody, fileIds: strangerFiles })).toEqual({
      status: 409,
      json: { error: "organization_exists" },
    });
    expect(await post(stranger.cookie, { ...firstBody, fileIds: strangerFiles, organizationId: orgId })).toEqual({
      status: 409,
      json: { error: "resubmission_not_allowed" },
    });
    await expectNothingWritten(stranger.id, strangerFiles);
  });

  it("registry NONE: accepted without a registry number; resubmission goes by organizationId", async () => {
    const user = await createUser();
    const body = application(await createFiles(user.id), { registry: "NONE", registryId: "" });
    const first = await post(user.cookie, body);
    expect(first.status).toBe(201);
    const orgId = first.json.organizationId as string;
    expect(await orgRow(orgId)).toMatchObject({ registry: "NONE", registryId: null });

    await reject(first.json.submissionId as string, orgId);
    const again = await post(user.cookie, { ...body, fileIds: await createFiles(user.id), organizationId: orgId });
    expect(again.status).toBe(201);
    expect(again.json.organizationId).toBe(orgId);
  });

  it("refused before the database: anonymous 401, foreign origin 403, invalid body 400 with field names", async () => {
    const user = await createUser();
    const fileIds = await createFiles(user.id);
    expect(await post(null, application(fileIds))).toEqual({ status: 401, json: { error: "unauthorized" } });

    process.env.APP_ENV = "dev";
    try {
      // Outside `local`, a localhost origin is refused.
      expect(await post(user.cookie, application(fileIds))).toEqual({ status: 403, json: { error: "forbidden" } });
    } finally {
      process.env.APP_ENV = "local";
    }

    const invalid = await post(
      user.cookie,
      application(fileIds, { payoutAddress: "0x1234", website: "http://example.org", registryId: "" })
    );
    expect(invalid.status).toBe(400);
    expect(invalid.json.error).toBe("validation_failed");
    expect((invalid.json.fields as string[]).sort()).toEqual(["payoutAddress", "website"]);
    // The registry-number rule spans two fields; zod reports it once the single fields are valid.
    expect(await post(user.cookie, application(fileIds, { registryId: "" }))).toEqual({
      status: 400,
      json: { error: "validation_failed", fields: ["registryId"] },
    });
    await expectNothingWritten(user.id, fileIds);
  });

  it("shared constants match the database enums; every error code has a next-intl message", () => {
    expect([...ORGANIZATION_REGISTRIES]).toEqual(schema.registryTypeEnum.enumValues);
    expect(Object.keys(KYB_DOCUMENT_RULES).sort()).toEqual([...schema.privateFileKindEnum.enumValues].sort());
    expect(Object.keys(messages.organizations.errors).sort()).toEqual([...ORGANIZATION_ERROR_CODES].sort());
  });
});
