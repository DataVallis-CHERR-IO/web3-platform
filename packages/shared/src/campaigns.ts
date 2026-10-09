import { z } from "zod";
import { ALLOWED_COUNTRY_CODES, ORGANIZATION_CAUSES } from "./organizations.js";

// Campaign drafts (TASK-010): what an organisation enters before a platform
// admin reviews the campaign. The same schema validates the form and the API.

/** Product Spec §2.1: campaigns of one organisation in review, approved or published at the same time. */
export const MAX_ACTIVE_CAMPAIGNS_PER_ORG = 5;

/**
 * ADR-060: currencies a fundraiser may set the goal in. Donations stay USDC;
 * the goal is converted to USDC at approval (USD 1:1, EUR at the ECB rate).
 */
export const GOAL_CURRENCIES = ["EUR", "USD"] as const;
export type GoalCurrency = (typeof GOAL_CURRENCIES)[number];

export function isGoalCurrency(value: unknown): value is GoalCurrency {
  return typeof value === "string" && (GOAL_CURRENCIES as readonly string[]).includes(value);
}

/** A campaign goal as the fundraiser set it: minor units (cents) of its currency. */
export interface CampaignGoal {
  currency: GoalCurrency;
  minor: bigint;
}

/** A goal read from the database (`goal_currency`, `goal_amount_minor`). Unknown currencies fail loudly. */
export function campaignGoal(currency: string, minor: string | bigint): CampaignGoal {
  if (!isGoalCurrency(currency)) throw new Error(`Unknown goal currency: ${currency}`);
  return { currency, minor: BigInt(minor) };
}

export const CAMPAIGN_LIMITS = {
  title: { min: 5, max: 120 },
  story: { min: 50, max: 10_000 },
  /** Whole units of the goal currency (the same range for EUR and USD). */
  goal: { min: 100, max: 1_000_000 },
  /** Product rule; the contract itself accepts 1–90 days (ADR-030). */
  durationDays: { min: 7, max: 90 },
} as const;

export const campaignDraftSchema = z.object({
  title: z.string().trim().min(CAMPAIGN_LIMITS.title.min).max(CAMPAIGN_LIMITS.title.max),
  /** Plain text with paragraphs. Rendered escaped — never as HTML. */
  story: z.string().trim().min(CAMPAIGN_LIMITS.story.min).max(CAMPAIGN_LIMITS.story.max),
  cause: z.enum(ORGANIZATION_CAUSES),
  country: z.string().refine((code) => ALLOWED_COUNTRY_CODES.includes(code)),
  goalCurrency: z.enum(GOAL_CURRENCIES),
  goal: z.number().int().min(CAMPAIGN_LIMITS.goal.min).max(CAMPAIGN_LIMITS.goal.max),
  durationDays: z.number().int().min(CAMPAIGN_LIMITS.durationDays.min).max(CAMPAIGN_LIMITS.durationDays.max),
});
export type CampaignDraft = z.infer<typeof campaignDraftSchema>;

export const newCampaignDraftSchema = campaignDraftSchema.extend({ organizationId: z.string().uuid() });

/** How `campaigns.story` (jsonb) is stored. */
export interface CampaignStory {
  format: "plain";
  text: string;
}

/**
 * URL slug from a title: lowercase ASCII letters and digits joined by "-",
 * accents removed, at most 80 characters. Never empty ("campaign" as a fallback).
 */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "campaign";
}
