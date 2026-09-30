import { integer, text, timestamp } from "drizzle-orm/pg-core";
import { check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appSchema } from "./enums.js";
import { uuidPk } from "./helpers.js";

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
