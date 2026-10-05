import type { Database } from "@cherrio/db";
import { listPublicCampaigns, type PublicCampaignSummary } from "./public";

// Landing page campaigns (TASK-037): real published campaigns instead of the
// sample data the landing carried since TASK-007.
//
// - hero: the live campaign whose deadline comes first (the list is already
//   ordered that way), so the most urgent open campaign gets the big card;
// - grid ("Campaigns raising now"): the next live campaigns, at most
//   LANDING_GRID_SIZE (one row of the 4-column grid).
// Only campaigns a visitor can still donate to count as live: state "live"
// from the indexed chain views. Ended campaigns stay on /campaigns.

export const LANDING_GRID_SIZE = 4;

export interface LandingCampaigns {
  hero: PublicCampaignSummary | null;
  grid: PublicCampaignSummary[];
  /** Published campaigns of any state; the empty state links to /campaigns when > 0. */
  total: number;
  chainAvailable: boolean;
}

/** Pure selection, exported for unit tests. Keeps the order it was given. */
export function pickLandingCampaigns(campaigns: PublicCampaignSummary[]): Pick<LandingCampaigns, "hero" | "grid"> {
  const live = campaigns.filter((c) => c.onChain?.state === "live");
  const [hero = null, ...rest] = live;
  return { hero, grid: rest.slice(0, LANDING_GRID_SIZE) };
}

export async function getLandingCampaigns(db: Database): Promise<LandingCampaigns> {
  // Page 1 holds up to PUBLIC_PAGE_SIZE (24) campaigns, live ones first.
  const { campaigns, total, chainAvailable } = await listPublicCampaigns(db, { page: 1 });
  return { ...pickLandingCampaigns(campaigns), total, chainAvailable };
}
