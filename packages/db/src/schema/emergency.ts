import { index, integer, numeric, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appSchema } from "./enums.js";
import { uuidPk } from "./helpers.js";
import { users } from "./users.js";
import { campaigns } from "./campaigns.js";

// ── emergency_subpools ────────────────────────────────────────────────────────
// Seeded; one general pool + thematic sub-pools (medical, disasters, animals,
// climate). pool_id matches the uint32 pool ID in the EmergencyPool contract.
export const emergencySubpools = appSchema.table("emergency_subpools", {
  id:             uuidPk(),
  /** Matches on-chain uint32 pool ID. CHECK >= 0. */
  poolId:         integer("pool_id").notNull().unique(),
  slug:           text("slug").notNull().unique(),
  /** next-intl message key for the display name (no hard-coded UI strings). */
  nameKey:        text("name_key").notNull(),
  /** next-intl message key for the description. */
  descriptionKey: text("description_key").notNull(),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
                    .$onUpdateFn(() => new Date()),
}, (t) => [
  check("emergency_subpools_pool_id_non_negative", sql`${t.poolId} >= 0`),
]);

// ── pool_allocation_reasons ───────────────────────────────────────────────────
// TASK-014c: the public reason of an Emergency Pool allocation. The chain keeps
// only reasonHash = SHA-256(text, UTF-8); the text lives here so the public page
// can show it, and anyone can re-hash it against the AllocationProposed event.
// Saved before the Operator signs proposeAllocation; a row without a matching
// chain.allocation is a proposal that was never sent (harmless).
export const poolAllocationReasons = appSchema.table("pool_allocation_reasons", {
  id:          uuidPk(),
  /** 0x + 64 lower-case hex: SHA-256 of `text`. */
  reasonHash:  text("reason_hash").notNull().unique(),
  text:        text("text").notNull(),
  poolId:      integer("pool_id").notNull(),
  campaignId:  uuid("campaign_id").notNull().references(() => campaigns.id),
  /** USDC base units the admin entered (the chain's amount is authoritative). */
  amountUsdc:  numeric("amount_usdc", { precision: 78, scale: 0 }).notNull(),
  createdBy:   uuid("created_by").notNull().references(() => users.id),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("pool_allocation_reasons_hash_format", sql`${t.reasonHash} ~ '^0x[0-9a-f]{64}$'`),
  check("pool_allocation_reasons_text_length", sql`char_length(${t.text}) between 1 and 1000`),
  index("pool_allocation_reasons_campaign_id_idx").on(t.campaignId),
]);
