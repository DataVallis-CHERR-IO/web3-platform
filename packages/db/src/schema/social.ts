import { bigint, index, integer, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appSchema, pointBucketEnum, pointReasonEnum } from "./enums.js";
import { uuidPk } from "./helpers.js";
import { campaigns } from "./campaigns.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

// ── ratings ───────────────────────────────────────────────────────────────────
// Off-chain EIP-712 signed ratings. One per (campaign, user). Org rated indirectly.
// eraseUser() nulls signature only; row is kept pseudonymous by user_id.
export const ratings = appSchema.table("ratings", {
  id:         uuidPk(),
  orgId:      uuid("org_id").notNull().references(() => organizations.id),
  campaignId: uuid("campaign_id").notNull().references(() => campaigns.id),
  userId:     uuid("user_id").notNull().references(() => users.id),
  stars:      integer("stars").notNull(),
  comment:    text("comment"),
  /** EIP-712 signature. Nulled by eraseUser() for GDPR. */
  signature:  text("signature"),
  createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
                .$onUpdateFn(() => new Date()),
}, (t) => [
  unique("ratings_campaign_id_user_id_uniq").on(t.campaignId, t.userId),
  index("ratings_org_id_idx").on(t.orgId),
  index("ratings_campaign_id_idx").on(t.campaignId),
  index("ratings_user_id_idx").on(t.userId),
  check("ratings_stars_range", sql`${t.stars} >= 1 AND ${t.stars} <= 5`),
]);

// ── points_ledger ─────────────────────────────────────────────────────────────
// Append-only; no updated_at. delta is bigint: 100 pts × large USDC donations
// can exceed int32 in a single row (e.g. 21 001 USDC × 100 = 2 100 100 > 2^21).
export const pointsLedger = appSchema.table("points_ledger", {
  id:          uuidPk(),
  userId:      uuid("user_id").notNull().references(() => users.id),
  bucket:      pointBucketEnum("bucket").notNull(),
  delta:       bigint("delta", { mode: "bigint" }).notNull(),
  reason:      pointReasonEnum("reason").notNull(),
  refType:     text("ref_type"),
  refId:       uuid("ref_id"),
  ruleVersion: integer("rule_version").notNull().default(1),
  voidedAt:    timestamp("voided_at", { withTimezone: true }),
  voidedReason: text("voided_reason"),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("points_ledger_user_id_created_at_idx").on(t.userId, t.createdAt),
]);

// ── user_levels ───────────────────────────────────────────────────────────────
// One row per user (user_id is PK). Points counters match sum of points_ledger.
export const userLevels = appSchema.table("user_levels", {
  userId:         uuid("user_id").primaryKey().references(() => users.id),
  level:          integer("level").notNull().default(1),
  statusPoints:   bigint("status_points", { mode: "bigint" }).notNull().default(sql`0`),
  rewardPoints:   bigint("reward_points", { mode: "bigint" }).notNull().default(sql`0`),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
                    .$onUpdateFn(() => new Date()),
});
