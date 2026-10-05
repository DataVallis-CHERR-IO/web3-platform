import { inArray } from "drizzle-orm";
import * as schema from "@cherrio/db";
import type { Database } from "@cherrio/db";

// Removes demo organisations created by a test (ADR-053) with everything that
// hangs on them: campaigns and their media and audit rows, KYB submissions,
// memberships, the synthetic members, and the organisations' audit rows.
export async function deleteDemoOrganizations(db: Database, organizationIds: string[]): Promise<void> {
  const { auditLog, campaignMedia, campaigns, kybSubmissions, organizations, orgMembers, users } = schema;
  if (organizationIds.length === 0) return;
  const own = await db.select({ id: campaigns.id }).from(campaigns).where(inArray(campaigns.orgId, organizationIds));
  const campaignIds = own.map((c) => c.id);
  if (campaignIds.length > 0) {
    await db.delete(campaignMedia).where(inArray(campaignMedia.campaignId, campaignIds));
    await db.delete(auditLog).where(inArray(auditLog.entityId, campaignIds));
    await db.delete(campaigns).where(inArray(campaigns.id, campaignIds));
  }
  const members = await db.select({ userId: orgMembers.userId }).from(orgMembers).where(inArray(orgMembers.orgId, organizationIds));
  await db.delete(kybSubmissions).where(inArray(kybSubmissions.orgId, organizationIds));
  await db.delete(orgMembers).where(inArray(orgMembers.orgId, organizationIds));
  await db.delete(auditLog).where(inArray(auditLog.entityId, organizationIds));
  await db.delete(organizations).where(inArray(organizations.id, organizationIds));
  const demoMembers = members.map((m) => m.userId);
  if (demoMembers.length > 0) {
    const synthetic = await db.select({ id: users.id }).from(users).where(inArray(users.id, demoMembers));
    const ids = synthetic.map((u) => u.id);
    const stillMember = await db.select({ userId: orgMembers.userId }).from(orgMembers).where(inArray(orgMembers.userId, ids));
    const free = ids.filter((id) => !stillMember.some((m) => m.userId === id));
    if (free.length > 0) {
      const demoOnly = await db.select({ id: users.id, isDemo: users.isDemo }).from(users).where(inArray(users.id, free));
      const toDelete = demoOnly.filter((u) => u.isDemo).map((u) => u.id);
      if (toDelete.length > 0) await db.delete(users).where(inArray(users.id, toDelete));
    }
  }
}
