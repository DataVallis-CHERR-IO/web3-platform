/**
 * apps/agents/src/rating.ts — donors rate finished crew campaigns (TASK-061g).
 *
 * After a crew campaign is COMPLETED, FAILED or REJECTED, an agent that gave to it
 * rates the organisation through the campaign page's own panel ("Rate the
 * organisation", ADR-058): stars, a fixed test comment, "Sign and save" — the
 * wallet signs the app's own EIP-712 `Rating` message (the only typed data the
 * signer policy allows). Crew campaigns only, once per campaign (the app would
 * let a rating be changed; the agents never do), at most MAX_RATINGS_PER_RUN per
 * member per run. The decisions are pure and tested; the Playwright driver only
 * follows them.
 */
import type { CrewMember } from "./crew.js";
import { TESTNET_ORIGIN } from "./guard.js";
import { shot } from "./browser.js";
import { BudgetExceeded } from "./budget.js";
import type { FlowContext } from "./flows.js";
import { crewCampaignsForLifecycle, ensureSignedIn, isCrewLifecycleCampaign, type LifecycleCampaign } from "./lifecycle.js";

/** At most this many ratings per agent in one run. */
export const MAX_RATINGS_PER_RUN = 2;

/** Public API state names of campaigns the app lets donors rate (RATEABLE_CAMPAIGN_STATES, lower case). */
export const RATEABLE_PUBLIC_STATES = ["completed", "failed", "rejected"] as const;

/** The parts of GET /api/campaigns/:id/rating this module reads. */
export interface RatingJson {
  status: string;
  rating: { stars: number; comment: string | null } | null;
}

/** 5 stars for a campaign that was paid out, 3 for one that failed or was rejected. */
export function starsFor(state: string | null): number | null {
  if (state === "completed") return 5;
  if (state === "failed" || state === "rejected") return 3;
  return null;
}

export function commentFor(memberName: string, stars: number): string {
  return `Testnet agent ${memberName}: ${stars} stars — test rating, not a real review.`;
}

/** The radio's accessible name (en.json campaignPage.rating.star, ICU plural). */
export const starLabel = (stars: number) => `${stars} ${stars === 1 ? "star" : "stars"}`;

export type RatingDecision = { rate: true; stars: number } | { rate: false; reason: string };

/** Rate only a crew campaign in a rateable state, when the API says "open" and this member has no rating yet. */
export function decideRating(campaign: Pick<LifecycleCampaign, "state" | "demo" | "organization">, json: RatingJson): RatingDecision {
  if (!isCrewLifecycleCampaign(campaign)) return { rate: false, reason: "not a crew campaign" };
  const stars = starsFor(campaign.state);
  if (stars === null) return { rate: false, reason: `state ${campaign.state} is not rateable` };
  if (json.status !== "open") return { rate: false, reason: `API status ${json.status}` };
  if (json.rating) return { rate: false, reason: "already rated" };
  return { rate: true, stars };
}

const used = new Map<string, number>();
export const ratingsUsed = (member: Pick<CrewMember, "name">) => used.get(member.name) ?? 0;
export const resetRatingCounts = () => used.clear();

async function fetchRating(ctx: FlowContext, id: string): Promise<RatingJson> {
  const res = await ctx.session.context.request.get(`${TESTNET_ORIGIN}/api/campaigns/${id}/rating`, { timeout: 20_000 });
  if (!res.ok()) throw new Error(`/api/campaigns/:id/rating answered ${res.status()}`);
  return (await res.json()) as RatingJson;
}

/** Finished crew campaigns (public API), paged; the same crew filter as the life-cycle list. */
export const finishedCrewCampaigns = (fetchImpl: typeof fetch = fetch) =>
  crewCampaignsForLifecycle(fetchImpl, 10, RATEABLE_PUBLIC_STATES);

/** One rating through the page's panel; returns true when a rating was saved. */
export async function rateCampaign(ctx: FlowContext, campaign: LifecycleCampaign): Promise<boolean> {
  const path = new URL(campaign.url).pathname;
  if (ratingsUsed(ctx.member) >= MAX_RATINGS_PER_RUN) return false;
  if (!campaign.id) throw new Error(`"${campaign.title}" has no id in the API`);
  if (!(await ensureSignedIn(ctx))) return false;
  const decision = decideRating(campaign, await fetchRating(ctx, campaign.id));
  if (!decision.rate) return false;
  const { stars } = decision;
  const { page } = ctx.session;

  await page.goto(`${campaign.url}#rating`, { waitUntil: "domcontentloaded" });
  const panel = page.getByRole("region", { name: "Rate the organisation" });
  await panel.waitFor({ state: "visible", timeout: 60_000 });
  await panel.scrollIntoViewIfNeeded({ timeout: 30_000 });
  await panel.getByRole("radio", { name: starLabel(stars), exact: true }).check({ timeout: 30_000 });
  await panel.getByLabel("Comment (optional)").fill(commentFor(ctx.member.name, stars));
  await shot(page, ctx.out, `${ctx.member.name}-07-rating`);
  used.set(ctx.member.name, ratingsUsed(ctx.member) + 1);
  await panel.getByRole("button", { name: "Sign and save", exact: true }).click();
  try {
    await panel.getByText("Thank you — your rating is saved.").waitFor({ timeout: 120_000 });
  } catch (error) {
    const alert = await panel.getByRole("alert").first().textContent({ timeout: 2_000 }).catch(() => null);
    ctx.record("rating", false, `"${campaign.title}": ${stars} stars not saved${alert ? ` (panel says: ${alert.trim().slice(0, 120)})` : ""}`, { path });
    if (!alert) throw error;
    return false;
  }
  const after = await fetchRating(ctx, campaign.id);
  const ok = after.rating?.stars === stars;
  ctx.record("rating", ok, ok ? `"${campaign.title}": ${stars} stars saved` : `"${campaign.title}": panel said saved, API shows ${after.rating ? `${after.rating.stars} stars` : "no rating"}`, { path });
  return ok;
}

/** Rates what this member may rate among the given finished crew campaigns, up to the per-run cap. */
export async function rateFinished(ctx: FlowContext, campaigns: readonly LifecycleCampaign[]): Promise<number> {
  let saved = 0;
  for (const c of campaigns) {
    if (ratingsUsed(ctx.member) >= MAX_RATINGS_PER_RUN) break;
    try {
      if (await rateCampaign(ctx, c)) saved++;
    } catch (error) {
      if (error instanceof BudgetExceeded) throw error;
      if (ctx.session.budgetHit) throw ctx.session.budgetHit;
      ctx.record("rating", false, `"${c.title}": ${error instanceof Error ? error.message : String(error)}`, { path: new URL(c.url).pathname });
    }
  }
  return saved;
}
