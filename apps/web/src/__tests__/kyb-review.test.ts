import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import messages from "../../messages/en.json";
import { getDb } from "@/lib/db";
import { POST as approveRoute } from "@/app/api/admin/kyb/[submissionId]/approve/route";
import { POST as rejectRoute } from "@/app/api/admin/kyb/[submissionId]/reject/route";
import { applicationRateLimiter } from "@/lib/security/rate-limit";
import { listOwnApplications } from "@/lib/organizations/own-applications";
import { REVIEW_ERROR_CODES } from "@/lib/organizations/review-route";
import {
  cleanUp, createImportedOrg, createUser, ORIGIN, PAYOUT_ADDRESS, submit, type TestUser,
} from "./helpers/organizations";

// Integration tests for the KYB review: real handlers, real Postgres.

const { organizations, kybSubmissions, orgMembers, auditLog } = schema;
const TAIL = PAYOUT_ADDRESS.slice(-6); // "1BeAed" — the reviewer may type it in any case
const NOTE = "The registration extract is older than three months.";

async function review(
  route: typeof approveRoute,
  reviewer: TestUser | null,
  submissionId: string,
  body: unknown,
  origin = ORIGIN
) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin };
  if (reviewer) headers.cookie = reviewer.cookie;
  const res = await route(
    new Request(`${ORIGIN}/api/admin/kyb/${submissionId}`, { method: "POST", headers, body: JSON.stringify(body) }),
    { params: Promise.resolve({ submissionId }) }
  );
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}
const approve = (reviewer: TestUser | null, id: string, tail = TAIL) =>
  review(approveRoute, reviewer, id, { payoutAddressTail: tail });
const reject = (reviewer: TestUser | null, id: string, note = NOTE) => review(rejectRoute, reviewer, id, { note });

const orgRow = async (id: string) => (await getDb().select().from(organizations).where(eq(organizations.id, id)))[0]!;
const submissionRow = async (id: string) =>
  (await getDb().select().from(kybSubmissions).where(eq(kybSubmissions.id, id)))[0]!;
const membersOf = async (orgId: string) =>
  (await getDb().select().from(orgMembers).where(eq(orgMembers.orgId, orgId))).map((m) => m.userId).sort();
const auditOf = (actorId: string) => getDb().select().from(auditLog).where(eq(auditLog.actorUserId, actorId));

