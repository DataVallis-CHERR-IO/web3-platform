import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  auditLog,
  kybSubmissions,
  organizations,
  orgMembers,
  privateFiles,
  type Database,
} from "@cherrio/db";
import {
  kybDocumentsComplete,
  type OrganizationApplication,
  type OrganizationApplicationData,
} from "@cherrio/shared";

// Submitting an organisation application (TASK-008b) — one transaction:
// organisation (new, claimed or resubmitted) → membership → submission → files → audit.

export type ApplicationRefusal =
  | "application_pending"
  | "organization_exists"
  | "resubmission_not_allowed"
  | "files_invalid";

/** The application is valid but cannot be accepted; nothing was written. */
export class ApplicationRefusedError extends Error {
  constructor(public readonly code: ApplicationRefusal) {
    super(code);
    this.name = "ApplicationRefusedError";
  }
}

export interface ApplicationResult {
  organizationId: string;
  submissionId: string;
  /** `apply` = new organisation, `claim` = imported organisation, `resubmit` = after a rejection. */
  kind: "apply" | "claim" | "resubmit";
}

const UNIQUE_VIOLATIONS: Record<string, ApplicationRefusal> = {
  kyb_submissions_one_pending_per_submitter: "application_pending",
  organizations_registry_registry_id_uniq: "organization_exists",
};

/** A unique violation from a parallel request means the same as the check that lost the race. */
function refusalFromUniqueViolation(error: unknown): ApplicationRefusal | undefined {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const pg = candidate as { code?: string; constraint_name?: string } | null | undefined;
    if (pg?.code === "23505" && pg.constraint_name) return UNIQUE_VIOLATIONS[pg.constraint_name];
  }
  return undefined;
}

export async function submitOrganizationApplication(
  db: Database,
  userId: string,
  input: OrganizationApplication,
  ip?: string
): Promise<ApplicationResult> {
  const { fileIds, registry, registryId, organizationId, ...application } = input;
  const data: OrganizationApplicationData = application;
  const refuse = (code: ApplicationRefusal): never => {
    throw new ApplicationRefusedError(code);
  };

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);

      const [pending] = await tx
        .select({ id: kybSubmissions.id })
        .from(kybSubmissions)
        .where(and(eq(kybSubmissions.submittedBy, userId), eq(kybSubmissions.status, "PENDING")))
        .limit(1);
      if (pending) refuse("application_pending");

      // The organisation this application is about, locked until the end of the transaction.
      const target = organizationId
        ? eq(organizations.id, organizationId)
        : registryId !== undefined
          ? and(eq(organizations.registry, registry), eq(organizations.registryId, registryId))
          : undefined;
      const [existing] = target ? await tx.select().from(organizations).where(target).for("update").limit(1) : [];

      let kind: ApplicationResult["kind"];
      let orgId: string;
      if (!existing) {
        if (organizationId) refuse("resubmission_not_allowed");
        // New organisation: the row is created from the form. It is not public while PENDING.
        const [created] = await tx
          .insert(organizations)
          .values({ ...data, source: "REGISTERED", registry, registryId: registryId ?? null, kybStatus: "PENDING" })
          .returning({ id: organizations.id });
        orgId = created!.id;
        kind = "apply";
      } else {
        const [membership] = await tx
          .select({ role: orgMembers.role })
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, existing.id), eq(orgMembers.userId, userId)))
          .limit(1);
        const open = existing.kybStatus === "NONE" || existing.kybStatus === "REJECTED";
        const sameIdentity = existing.registry === registry && existing.registryId === (registryId ?? null);

        // An unclaimed imported organisation is claimed — also by "Submit again" (with its id)
        // after a rejected claim, which put it back to NONE and removed the membership.
        const claimable = open && existing.source === "IMPORTED" && existing.claimedByUserId === null;
        if (claimable && (!organizationId || (existing.kybStatus === "NONE" && sameIdentity))) {
          kind = "claim";
        } else if (existing.kybStatus === "REJECTED" && membership?.role === "ORG_ADMIN" && sameIdentity) {
          kind = "resubmit";
        } else {
          return refuse(organizationId ? "resubmission_not_allowed" : "organization_exists");
        }
        // Claim and resubmission: the row keeps its public data until a reviewer
        // approves; the new data lives in the submission (`application`).
        await tx.update(organizations).set({ kybStatus: "PENDING" }).where(eq(organizations.id, existing.id));
        orgId = existing.id;
      }

      await tx.insert(orgMembers).values({ orgId, userId, role: "ORG_ADMIN" }).onConflictDoNothing();

      const [submission] = await tx
        .insert(kybSubmissions)
        .values({ orgId, submittedBy: userId, application: data })
        .returning({ id: kybSubmissions.id });

      // Only this user's own, unattached, not deleted files — and all of them, or nothing.
      const files = await tx
        .select({ id: privateFiles.id, kind: privateFiles.kind })
        .from(privateFiles)
        .where(
          and(
            inArray(privateFiles.id, fileIds),
            eq(privateFiles.uploadedBy, userId),
            isNull(privateFiles.kybSubmissionId),
            isNull(privateFiles.deletedAt)
          )
        )
        .for("update");
      if (files.length !== fileIds.length || !kybDocumentsComplete(files.map((file) => file.kind))) {
        refuse("files_invalid");
      }
      // Storage keys stay as created: they are part of the encryption (ADR-033).
      await tx
        .update(privateFiles)
        .set({ kybSubmissionId: submission!.id })
        .where(inArray(privateFiles.id, fileIds));

      await tx.insert(auditLog).values({
        actorUserId: userId,
        action: kind === "claim" ? "organization.claim" : "organization.apply",
        entityType: "organization",
        entityId: orgId,
        data: { submissionId: submission!.id, resubmission: kind === "resubmit" },
        ip,
      });

      return { organizationId: orgId, submissionId: submission!.id, kind };
    });
  } catch (error) {
    const refusal = refusalFromUniqueViolation(error);
    if (refusal) throw new ApplicationRefusedError(refusal);
    throw error;
  }
}
