import { and, desc, eq } from "drizzle-orm";
import { kybSubmissions, organizations, orgMembers, type Database } from "@cherrio/db";

/** The user's latest application for one organisation, as shown on /account/organization. */
export interface OwnApplication {
  orgId: string;
  /** The organisation's current (public) name. */
  name: string;
  registry: (typeof organizations.$inferSelect)["registry"];
  registryId: string | null;
  status: (typeof kybSubmissions.$inferSelect)["status"];
  reviewNote: string | null;
  createdAt: Date;
  /** What the user submitted (see kyb_submissions.application). */
  application: unknown;
  /** "Submit again" is possible: see `listOwnApplications`. */
  canResubmit: boolean;
}

/**
 * The user's own applications, newest first, one per organisation. It reads the
 * user's submissions, not memberships: after a rejected claim the membership is
 * removed, and the user must still see the rejection and the reviewer's note.
 *
 * `canResubmit`: the latest application was rejected, nothing of the user is
 * pending, and the organisation can take a new one from this user — either a
 * rejected organisation they administer, or an imported, unclaimed organisation
 * that is back to NONE after their rejected claim.
 */
export async function listOwnApplications(db: Database, userId: string): Promise<OwnApplication[]> {
  const rows = await db
    .select({
      orgId: organizations.id,
      name: organizations.name,
      registry: organizations.registry,
      registryId: organizations.registryId,
      orgStatus: organizations.kybStatus,
      source: organizations.source,
      claimedByUserId: organizations.claimedByUserId,
      memberRole: orgMembers.role,
      status: kybSubmissions.status,
      reviewNote: kybSubmissions.reviewNote,
      createdAt: kybSubmissions.createdAt,
      application: kybSubmissions.application,
    })
    .from(kybSubmissions)
    .innerJoin(organizations, eq(organizations.id, kybSubmissions.orgId))
    .leftJoin(orgMembers, and(eq(orgMembers.orgId, organizations.id), eq(orgMembers.userId, userId)))
    .where(eq(kybSubmissions.submittedBy, userId))
    .orderBy(desc(kybSubmissions.createdAt));

  const latest = rows.filter((row, index) => rows.findIndex((r) => r.orgId === row.orgId) === index);
  const hasPending = latest.some((row) => row.status === "PENDING");
  return latest.map(({ orgStatus, source, claimedByUserId, memberRole, ...row }) => ({
    ...row,
    canResubmit:
      row.status === "REJECTED" &&
      !hasPending &&
      ((orgStatus === "REJECTED" && memberRole === "ORG_ADMIN") ||
        (orgStatus === "NONE" && source === "IMPORTED" && claimedByUserId === null)),
  }));
}