describe("KYB review — approve and reject (Postgres)", () => {
  let admin: TestUser;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("KYB review tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await getDb().execute(sql`select 1`);
    admin = await createUser({ admin: true });
  });
  beforeEach(() => applicationRateLimiter.reset());
  afterAll(cleanUp);

  it("approve a new organisation: APPROVED, reviewer and time recorded, audited without personal data", async () => {
    const applicant = await createUser();
    const sent = await submit(applicant);
    const result = await approve(admin, sent.submissionId!, TAIL.toUpperCase());
    expect(result).toEqual({
      status: 200,
      json: { organizationId: sent.organizationId, claim: false, removedMembers: 0 },
    });

    const submission = await submissionRow(sent.submissionId!);
    expect(submission).toMatchObject({ status: "APPROVED", reviewerId: admin.id, reviewNote: null });
    expect(submission.reviewedAt).toBeInstanceOf(Date);
    expect(await orgRow(sent.organizationId!)).toMatchObject({
      kybStatus: "APPROVED",
      source: "REGISTERED",
      claimedByUserId: null,
      name: sent.body.name,
    });
    const audit = (await auditOf(admin.id)).filter((row) => row.entityId === sent.submissionId);
    expect(audit).toMatchObject([{ action: "kyb.approve", entityType: "kyb_submission" }]);
    expect(audit[0]!.data).toEqual({ organizationId: sent.organizationId, claim: false, removedMembers: 0 });
  });

  it("approve a claim: the application is applied to the row, source and claimant change, unverified admins are removed", async () => {
    const imported = await createImportedOrg();
    const claimant = await createUser();
    const neverVerified = await createUser(); // an earlier claim of theirs was rejected
    const colleague = await createUser(); // a member without any application: not touched
    const target = { registry: "UK_CC", registryId: imported.registryId, country: "GB" };

    const earlier = await submit(neverVerified, target);
    expect((await reject(admin, earlier.submissionId!)).status).toBe(200);
    // Left-over memberships, as they could exist from before the reject rule.
    await getDb().insert(orgMembers).values([
      { orgId: imported.id, userId: neverVerified.id, role: "ORG_ADMIN" },
      { orgId: imported.id, userId: colleague.id, role: "ORG_MEMBER" },
    ]);

    const sent = await submit(claimant, { ...target, name: "Claimed Charity", website: "" });
    expect(sent).toMatchObject({ status: 201, organizationId: imported.id, claim: true });
    expect(await orgRow(imported.id)).toMatchObject({ name: imported.name, kybStatus: "PENDING" });

    const result = await approve(admin, sent.submissionId!);
    expect(result.json).toEqual({ organizationId: imported.id, claim: true, removedMembers: 1 });
    expect(await orgRow(imported.id)).toMatchObject({
      kybStatus: "APPROVED",
      source: "REGISTERED",
      claimedByUserId: claimant.id,
      name: "Claimed Charity",
      legalName: sent.body.legalName,
      country: "GB",
      website: null, // the application had none: the imported website is not kept
      description: sent.body.description,
      causes: sent.body.causes,
      payoutAddress: PAYOUT_ADDRESS.toLowerCase(),
      registry: "UK_CC",
      registryId: imported.registryId,
    });
    expect(await membersOf(imported.id)).toEqual([claimant.id, colleague.id].sort());
    const removed = (await auditOf(admin.id)).filter(
      (row) => row.action === "organization.member_removed" && row.entityId === imported.id
    );
    expect(removed.map((row) => row.data)).toEqual([
      { userId: neverVerified.id, submissionId: earlier.submissionId }, // by the rejection
      { userId: neverVerified.id, submissionId: sent.submissionId }, // by the approval's safety net
    ]);
  });

  it("reject a claim: the imported organisation goes back to NONE unchanged, the claimant loses the membership but still sees the note and can submit again", async () => {
    const imported = await createImportedOrg();
    const claimant = await createUser();
    const sent = await submit(claimant, { registry: "UK_CC", registryId: imported.registryId });
    expect(await membersOf(imported.id)).toEqual([claimant.id]);

    expect(await reject(admin, sent.submissionId!)).toEqual({
      status: 200,
      json: { organizationId: imported.id, claim: true },
    });
    expect(await orgRow(imported.id)).toMatchObject({
      kybStatus: "NONE", // never REJECTED: a false claim must not mark a real charity
      source: "IMPORTED",
      claimedByUserId: null,
      name: imported.name,
      payoutAddress: null,
    });
    expect(await submissionRow(sent.submissionId!)).toMatchObject({
      status: "REJECTED",
      reviewerId: admin.id,
      reviewNote: NOTE,
    });
    expect(await membersOf(imported.id)).toEqual([]);
    const audit = (await auditOf(admin.id)).filter((row) => JSON.stringify(row.data).includes(sent.submissionId!) || row.entityId === sent.submissionId);
    expect(audit.map((row) => row.action).sort()).toEqual(["kyb.reject", "organization.member_removed"]);
    expect(JSON.stringify(audit)).not.toContain(NOTE); // the note is not copied into the log

    // The status page reads the user's submissions, not memberships.
    const own = await listOwnApplications(getDb(), claimant.id);
    expect(own).toMatchObject([
      { orgId: imported.id, status: "REJECTED", reviewNote: NOTE, canResubmit: true, name: imported.name },
    ]);

    // "Submit again" (with the organisation id) is a new claim.
    const again = await submit(claimant, { registry: "UK_CC", registryId: imported.registryId, organizationId: imported.id });
    expect(again).toMatchObject({ status: 201, organizationId: imported.id, claim: true });
    expect(await membersOf(imported.id)).toEqual([claimant.id]);
    expect((await listOwnApplications(getDb(), claimant.id))[0]).toMatchObject({ status: "PENDING", canResubmit: false });
    // With an id, register and number must be the organisation's own.
    await reject(admin, again.submissionId!);
    const wrong = await submit(claimant, { registry: "UK_CC", registryId: "something-else", organizationId: imported.id });
    expect(wrong).toMatchObject({ status: 409, error: "resubmission_not_allowed" });
  });

  it("reject a new organisation, resubmit, approve: REJECTED keeps the membership, and the row takes the resubmitted values", async () => {
    const applicant = await createUser();
    const first = await submit(applicant);
    expect((await reject(admin, first.submissionId!)).json).toEqual({ organizationId: first.organizationId, claim: false });
    expect(await orgRow(first.organizationId!)).toMatchObject({ kybStatus: "REJECTED", name: first.body.name });
    expect(await membersOf(first.organizationId!)).toEqual([applicant.id]);
    expect(await listOwnApplications(getDb(), applicant.id)).toMatchObject([{ status: "REJECTED", canResubmit: true }]);

    const second = await submit(applicant, {
      registryId: first.body.registryId,
      organizationId: first.organizationId,
      name: "Test Animal Shelter (corrected)",
    });
    expect(second).toMatchObject({ status: 201, organizationId: first.organizationId });
    expect(await orgRow(first.organizationId!)).toMatchObject({ kybStatus: "PENDING", name: first.body.name });

    expect((await approve(admin, second.submissionId!)).status).toBe(200);
    expect(await orgRow(first.organizationId!)).toMatchObject({
      kybStatus: "APPROVED",
      name: "Test Animal Shelter (corrected)",
    });
    const statuses = await getDb().select().from(kybSubmissions).where(eq(kybSubmissions.orgId, first.organizationId!));
    expect(statuses.map((s) => s.status).sort()).toEqual(["APPROVED", "REJECTED"]);

    // A later rejected submission of an approved organisation does not take the approval away.
    const [late] = await getDb()
      .insert(kybSubmissions)
      .values({ orgId: first.organizationId!, submittedBy: applicant.id, application: second.body })
      .returning();
    expect((await reject(admin, late!.id)).status).toBe(200);
    expect((await orgRow(first.organizationId!)).kybStatus).toBe("APPROVED");
  });

  it("refused, with nothing written: own organisation, wrong address ending, short note, incomplete application, already reviewed", async () => {
    const applicant = await createUser({ admin: true }); // an admin who applies
    const orgAdmin = await createUser({ admin: true }); // an admin who is ORG_ADMIN of that organisation
    const sent = await submit(applicant);
    const orgMember = await createUser({ admin: true }); // an admin who is a plain member of it
    await getDb().insert(orgMembers).values([
      { orgId: sent.organizationId!, userId: orgAdmin.id, role: "ORG_ADMIN" },
      { orgId: sent.organizationId!, userId: orgMember.id, role: "ORG_MEMBER" },
    ]);
    const id = sent.submissionId!;

    const attempts = [
      [await approve(applicant, id), 409, "self_review"],
      [await reject(applicant, id), 409, "self_review"],
      [await approve(orgAdmin, id), 409, "self_review"],
      [await reject(orgAdmin, id), 409, "self_review"],
      [await approve(orgMember, id), 409, "self_review"],
      [await reject(orgMember, id), 409, "self_review"],
      [await approve(admin, id, "abcdef"), 409, "payout_address_mismatch"],
      [await approve(admin, id, "ed"), 400, "validation_failed"],
      [await reject(admin, id, "too short"), 400, "validation_failed"],
    ] as const;
    for (const [result, status, error] of attempts) expect(result).toEqual({ status, json: { error } });
    expect(await submissionRow(id)).toMatchObject({ status: "PENDING", reviewerId: null, reviewedAt: null, reviewNote: null });
    expect((await orgRow(sent.organizationId!)).kybStatus).toBe("PENDING");
    for (const user of [applicant, orgAdmin, orgMember]) {
      expect((await auditOf(user.id)).filter((row) => row.action.startsWith("kyb."))).toEqual([]);
    }

    // ADR-054: an application from a sanctioned country (one stored before the form refused it) is never approved.
    const [stored] = await getDb().select({ application: kybSubmissions.application }).from(kybSubmissions).where(eq(kybSubmissions.id, id));
    await getDb().update(kybSubmissions).set({ application: { ...(stored!.application as object), country: "RU" } }).where(eq(kybSubmissions.id, id));
    expect(await approve(admin, id)).toEqual({ status: 409, json: { error: "sanctioned_country" } });
    expect((await submissionRow(id)).status).toBe("PENDING");

    // An application without usable data (e.g. a row from before the column existed).
    await getDb().update(kybSubmissions).set({ application: {} }).where(eq(kybSubmissions.id, id));
    expect(await approve(admin, id)).toEqual({ status: 409, json: { error: "application_invalid" } });
    expect((await submissionRow(id)).status).toBe("PENDING");

    expect((await reject(admin, id)).status).toBe(200);
    expect(await approve(admin, id)).toEqual({ status: 409, json: { error: "not_pending" } });
    expect(await reject(admin, id)).toEqual({ status: 409, json: { error: "not_pending" } });
    expect(await submissionRow(id)).toMatchObject({ status: "REJECTED", reviewNote: NOTE });
  });

  it("anyone who is not a platform admin gets 404 and nothing happens; a foreign origin is refused", async () => {
    const applicant = await createUser();
    const stranger = await createUser();
    const sent = await submit(applicant);
    for (const who of [stranger, applicant, null]) {
      expect(await approve(who, sent.submissionId!)).toEqual({ status: 404, json: null });
      expect(await reject(who, sent.submissionId!)).toEqual({ status: 404, json: null });
    }
    expect(await approve(admin, schema.newId())).toEqual({ status: 404, json: null });
    expect(await approve(admin, "not-a-uuid")).toEqual({ status: 404, json: null });

    process.env.APP_ENV = "dev";
    try {
      expect(await approve(admin, sent.submissionId!)).toEqual({ status: 403, json: { error: "forbidden" } });
    } finally {
      process.env.APP_ENV = "local";
    }
    expect(await submissionRow(sent.submissionId!)).toMatchObject({ status: "PENDING", reviewerId: null });
    const members = await getDb()
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, sent.organizationId!), eq(orgMembers.userId, applicant.id)));
    expect(members).toHaveLength(1);
  });

  it("every error code of the review routes has a next-intl message", () => {
    expect(Object.keys(messages.admin.kyb.errors).sort()).toEqual([...REVIEW_ERROR_CODES].sort());
  });
});
