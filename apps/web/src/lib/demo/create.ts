import { randomBytes } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import { auditLog, campaigns, organizations, orgMembers, type Database } from "@cherrio/db";
import { eurCentsToUsdc, MIN_CAMPAIGN_TARGET_USDC, slugify, type CampaignStory } from "@cherrio/shared";
import { fetchEcbUsdRate, type EcbRate } from "@/lib/campaigns/ecb";
import { DEMO_POOL } from "./pool";

// ADR-052: demo campaigns for testing on local/dev. They are ordinary
// campaigns (status APPROVED, ECB rate snapshot, offchain id) flagged
// `is_demo`, created in one batch by a platform admin; publishing them on
// chain is the normal Operator-signed flow.

/** Hard limit per request: ten wallet signatures and ten paid images per round. */
export const DEMO_BATCH_MAX = 10;
export const DEMO_ORG_NAME = "CHERR.IO Demo";
/** "mixed" cycles through these; "short" uses the contract minimum of one day. */
export const DEMO_MIXED_DURATIONS = [1, 3, 7, 14, 21, 30] as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export const demoRequestSchema = z
  .object({
    count: z.number().int().min(1).max(DEMO_BATCH_MAX),
    payoutAddress: z.string().regex(ADDRESS_RE),
    durationMode: z.enum(["mixed", "short"]),
  })
  .strict();
export type DemoRequest = z.infer<typeof demoRequestSchema>;

export type DemoRefusal = "not_allowed" | "rate_unavailable";
export class DemoRefusedError extends Error {
  constructor(public readonly code: DemoRefusal) {
    super(code);
    this.name = "DemoRefusedError";
  }
}

/** Server-side guard (ADR-052 §6): only local and dev may hold made-up campaigns. */
export function demoCampaignsAllowed(appEnv: string | undefined = process.env.APP_ENV): boolean {
  return appEnv === "local" || appEnv === "dev";
}

export function demoDuration(mode: DemoRequest["durationMode"], index: number): number {
  if (mode === "short") return 1;
  return DEMO_MIXED_DURATIONS[index % DEMO_MIXED_DURATIONS.length]!;
}

/** The n-th seed from the pool; after a full round the title gets " (round)". */
export function demoSeed(n: number) {
  const seed = DEMO_POOL[n % DEMO_POOL.length]!;
  const round = Math.floor(n / DEMO_POOL.length);
  return { ...seed, title: round === 0 ? seed.title : `${seed.title} (${round + 1})` };
}

const rateColumn = (rate: bigint) => `${rate / 100_000_000n}.${(rate % 100_000_000n).toString().padStart(8, "0")}`;

export interface CreatedDemoCampaign {
  id: string;
  slug: string;
  title: string;
  durationDays: number;
}

/**
 * Creates `count` APPROVED demo campaigns under the per-environment demo
 * organisation (created on first use, KYB approved, the acting admin as
 * ORG_ADMIN so evidence can be tested). The payout wallet is the one the admin
 * entered. One transaction; audited.
 */
export async function createDemoCampaigns(
  db: Database,
  adminId: string,
  input: DemoRequest,
  options: { appEnv?: string; getRate?: () => Promise<EcbRate>; ip?: string } = {}
): Promise<{ organizationId: string; created: CreatedDemoCampaign[] }> {
  if (!demoCampaignsAllowed(options.appEnv ?? process.env.APP_ENV)) throw new DemoRefusedError("not_allowed");
  const request = demoRequestSchema.parse(input);
  const payout = request.payoutAddress.toLowerCase();

  let ecb: EcbRate;
  try {
    ecb = await (options.getRate ?? (() => fetchEcbUsdRate()))();
  } catch (e) {
    console.error("[demo] ECB rate unavailable:", e instanceof Error ? e.message : e);
    throw new DemoRefusedError("rate_unavailable");
  }

  return db.transaction(async (tx) => {
    let [org] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.name, DEMO_ORG_NAME))
      .limit(1);
    if (!org) {
      [org] = await tx
        .insert(organizations)
        .values({
          source: "REGISTERED",
          name: DEMO_ORG_NAME,
          country: "SI",
          registry: "NONE",
          causes: ["community"],
          kybStatus: "APPROVED",
          payoutAddress: payout,
        })
        .returning({ id: organizations.id });
    }
    const orgId = org!.id;
    const [member] = await tx
      .select({ userId: orgMembers.userId })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, adminId)))
      .limit(1);
    if (!member) await tx.insert(orgMembers).values({ orgId, userId: adminId, role: "ORG_ADMIN" });

    const [{ existing }] = (await tx
      .select({ existing: count() })
      .from(campaigns)
      .where(eq(campaigns.isDemo, true))) as [{ existing: number }];

    const created: CreatedDemoCampaign[] = [];
    for (let i = 0; i < request.count; i++) {
      const seed = demoSeed(existing + i);
      const durationDays = demoDuration(request.durationMode, existing + i);
      const targetEurCents = BigInt(seed.targetEur) * 100n;
      const targetUsdc = eurCentsToUsdc(targetEurCents, ecb.rate);
      if (targetUsdc < MIN_CAMPAIGN_TARGET_USDC) continue; // the pool has none; defensive
      const story: CampaignStory = { format: "plain", text: seed.story.join("\n\n") };
      const [row] = await tx
        .insert(campaigns)
        .values({
          orgId,
          starterUserId: adminId,
          beneficiaryType: "ORGANIZATION",
          title: seed.title,
          slug: `${slugify(seed.title).slice(0, 60)}-demo-${randomBytes(3).toString("hex")}`,
          story,
          cause: seed.cause,
          country: seed.country,
          targetEurCents: targetEurCents.toString(),
          durationDays,
          status: "APPROVED",
          eurUsdRate: rateColumn(ecb.rate),
          rateSource: "ECB",
          rateAt: ecb.date,
          targetUsdc,
          beneficiaryAddress: payout,
          offchainId: randomBytes(32),
          submittedAt: new Date(),
          reviewedAt: new Date(),
          reviewerId: adminId,
          isDemo: true,
        })
        .returning({ id: campaigns.id, slug: campaigns.slug, title: campaigns.title });
      created.push({ ...row!, durationDays });
    }

    await tx.insert(auditLog).values({
      actorUserId: adminId,
      action: "demo.campaigns_created",
      entityType: "organization",
      entityId: orgId,
      data: { count: created.length, payoutAddress: payout, durationMode: request.durationMode, campaignIds: created.map((c) => c.id) },
      ip: options.ip,
    });
    return { organizationId: orgId, created };
  });
}
