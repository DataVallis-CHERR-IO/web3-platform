import { and, count, desc, eq, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { campaigns, organizations, type Database } from "@cherrio/db";
import type { Status } from "@cherrio/ui";
import { containsText, PAGE_SIZE, type Cursor } from "./listing";

// Admin overview of organisations (TASK-029 §3).

/** Status chip per KYB status (the word next to it comes from next-intl). */
export const KYB_CHIP: Record<string, Status> = {
  NONE: "pending",
  PENDING: "in-review",
  APPROVED: "verified",
  REJECTED: "rejected",
};

export const KYB_FILTERS = ["all", "PENDING", "APPROVED", "REJECTED", "NONE"] as const;
export const SOURCE_FILTERS = ["all", "REGISTERED", "IMPORTED"] as const;
export type KybFilter = (typeof KYB_FILTERS)[number];
export type SourceFilter = (typeof SOURCE_FILTERS)[number];

/** Timestamp as UTC text with microseconds — the cursor key (see listing.ts). */
export const sortKey = (expr: SQL | AnyPgColumn) =>
  sql<string>`to_char((${expr}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Rows strictly after the cursor in the order (expr, id) `direction`. */
export function afterCursor(expr: SQL | AnyPgColumn, id: AnyPgColumn, direction: "asc" | "desc", cursor: Cursor | null) {
  if (!cursor?.key) return undefined;
  return direction === "asc"
    ? sql`(${expr}, ${id}) > (${cursor.key}::timestamptz, ${cursor.id}::uuid)`
    : sql`(${expr}, ${id}) < (${cursor.key}::timestamptz, ${cursor.id}::uuid)`;
}

export interface OrganizationFilters {
  q: string;
  kyb: KybFilter;
  source: SourceFilter;
  country: string;
}

/** One page of organisations, newest first; `next` is the cursor of the following page (or null). */
export async function listOrganizations(db: Database, filters: OrganizationFilters, cursor: Cursor | null) {
  const q = filters.q || null;
  const campaignCount = db
    .select({ orgId: campaigns.orgId, n: count().as("n") })
    .from(campaigns)
    .groupBy(campaigns.orgId)
    .as("campaign_count");

  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      legalName: organizations.legalName,
      country: organizations.country,
      registry: organizations.registry,
      registryId: organizations.registryId,
      kybStatus: organizations.kybStatus,
      source: organizations.source,
      claimed: sql<boolean>`${organizations.claimedByUserId} is not null`,
      createdAt: organizations.createdAt,
      campaigns: sql<number>`coalesce(${campaignCount.n}, 0)::int`,
      key: sortKey(organizations.createdAt),
    })
    .from(organizations)
    .leftJoin(campaignCount, eq(campaignCount.orgId, organizations.id))
    .where(
      and(
        filters.kyb !== "all" ? eq(organizations.kybStatus, filters.kyb) : undefined,
        filters.source !== "all" ? eq(organizations.source, filters.source) : undefined,
        filters.country ? eq(organizations.country, filters.country) : undefined,
        q
          ? or(
              containsText(organizations.name, q),
              containsText(organizations.legalName, q),
              containsText(organizations.registryId, q)
            )
          : undefined,
        afterCursor(organizations.createdAt, organizations.id, "desc", cursor)
      )
    )
    .orderBy(desc(organizations.createdAt), desc(organizations.id))
    .limit(PAGE_SIZE + 1);

  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  return { rows: page, next: rows.length > PAGE_SIZE && last ? { key: last.key, id: last.id } : null };
}

/** Counts per KYB status, for the filter tabs and the admin home. */
export async function organizationCounts(db: Database): Promise<Record<KybFilter, number>> {
  const rows = await db
    .select({ status: organizations.kybStatus, n: count() })
    .from(organizations)
    .groupBy(organizations.kybStatus);
  const counts = { all: 0, PENDING: 0, APPROVED: 0, REJECTED: 0, NONE: 0 } as Record<KybFilter, number>;
  for (const row of rows) {
    counts[row.status as KybFilter] = row.n;
    counts.all += row.n;
  }
  return counts;
}
