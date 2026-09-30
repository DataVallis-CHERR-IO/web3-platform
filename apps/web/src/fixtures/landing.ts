/**
 * apps/web/src/fixtures/landing.ts
 * Typed sample data for the landing page. All money values are bigint.
 * Rate: 1.08 USD/EUR → 108_000_000n
 */
import type { Money } from "@cherrio/shared/money";
import type { Status } from "@cherrio/ui";

export interface CampaignFixture {
  id: string;
  title: string;
  org: string;
  verified: boolean;
  status: Status;
  raised: Money;
  target: Money;
  donors: number;
  daysLeft: number | null;
  featured: boolean;
}

export const SAMPLE_CAMPAIGNS: CampaignFixture[] = [
  {
    id: "c-001",
    title: "Winter shelter for 40 dogs",
    org: "Shelter Paws Ljubljana",
    verified: true,
    status: "live",
    raised: { eurCents: 412_000n },      // €4,120
    target: { eurCents: 600_000n },      // €6,000
    donors: 88,
    daysLeft: 14,
    featured: true,
  },
  {
    id: "c-002",
    title: "Clean-up of the Drava banks",
    org: "River Clean Drava",
    verified: true,
    status: "live",
    raised: { eurCents: 135_000n },      // €1,350
    target: { eurCents: 800_000n },      // €8,000
    donors: 41,
    daysLeft: 21,
    featured: false,
  },
  {
    id: "c-003",
    title: "Hot meals for 120 seniors",
    org: "Food Bridge Celje",
    verified: true,
    status: "voting",
    raised: { eurCents: 900_000n },      // €9,000
    target: { eurCents: 900_000n },      // €9,000
    donors: 206,
    daysLeft: null,
    featured: false,
  },
  {
    id: "c-004",
    title: "Wheelchair for Marko",
    org: "Ana Novak",
    verified: false,
    status: "live",
    raised: { eurCents: 61_000n },       // €610
    target: { eurCents: 320_000n },      // €3,200
    donors: 17,
    daysLeft: 30,
    featured: false,
  },
];

/* ── Hero featured campaign (separate from the grid) ───────────────────── */

export const HERO_CAMPAIGN = {
  org: "Children's Health Maribor",
  verified: true,
  title: "Surgery for Susan, 7",
  raised: { eurCents: 1_248_000n } as Money,   // €12,480
  target: { eurCents: 2_000_000n } as Money,   // €20,000
  donors: 312,
  daysLeft: 9,
};

/* ── Charity Market Cap sample data ────────────────────────────────────── */

export interface CmcOrgFixture {
  rank: number;
  name: string;
  score: number;
  status: Status;
}

export const CMC_SAMPLE_ORGS: CmcOrgFixture[] = [
  { rank: 1, name: "Children\u2019s Health Maribor", score: 91, status: "verified" },
  { rank: 2, name: "Food Bridge Celje",              score: 86, status: "verified" },
  { rank: 3, name: "Shelter Paws Ljubljana",         score: 78, status: "verified" },
  { rank: 4, name: "River Clean Drava",              score: 64, status: "verified" },
  { rank: 5, name: "Warm Homes Ptuj",                score: 38, status: "imported" },
];
