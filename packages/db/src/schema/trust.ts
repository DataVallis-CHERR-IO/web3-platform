import { index, integer, jsonb, numeric, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { appSchema, registryTypeEnum } from "./enums.js";
import { uuidPk } from "./helpers.js";
import { organizations } from "./organizations.js";

// ── trust_scores ──────────────────────────────────────────────────────────────
// Append-only versioned scores; latest row per org is the current score.
// formula_version is stored so the methodology page can link to the right docs.
export const trustScores = appSchema.table("trust_scores", {
  id:          uuidPk(),
  orgId:       uuid("org_id").notNull().references(() => organizations.id),
  version:     integer("version").notNull(),
  /** Weighted composite, 0–100.00 */
  score:       numeric("score", { precision: 5, scale: 2 }).notNull(),
  components:  jsonb("components").notNull(),
  computedAt:  timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Primary query: latest score per org
  index("trust_scores_org_id_computed_at_idx").on(t.orgId, t.computedAt),
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
