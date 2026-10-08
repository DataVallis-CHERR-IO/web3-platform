import { boolean, char, index, integer, jsonb, numeric, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appSchema, registryTypeEnum } from "./enums.js";
import { uuidPk } from "./helpers.js";
import { organizations } from "./organizations.js";

// ── trust_scores ──────────────────────────────────────────────────────────────
// ADR-059 (TASK-017): one current row per organisation and formula version,
// rewritten by the worker only when something changed (append-only would add
// ~1 M rows a night once the registries are imported). The listing columns
// (listed, registered, country, causes, raised) are copied here so the Charity
// Market Cap can filter and sort ~1 M organisations through these indexes.
export const trustScores = appSchema.table("trust_scores", {
  id:          uuidPk(),
  orgId:       uuid("org_id").notNull().references(() => organizations.id),
  version:     integer("version").notNull(),
  /** Weighted composite, 0–100.00 */
  score:       numeric("score", { precision: 5, scale: 2 }).notNull(),
  components:  jsonb("components").notNull(),
  /** Shown on the Charity Market Cap (false: removed from its register, demo, rejected). */
  listed:      boolean("listed").notNull().default(true),
  /** Verified on CHERR.IO (KYB approved). */
  registered:  boolean("registered").notNull().default(false),
  country:     char("country", { length: 2 }),
  causes:      text("causes").array().notNull().default(sql`'{}'`),
  /** USDC (6 decimals) raised on CHERR.IO, all campaigns. */
  raised:      numeric("raised", { precision: 78, scale: 0 }).notNull().default(sql`0`),
  computedAt:  timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("trust_scores_org_id_computed_at_idx").on(t.orgId, t.computedAt),
  uniqueIndex("trust_scores_org_id_version_uniq").on(t.orgId, t.version),
  index("trust_scores_rank_idx").on(t.version, t.score.desc(), t.orgId).where(sql`${t.listed}`),
  index("trust_scores_country_rank_idx").on(t.version, t.country, t.score.desc(), t.orgId).where(sql`${t.listed}`),
  index("trust_scores_raised_idx").on(t.version, t.raised.desc(), t.orgId).where(sql`${t.listed}`),
  index("trust_scores_causes_idx").using("gin", t.causes),
]);

// ── registry_records ──────────────────────────────────────────────────────────
// Raw registry import snapshots (SI, UK, US). Updated in-place on re-import.
export const registryRecords = appSchema.table("registry_records", {
  id:          uuidPk(),
  registry:    registryTypeEnum("registry").notNull(),
  registryId:  text("registry_id").notNull(),
  raw:         jsonb("raw").notNull(),
  fetchedAt:   timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
                 .$onUpdateFn(() => new Date()),
}, (t) => [
  unique("registry_records_registry_id_uniq").on(t.registry, t.registryId),
  index("registry_records_registry_idx").on(t.registry),
]);
