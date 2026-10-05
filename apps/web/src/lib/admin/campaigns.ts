import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { campaigns, organizations, type Database } from "@cherrio/db";
import { containsPattern, PAGE_SIZE, type Cursor } from "./listing";
import { afterCursor, sortKey } from "./organizations";

// Admin overview of campaigns (TASK-029 §3). Each view is a status with the
// order that suits its work: queues oldest first, history newest first.

export const CAMPAIGN_VIEWS = ["review", "publish", "live", "rejected", "drafts", "all"] as const;
export type CampaignView = (typeof CAMPAIGN_VIEWS)[number];

const VIEWS = {
  review: { status: "PENDING_REVIEW", column: campaigns.submittedAt, direction: "asc" },
  publish: { status: "APPROVED", column: campaigns.reviewedAt, direction: "asc" },
  live: { status: "DEPLOYED", column: campaigns.deployedAt, direction: "desc" },
  rejected: { status: "REJECTED", column: campaigns.reviewedAt, direction: "desc" },
  drafts: { status: "DRAFT", column: campaigns.updatedAt, direction: "desc" },
  all: { status: null, column: campaigns.createdAt, direction: "desc" },
} as const;

export interface CampaignFilters {
  view: CampaignView;
  q: string;
  country: string;
}

/** One page of campaigns for a view; `next` is the cursor of the following page (or null). */
export async function listCampaigns(db: Database, filters: CampaignFilters, cursor: Cursor | null) {
  const view = VIEWS[filters.view];
  // The view's date, falling back to creation so the key is never null.
  const sortExpr = sql`coalesce(${view.column}, ${campaigns.createdAt})`;
  const pattern = filters.q ? containsPattern(filters.q) : null;
  const order = view.direction === "asc" ? asc : desc;

  const rows = await db
    .select({
      id: campaigns.id,
      title: campaigns.title,
      status: campaigns.status,
      country: campaigns.country,
      targetEurCents: campaigns.targetEurCents,
      targetUsdc: campaigns.targetUsdc,
      publishTxHash: campaigns.publishTxHash,
      onchainAddress: campaigns.onchainAddress,
      organization: organizations.name,
      organizationId: organizations.id,
      date: sql<Date>`${sortExpr}`.mapWith(campaigns.createdAt),
      key: sortKey(sortExpr),
    })
    .from(campaigns)
    // Left join: a campaign for an individual has no organisation (org_id null) and must still be listed.
    .leftJoin(organizations, eq(organizations.id, campaigns.orgId))
    .where(
      and(
        view.status ? eq(campaigns.status, view.status) : undefined,
        filters.country ? eq(campaigns.country, filters.country) : undefined,
        pattern ? or(ilike(campaigns.title, pattern), ilike(organizations.name, pattern)) : undefined,
        afterCursor(sortExpr, campaigns.id, view.direction, cursor)
      )
    )
    .orderBy(order(sortExpr), order(campaigns.id))
    .limit(PAGE_SIZE + 1);

  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  return { rows: page, next: rows.length > PAGE_SIZE && last ? { key: last.key, id: last.id } : null };
}

/** Number of campaigns per view, for the tabs and the admin home. */
export async function campaignCounts(db: Database): Promise<Record<CampaignView, number>> {
  const rows = await db.select({ status: campaigns.status, n: count() }).from(campaigns).groupBy(campaigns.status);
  const by = Object.fromEntries(rows.map((row) => [row.status, row.n])) as Record<string, number>;
  return {
    review: by.PENDING_REVIEW ?? 0,
    publish: by.APPROVED ?? 0,
    live: by.DEPLOYED ?? 0,
    rejected: by.REJECTED ?? 0,
    drafts: by.DRAFT ?? 0,
    all: rows.reduce((sum, row) => sum + row.n, 0),
  };
}
