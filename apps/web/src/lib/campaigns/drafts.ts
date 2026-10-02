import { and, count, eq, inArray, like, ne, sql } from "drizzle-orm";
import { auditLog, campaignMedia, campaigns, organizations, orgMembers, type Database } from "@cherrio/db";
import {
  MAX_ACTIVE_CAMPAIGNS_PER_ORG,
  slugify,
  type CampaignDraft,
  type CampaignStory,
} from "@cherrio/shared";

// Campaign drafts (TASK-010): an ORG_ADMIN of an APPROVED organisation prepares
// a campaign, edits it while it is DRAFT or REJECTED, and submits it for review.

export type DraftRefusal =
  | "not_found"
  | "organization_not_approved"
  | "not_editable"
  | "cover_required"
  | "too_many_active";

/** The request is valid but cannot be done; nothing was written. */
export class DraftRefusedError extends Error {
  constructor(public readonly code: DraftRefusal) {
    super(code);
    this.name = "DraftRefusedError";
  }
}

type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
const refuse = (code: DraftRefusal): never => {
  throw new DraftRefusedError(code);
};
const EDITABLE = ["DRAFT", "REJECTED"];

/**
 * Only an ORG_ADMIN of the organisation may work on its campaigns, and only
 * while the organisation is verified. Somebody else's organisation is
 * reported as "not found", so its existence is not revealed.
 */
async function requireOrgAdmin(db: Executor, userId: string, orgId: string): Promise<void> {
  const [row] = await db
    .select({ kybStatus: organizations.kybStatus })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId), eq(orgMembers.role, "ORG_ADMIN")))
    .limit(1);
  if (!row) refuse("not_found");
  if (row!.kybStatus !== "APPROVED") refuse("organization_not_approved");
}

/** The campaign, if this user may work on it (see requireOrgAdmin). */
export async function loadOwnCampaign(db: Executor, userId: string, campaignId: string) {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!campaign?.orgId) return refuse("not_found");
  await requireOrgAdmin(db, userId, campaign.orgId);
  return campaign;
}

/** `base`, or `base-2`, `base-3`, … — whichever no other campaign uses. */
async function freeSlug(db: Executor, title: string, ownId?: string): Promise<string> {
  const base = slugify(title);
  const taken = new Set(
    (
      await db
        .select({ slug: campaigns.slug })
        .from(campaigns)
        .where(and(like(campaigns.slug, `${base}%`), ownId ? ne(campaigns.id, ownId) : undefined))
    ).map((row) => row.slug)
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

const toColumns = (draft: CampaignDraft) => ({
  title: draft.title,
  story: { format: "plain", text: draft.story } satisfies CampaignStory,
  cause: draft.cause,
  country: draft.country,
  targetEurCents: String(BigInt(draft.targetEur) * 100n), // whole euros → integer cents
  durationDays: draft.durationDays,
});

export async function createDraft(
  db: Database,
  userId: string,
  organizationId: string,
  draft: CampaignDraft
): Promise<{ id: string; slug: string }> {
  await requireOrgAdmin(db, userId, organizationId);
  const [created] = await db
    .insert(campaigns)
    .values({
      ...toColumns(draft),
      orgId: organizationId,
      starterUserId: userId,
      beneficiaryType: "ORGANIZATION",
      slug: await freeSlug(db, draft.title),
    })
    .returning({ id: campaigns.id, slug: campaigns.slug });
  return created!;
}

export async function updateDraft(db: Database, userId: string, campaignId: string, draft: CampaignDraft) {
  const campaign = await loadOwnCampaign(db, userId, campaignId);
  if (!EDITABLE.includes(campaign.status)) refuse("not_editable");
  // The slug follows the title until the first submit; after that it never changes.
  const slug = campaign.submittedAt ? campaign.slug : await freeSlug(db, draft.title, campaign.id);
  const updated = await db
    .update(campaigns)
    .set({ ...toColumns(draft), slug })
    .where(and(eq(campaigns.id, campaignId), inArray(campaigns.status, ["DRAFT", "REJECTED"])))
    .returning({ slug: campaigns.slug });
  if (updated.length === 0) refuse("not_editable");
  return { id: campaignId, slug };
}

/** DRAFT or REJECTED → PENDING_REVIEW. Needs a cover image and a free slot among the organisation's active campaigns. */
export async function submitDraft(db: Database, userId: string, campaignId: string, ip?: string): Promise<void> {
  await db.transaction(async (tx) => {
    const campaign = await loadOwnCampaign(tx, userId, campaignId);
    // One submit per organisation at a time, so the limit cannot be passed by parallel requests.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${campaign.orgId}))`);

    const [cover] = await tx
      .select({ id: campaignMedia.id })
      .from(campaignMedia)
      .where(and(eq(campaignMedia.campaignId, campaignId), eq(campaignMedia.kind, "COVER")))
      .limit(1);
    if (!cover) refuse("cover_required");

    const [active] = await tx
      .select({ n: count() })
      .from(campaigns)
      .where(
        and(eq(campaigns.orgId, campaign.orgId!), inArray(campaigns.status, ["PENDING_REVIEW", "APPROVED", "DEPLOYED"]))
      );
    if ((active?.n ?? 0) >= MAX_ACTIVE_CAMPAIGNS_PER_ORG) refuse("too_many_active");

    const submitted = await tx
      .update(campaigns)
      .set({ status: "PENDING_REVIEW", submittedAt: new Date() })
      .where(and(eq(campaigns.id, campaignId), inArray(campaigns.status, ["DRAFT", "REJECTED"])))
      .returning({ id: campaigns.id });
    if (submitted.length === 0) refuse("not_editable");

    await tx.insert(auditLog).values({
      actorUserId: userId,
      action: "campaign.submit",
      entityType: "campaign",
      entityId: campaignId,
      data: { organizationId: campaign.orgId },
      ip,
    });
  });
}
