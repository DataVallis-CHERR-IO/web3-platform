import { and, eq, inArray, ne } from "drizzle-orm";
import { auditLog, kybSubmissions, organizations, orgMembers, type Database } from "@cherrio/db";
import { isSanctionedCountry, organizationApplicationDataSchema } from "@cherrio/shared";

// Manual KYB review (ADR-012, TASK-008c): a platform admin approves or rejects a
// pending application. Each action is one transaction and is written to audit_log.

export type ReviewRefusal =
  | "not_found"
  | "not_pending"
  | "self_review"
  | "application_invalid"
  | "payout_address_mismatch"
  /** ADR-054: an organisation from a country under EU/US/UN sanctions is never approved. */
  | "sanctioned_country";

/** The review cannot be done; nothing was written. */
export class ReviewRefusedError extends Error {
  constructor(public readonly code: ReviewRefusal) {
    super(code);
    this.name = "ReviewRefusedError";
  }
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
const refuse = (code: ReviewRefusal): never => {
  throw new ReviewRefusedError(code);
};

/** Locks the submission and its organisation and checks that this reviewer may decide it. */
async function lockForReview(tx: Tx, reviewerId: string, submissionId: string) {
  const [submission] = await tx.select().from(kybSubmissions).where(eq(kybSubmissions.id, submissionId)).for("update");
  if (!submission) return refuse("not_found");
  const [organization] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, submission.orgId))
    .for("update");
  if (!organization) return refuse("not_found");
  if (submission.status !== "PENDING") refuse("not_pending");

  // Nobody reviews their own organisation: not the applicant, and not any of its members.
  const [membership] = await tx
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, organization.id), eq(orgMembers.userId, reviewerId)))
    .limit(1);
  if (submission.submittedBy === reviewerId || membership) refuse("self_review");

  const claim = organization.source === "IMPORTED" && organization.claimedByUserId === null;
  return { submission, organization, claim };
}

async function removeMember(tx: Tx, reviewerId: string, orgId: string, userId: string, submissionId: string) {
  const removed = await tx
    .delete(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .returning({ id: orgMembers.id });
  if (removed.length === 0) return false;
  await tx.insert(auditLog).values({
    actorUserId: reviewerId,
    action: "organization.member_removed",
    entityType: "organization",
    entityId: orgId,
    data: { userId, submissionId },
  });
  return true;
}

/**
 * Approve: the application is applied to the organisation row (for a claim or a
 * resubmission the row was not changed before). `payoutAddressTail` is the last
 * six characters of the payout address, typed by the reviewer as a confirmation.
 */
export async function approveSubmission(
  db: Database,
  reviewerId: string,
  submissionId: string,
  payoutAddressTail: string,
  ip?: string
): Promise<{ organizationId: string; claim: boolean; removedMembers: number }> {
  return db.transaction(async (tx) => {
    const { submission, organization, claim } = await lockForReview(tx, reviewerId, submissionId);

    const country = (submission.application as { country?: unknown } | null)?.country;
    if (typeof country === "string" && isSanctionedCountry(country)) refuse("sanctioned_country");
    const parsed = organizationApplicationDataSchema.safeParse(submission.application);
    if (!parsed.success) return refuse("application_invalid");
    const data = parsed.data;
    if (data.payoutAddress.slice(-6) !== payoutAddressTail.trim().toLowerCase()) refuse("payout_address_mismatch");

    await tx
      .update(kybSubmissions)
      .set({ status: "APPROVED", reviewerId, reviewedAt: new Date() })
      .where(eq(kybSubmissions.id, submission.id));
    await tx
      .update(organizations)
      .set({
        ...data,
        website: data.website ?? null,
        kybStatus: "APPROVED",
        ...(claim ? { source: "REGISTERED" as const, claimedByUserId: submission.submittedBy } : {}),
      })
      .where(eq(organizations.id, organization.id));
    await tx
      .insert(orgMembers)
      .values({ orgId: organization.id, userId: submission.submittedBy, role: "ORG_ADMIN" })
      .onConflictDoNothing();

    // Safety net for a claim: other admins whose own applications for this
    // organisation were all rejected never verified, so they lose the membership.
    let removedMembers = 0;
    if (claim) {
      const others = await tx
        .select({ userId: orgMembers.userId })
        .from(orgMembers)
        .where(
          and(
            eq(orgMembers.orgId, organization.id),
            eq(orgMembers.role, "ORG_ADMIN"),
            ne(orgMembers.userId, submission.submittedBy)
          )
        );
      const theirs = others.length
        ? await tx
            .select({ userId: kybSubmissions.submittedBy, status: kybSubmissions.status })
            .from(kybSubmissions)
            .where(
              and(
                eq(kybSubmissions.orgId, organization.id),
                inArray(kybSubmissions.submittedBy, others.map((o) => o.userId))
              )
            )
        : [];
      for (const { userId } of others) {
        const statuses = theirs.filter((s) => s.userId === userId).map((s) => s.status);
        if (statuses.length > 0 && statuses.every((status) => status === "REJECTED")) {
          if (await removeMember(tx, reviewerId, organization.id, userId, submission.id)) removedMembers++;
        }
      }
    }

    await tx.insert(auditLog).values({
      actorUserId: reviewerId,
      action: "kyb.approve",
      entityType: "kyb_submission",
      entityId: submission.id,
      data: { organizationId: organization.id, claim, removedMembers },
      ip,
    });
    return { organizationId: organization.id, claim, removedMembers };
  });
}

/**
 * Reject with a note for the applicant (the note is not copied to audit_log).
 * A new organisation becomes REJECTED. A rejected claim puts the imported
 * organisation back to NONE and removes the claimant's membership, so a false
 * claim never marks a real charity as rejected.
 */
export async function rejectSubmission(
  db: Database,
  reviewerId: string,
  submissionId: string,
  note: string,
  ip?: string
): Promise<{ organizationId: string; claim: boolean }> {
  return db.transaction(async (tx) => {
    const { submission, organization, claim } = await lockForReview(tx, reviewerId, submissionId);

    await tx
      .update(kybSubmissions)
      .set({ status: "REJECTED", reviewerId, reviewNote: note, reviewedAt: new Date() })
      .where(eq(kybSubmissions.id, submission.id));

    const [approvedEarlier] = await tx
      .select({ id: kybSubmissions.id })
      .from(kybSubmissions)
      .where(and(eq(kybSubmissions.orgId, organization.id), eq(kybSubmissions.status, "APPROVED")))
      .limit(1);
    const kybStatus = approvedEarlier ? "APPROVED" : claim ? "NONE" : "REJECTED";
    await tx.update(organizations).set({ kybStatus }).where(eq(organizations.id, organization.id));
    if (claim) await removeMember(tx, reviewerId, organization.id, submission.submittedBy, submission.id);

    await tx.insert(auditLog).values({
      actorUserId: reviewerId,
      action: "kyb.reject",
      entityType: "kyb_submission",
      entityId: submission.id,
      data: { organizationId: organization.id, claim },
      ip,
    });
    return { organizationId: organization.id, claim };
  });
}
