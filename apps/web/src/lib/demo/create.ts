import { randomBytes } from "node:crypto";
import { and, count, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { auditLog, campaigns, kybSubmissions, organizations, orgMembers, users, type Database } from "@cherrio/db";
import {
  eurCentsToUsdc,
  MAX_ACTIVE_CAMPAIGNS_PER_ORG,
  MIN_CAMPAIGN_TARGET_USDC,
  rateToNumeric8,
  slugify,
  type CampaignStory,
} from "@cherrio/shared";
import { fetchEcbUsdRate, type EcbRate } from "@/lib/campaigns/ecb";
import { DEMO_ORG_POOL, type DemoOrganizationSeed } from "./orgs";
import { DEMO_POOL, type DemoCampaignSeed } from "./pool";

// ADR-052 + ADR-053: demo data for testing on local/dev, in the production
// flow. Demo organisations have their own synthetic member (ORG_ADMIN) and an
// approved KYB submission reviewed by the acting admin; their campaigns are
// started by that member — never by the admin — so the four-eyes rule of review
// and publishing applies unchanged. The admin picks the state of new campaigns:
// PENDING_REVIEW (to review them like real ones) or APPROVED (ready to publish).

/** Hard limit per request: ten wallet confirmations and ten paid images per round. */
export const DEMO_BATCH_MAX = 10;
export const DEMO_NEW_ORGS_MAX = 5;
/** The first demo organisation of ADR-052; repaired to the ADR-053 shape on the next batch. */
export const LEGACY_DEMO_ORG_NAME = "CHERR.IO Demo";
/** "mixed" cycles through these; "short" uses the contract minimum of one day. */
export const DEMO_MIXED_DURATIONS = [1, 3, 7, 14, 21, 30] as const;
const ACTIVE_STATES = ["PENDING_REVIEW", "APPROVED", "DEPLOYED"] as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export const demoRequestSchema = z
  .object({
    /** 0 = add campaigns to existing demo organisations with free slots. */
    newOrganizations: z.number().int().min(0).max(DEMO_NEW_ORGS_MAX),
    campaignsPerOrganization: z.number().int().min(1).max(MAX_ACTIVE_CAMPAIGNS_PER_ORG),
    state: z.enum(["PENDING_REVIEW", "APPROVED"]),
    payoutAddress: z.string().regex(ADDRESS_RE),
    durationMode: z.enum(["mixed", "short"]),
  })
  .strict();
export type DemoRequest = z.infer<typeof demoRequestSchema>;

export type DemoRefusal = "not_allowed" | "rate_unavailable" | "batch_too_large" | "no_demo_organizations";
export class DemoRefusedError extends Error {
  constructor(public readonly code: DemoRefusal) {
    super(code);
    this.name = "DemoRefusedError";
  }
}

/** Server-side guard (ADR-052 §6): only local and dev may hold made-up data. */
export function demoCampaignsAllowed(appEnv: string | undefined = process.env.APP_ENV): boolean {
  return appEnv === "local" || appEnv === "dev";
}

export function demoDuration(mode: DemoRequest["durationMode"], index: number): number {
  if (mode === "short") return 1;
  return DEMO_MIXED_DURATIONS[index % DEMO_MIXED_DURATIONS.length]!;
}

/** The n-th campaign seed from the pool; after a full round the title gets " (round)". */
export function demoSeed(n: number) {
  const seed = DEMO_POOL[n % DEMO_POOL.length]!;
  const round = Math.floor(n / DEMO_POOL.length);
  return { ...seed, title: round === 0 ? seed.title : `${seed.title} (${round + 1})` };
}

/** The n-th organisation seed; after a full round the name gets " (round)". */
export function demoOrgSeed(n: number): DemoOrganizationSeed {
  const seed = DEMO_ORG_POOL[n % DEMO_ORG_POOL.length]!;
  const round = Math.floor(n / DEMO_ORG_POOL.length);
  return round === 0 ? seed : { ...seed, name: `${seed.name} (${round + 1})`, legalName: `${seed.legalName} (${round + 1})` };
}

/**
 * Picks `wanted` campaign seeds for an organisation: pool order from `cursor`,
 * causes of the organisation first; when the pool has too few matching entries
 * any cause fills up. Returns the pool indexes (for numbering) in order.
 */
export function pickSeedIndexes(causes: readonly string[], cursor: number, wanted: number, taken: Set<number>): number[] {
  const picked: number[] = [];
  const limit = cursor + DEMO_POOL.length * 4;
  for (const matchCause of [true, false]) {
    for (let n = cursor; n < limit && picked.length < wanted; n++) {
      if (taken.has(n)) continue;
      const seed = DEMO_POOL[n % DEMO_POOL.length]!;
      if (matchCause && !causes.includes(seed.cause)) continue;
      picked.push(n);
      taken.add(n);
    }
  }
  return picked;
}


export interface CreatedDemoCampaign {
  id: string;
  slug: string;
  title: string;
  durationDays: number;
  organizationId: string;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** A new demo organisation with its synthetic member and an approved KYB submission. */
async function createDemoOrganization(tx: Tx, adminId: string, seed: DemoOrganizationSeed, payout: string) {
  const [member] = await tx
    .insert(users)
    .values({ displayName: `${seed.name} team`, isDemo: true })
    .returning({ id: users.id });
  const [org] = await tx
    .insert(organizations)
    .values({
      source: "REGISTERED",
      name: seed.name,
      legalName: seed.legalName,
      country: seed.country,
      registry: "NONE",
      description: seed.description,
      causes: [...seed.causes],
      kybStatus: "APPROVED",
      claimedByUserId: member!.id,
      payoutAddress: payout,
      isDemo: true,
    })
    .returning({ id: organizations.id });
  await tx.insert(orgMembers).values({ orgId: org!.id, userId: member!.id, role: "ORG_ADMIN" });
  await tx.insert(kybSubmissions).values({
    orgId: org!.id,
    submittedBy: member!.id,
    status: "APPROVED",
    reviewerId: adminId,
    reviewedAt: new Date(),
    application: {
      name: seed.name,
      legalName: seed.legalName,
      country: seed.country,
      description: seed.description,
      causes: seed.causes,
      payoutAddress: payout,
      demo: true,
    },
  });
  return { orgId: org!.id, memberId: member!.id, causes: seed.causes as readonly string[] };
}

/**
 * ADR-052's single "CHERR.IO Demo" organisation made the admin its member and
 * its campaigns' starter. Bring it to the ADR-053 shape: demo flag, a synthetic
 * member as starter of its campaigns, every non-demo member removed.
 */
async function repairLegacyDemoOrganization(tx: Tx) {
  const [legacy] = await tx
    .select({ id: organizations.id, isDemo: organizations.isDemo })
    .from(organizations)
    .where(eq(organizations.name, LEGACY_DEMO_ORG_NAME))
    .limit(1);
  if (!legacy) return null;
  const members = await tx
    .select({ userId: orgMembers.userId, isDemo: users.isDemo })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(eq(orgMembers.orgId, legacy.id));
  let memberId = members.find((m) => m.isDemo)?.userId;
  if (!memberId) {
    const [member] = await tx.insert(users).values({ displayName: `${LEGACY_DEMO_ORG_NAME} team`, isDemo: true }).returning({ id: users.id });
    memberId = member!.id;
    await tx.insert(orgMembers).values({ orgId: legacy.id, userId: memberId, role: "ORG_ADMIN" });
  }
  const outsiders = members.filter((m) => !m.isDemo).map((m) => m.userId);
  if (outsiders.length > 0) await tx.delete(orgMembers).where(and(eq(orgMembers.orgId, legacy.id), inArray(orgMembers.userId, outsiders)));
  await tx.update(organizations).set({ isDemo: true }).where(eq(organizations.id, legacy.id));
  await tx
    .update(campaigns)
    .set({ starterUserId: memberId })
    .where(and(eq(campaigns.orgId, legacy.id), ne(campaigns.starterUserId, memberId)));
  return { orgId: legacy.id, removedMembers: outsiders.length };
}

/**
 * Creates demo organisations (or reuses existing ones) and their campaigns in
 * one transaction. Audited as `demo.campaigns_created`.
 */
export async function createDemoCampaigns(
  db: Database,
  adminId: string,
  input: DemoRequest,
  options: { appEnv?: string; getRate?: () => Promise<EcbRate>; ip?: string } = {}
): Promise<{ organizationIds: string[]; created: CreatedDemoCampaign[] }> {
  if (!demoCampaignsAllowed(options.appEnv ?? process.env.APP_ENV)) throw new DemoRefusedError("not_allowed");
  const request = demoRequestSchema.parse(input);
  const payout = request.payoutAddress.toLowerCase();
  if (request.newOrganizations * request.campaignsPerOrganization > DEMO_BATCH_MAX) throw new DemoRefusedError("batch_too_large");

  // Only an APPROVED campaign carries the rate snapshot; PENDING_REVIEW gets it at approval.
  let ecb: EcbRate | null = null;
  if (request.state === "APPROVED") {
    try {
      ecb = await (options.getRate ?? (() => fetchEcbUsdRate()))();
    } catch (e) {
      console.error("[demo] ECB rate unavailable:", e instanceof Error ? e.message : e);
      throw new DemoRefusedError("rate_unavailable");
    }
  }

  return db.transaction(async (tx) => {
    const repaired = await repairLegacyDemoOrganization(tx);

    // Target organisations, each with how many campaigns it receives.
    const targets: { orgId: string; memberId: string; causes: readonly string[]; slots: number }[] = [];
    if (request.newOrganizations > 0) {
      const [{ n: existingOrgs }] = (await tx.select({ n: count() }).from(organizations).where(eq(organizations.isDemo, true))) as [{ n: number }];
      // The repaired legacy organisation does not take a pool entry.
      const offset = existingOrgs - (repaired ? 1 : 0);
      for (let i = 0; i < request.newOrganizations; i++) {
        const org = await createDemoOrganization(tx, adminId, demoOrgSeed(offset + i), payout);
        targets.push({ ...org, slots: request.campaignsPerOrganization });
      }
    } else {
      const existing = await tx
        .select({ orgId: organizations.id, causes: organizations.causes, memberId: orgMembers.userId })
        .from(organizations)
        .innerJoin(orgMembers, eq(orgMembers.orgId, organizations.id))
        .innerJoin(users, and(eq(users.id, orgMembers.userId), eq(users.isDemo, true)))
        .where(and(eq(organizations.isDemo, true), eq(organizations.kybStatus, "APPROVED")))
        .orderBy(organizations.createdAt);
      let left = DEMO_BATCH_MAX;
      for (const org of existing) {
        if (left === 0) break;
        if (targets.some((t) => t.orgId === org.orgId)) continue;
        const [{ n: active }] = (await tx
          .select({ n: count() })
          .from(campaigns)
          .where(and(eq(campaigns.orgId, org.orgId), inArray(campaigns.status, [...ACTIVE_STATES])))) as [{ n: number }];
        const slots = Math.min(request.campaignsPerOrganization, MAX_ACTIVE_CAMPAIGNS_PER_ORG - active, left);
        if (slots <= 0) continue;
        targets.push({ ...org, slots });
        left -= slots;
      }
      if (targets.length === 0) throw new DemoRefusedError("no_demo_organizations");
    }

    const [{ n: existingCampaigns }] = (await tx.select({ n: count() }).from(campaigns).where(eq(campaigns.isDemo, true))) as [{ n: number }];
    const taken = new Set<number>();
    const created: CreatedDemoCampaign[] = [];
    let index = 0;
    for (const target of targets) {
      for (const n of pickSeedIndexes(target.causes, existingCampaigns, target.slots, taken)) {
        const seed: DemoCampaignSeed = demoSeed(n);
        const durationDays = demoDuration(request.durationMode, existingCampaigns + index++);
        const targetEurCents = BigInt(seed.targetEur) * 100n;
        const story: CampaignStory = { format: "plain", text: seed.story.join("\n\n") };
        const base = {
          orgId: target.orgId,
          starterUserId: target.memberId,
          beneficiaryType: "ORGANIZATION" as const,
          title: seed.title,
          slug: `${slugify(seed.title).slice(0, 60)}-demo-${randomBytes(3).toString("hex")}`,
          story,
          cause: seed.cause,
          country: seed.country,
          // Demo goals stay in EUR (the pool is written in euros); ADR-060 USD goals come from real fundraisers.
          goalCurrency: "EUR",
          goalAmountMinor: targetEurCents.toString(),
          durationDays,
          submittedAt: new Date(),
          isDemo: true,
        };
        let values: typeof campaigns.$inferInsert = { ...base, status: "PENDING_REVIEW" };
        if (ecb) {
          const targetUsdc = eurCentsToUsdc(targetEurCents, ecb.rate);
          if (targetUsdc < MIN_CAMPAIGN_TARGET_USDC) continue; // the pool has none; defensive
          values = {
            ...base,
            status: "APPROVED",
            eurUsdRate: rateToNumeric8(ecb.rate),
            rateSource: "ECB",
            rateAt: ecb.date,
            targetUsdc,
            beneficiaryAddress: payout,
            offchainId: randomBytes(32),
            reviewedAt: new Date(),
            reviewerId: adminId,
          };
        }
        const [row] = await tx
          .insert(campaigns)
          .values(values)
          .returning({ id: campaigns.id, slug: campaigns.slug, title: campaigns.title });
        created.push({ ...row!, durationDays, organizationId: target.orgId });
      }
    }

    const organizationIds = [...new Set(targets.map((t) => t.orgId))];
    await tx.insert(auditLog).values({
      actorUserId: adminId,
      action: "demo.campaigns_created",
      entityType: "organization",
      entityId: organizationIds[0]!,
      data: {
        organizationIds,
        newOrganizations: request.newOrganizations,
        count: created.length,
        state: request.state,
        payoutAddress: payout,
        durationMode: request.durationMode,
        campaignIds: created.map((c) => c.id),
        repairedLegacy: repaired ? { orgId: repaired.orgId, removedMembers: repaired.removedMembers } : null,
      },
      ip: options.ip,
    });
    return { organizationIds, created };
  });
}
