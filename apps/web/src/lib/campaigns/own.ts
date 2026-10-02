import { and, desc, eq } from "drizzle-orm";
import { campaigns, organizations, orgMembers, type Database } from "@cherrio/db";
import { COUNTRY_CODES } from "@cherrio/shared";
import type { Status } from "@cherrio/ui";

/** Status chip per campaign status (the word next to it comes from next-intl). */
export const CAMPAIGN_CHIP: Record<string, Status> = {
  DRAFT: "pending",
  PENDING_REVIEW: "pending",
  REJECTED: "rejected",
  APPROVED: "verified",
  DEPLOYED: "live",
};

/** Approved organisations this user administers — the ones that may start a campaign. */
export async function listCampaignOrganizations(db: Database, userId: string) {
  return db
    .select({ id: organizations.id, name: organizations.name })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(and(eq(orgMembers.userId, userId), eq(orgMembers.role, "ORG_ADMIN"), eq(organizations.kybStatus, "APPROVED")));
}

/** Campaigns of every organisation this user administers, newest first. */
export async function listOwnCampaigns(db: Database, userId: string) {
  return db
    .select({
      id: campaigns.id,
      title: campaigns.title,
      status: campaigns.status,
      createdAt: campaigns.createdAt,
      organization: organizations.name,
    })
    .from(campaigns)
    .innerJoin(organizations, eq(organizations.id, campaigns.orgId))
    .innerJoin(orgMembers, and(eq(orgMembers.orgId, organizations.id), eq(orgMembers.userId, userId)))
    .where(eq(orgMembers.role, "ORG_ADMIN"))
    .orderBy(desc(campaigns.createdAt));
}

/** Country options with names in the page's language. */
export function countryOptions(locale: string) {
  const names = new Intl.DisplayNames([locale], { type: "region" });
  return COUNTRY_CODES.map((value) => ({ value, label: names.of(value) ?? value })).sort((a, b) =>
    a.label.localeCompare(b.label, locale)
  );
}
