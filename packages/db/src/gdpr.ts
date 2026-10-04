import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Database } from "./index.js";
import {
  auditLog,
  kybSubmissions,
  kycChecks,
  organizations,
  orgMembers,
  privateFiles,
  ratings,
  userAddresses,
  userRoles,
  users,
} from "./schema/index.js";

export interface EraseUserResult {
  /**
   * Storage keys of private files that were marked deleted. The caller deletes
   * these objects AFTER the transaction has committed; an object that cannot be
   * deleted is left for `files:sweep` (its row is already marked).
   */
  storageKeys: string[];
}

/**
 * Hard-erase personal data for a user (GDPR right-to-erasure).
 *
 * Runs in a single transaction:
 * - Nulls email, privy_did, and sets display_name = "Deleted user"
 * - Hard-deletes user_addresses (personal: links person to on-chain address)
 * - Hard-deletes user_roles (revokes all platform-level roles immediately)
 * - Hard-deletes org_members (revokes all organisation memberships)
 * - Hard-deletes kyc_checks (Sumsub applicant reference)
 * - Nulls audit_log.ip for all rows where actor_user_id = userId
 * - Nulls ratings.signature (EIP-712 signature identifies the signer)
 * - Closes the user's PENDING KYB submission: REJECTED without a note
 *   (reviewed_at = now, no reviewer). A claim puts the imported organisation
 *   back to NONE; a new organisation becomes REJECTED (it stays APPROVED if an
 *   earlier submission was approved). Audited as `kyb.closed_on_erase` with the
 *   submission id only.
 * - Private files (ADR-034): marks deleted (deleted_at) the user's unattached
 *   files and the files of their non-approved submissions, and returns their
 *   storage keys — see EraseUserResult.
 *
 * Kept:
 *   - points_ledger, ratings (content + stars stay for org Trust Score),
 *     pseudonymous by user_id
 *   - files of APPROVED submissions: they are the organisation's proof of
 *     verification and are kept while the organisation is on CHERR.IO
 *   - kyb_submissions rows and their review_note: the note describes the
 *     organisation, not the person
 *
 * @param db    A Drizzle Database instance (direct connection, not PgBouncer
 *              transaction-pooled, so the transaction round-trips correctly).
 * @param userId UUID of the user to erase.
 */
export async function eraseUser(db: Database, userId: string): Promise<EraseUserResult> {
  return db.transaction(async (tx) => {
    // 1. Anonymise the user record
    await tx
      .update(users)
      .set({ displayName: "Deleted user", email: null, privyDid: null })
      .where(eq(users.id, userId));

    // 2. Remove address-to-person linkage (personal data per ADR-014)
    await tx.delete(userAddresses).where(eq(userAddresses.userId, userId));

    // 3. Close pending KYB submissions: nobody is left to answer the reviewer.
    const pending = await tx
      .select({ id: kybSubmissions.id, orgId: kybSubmissions.orgId })
      .from(kybSubmissions)
      .where(and(eq(kybSubmissions.submittedBy, userId), eq(kybSubmissions.status, "PENDING")))
      .for("update");
    for (const submission of pending) {
      const [org] = await tx
        .select({ source: organizations.source, claimedByUserId: organizations.claimedByUserId })
        .from(organizations)
        .where(eq(organizations.id, submission.orgId))
        .for("update");
      await tx
        .update(kybSubmissions)
        .set({ status: "REJECTED", reviewedAt: new Date() })
        .where(eq(kybSubmissions.id, submission.id));
      const [approvedEarlier] = await tx
        .select({ id: kybSubmissions.id })
        .from(kybSubmissions)
        .where(and(eq(kybSubmissions.orgId, submission.orgId), eq(kybSubmissions.status, "APPROVED")))
        .limit(1);
      // Same outcome as a reviewer's rejection (apps/web: rejectSubmission).
      const claim = org?.source === "IMPORTED" && org.claimedByUserId === null;
      await tx
        .update(organizations)
        .set({ kybStatus: approvedEarlier ? "APPROVED" : claim ? "NONE" : "REJECTED" })
        .where(eq(organizations.id, submission.orgId));
      await tx.insert(auditLog).values({
        action: "kyb.closed_on_erase",
        entityType: "kyb_submission",
        entityId: submission.id,
      });
    }

    // 4. Revoke all platform roles and org memberships immediately
    await tx.delete(userRoles).where(eq(userRoles.userId, userId));
    await tx.delete(orgMembers).where(eq(orgMembers.userId, userId));

    // 5. Remove KYC check reference (Sumsub applicant ID)
    await tx.delete(kycChecks).where(eq(kycChecks.userId, userId));

    // 6. Strip IP from audit trail for this actor
    await tx
      .update(auditLog)
      .set({ ip: null })
      .where(eq(auditLog.actorUserId, userId));

    // 7. Strip EIP-712 signature from ratings (star + comment kept for Trust Score)
    await tx
      .update(ratings)
      .set({ signature: null })
      .where(eq(ratings.userId, userId));

    // 8. Private files: everything of this user except files of approved submissions
    //    and evidence files, which belong to the campaign's public record (ADR-047).
    const erasable = await tx
      .select({ id: privateFiles.id })
      .from(privateFiles)
      .leftJoin(kybSubmissions, eq(kybSubmissions.id, privateFiles.kybSubmissionId))
      .where(
        and(
          eq(privateFiles.uploadedBy, userId),
          isNull(privateFiles.deletedAt),
          ne(privateFiles.kind, "EVIDENCE"),
          or(isNull(privateFiles.kybSubmissionId), ne(kybSubmissions.status, "APPROVED"))
        )
      );
    const marked = erasable.length
      ? await tx
          .update(privateFiles)
          .set({ deletedAt: new Date() })
          .where(inArray(privateFiles.id, erasable.map((file) => file.id)))
          .returning({ storageKey: privateFiles.storageKey })
      : [];

    return { storageKeys: marked.map((file) => file.storageKey) };
  });
}
