import { char, index, jsonb, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  appSchema,
  kybStatusEnum,
  kybSubmissionStatusEnum,
  orgMemberRoleEnum,
  orgSourceEnum,
  registryTypeEnum,
} from "./enums.js";
import { uuidPk } from "./helpers.js";
import { users } from "./users.js";

// ── organizations ─────────────────────────────────────────────────────────────
export const organizations = appSchema.table("organizations", {
  id:              uuidPk(),
  source:          orgSourceEnum("source").notNull(),
  name:            text("name").notNull(),
  legalName:       text("legal_name"),
  country:         char("country", { length: 2 }).notNull(),
  registry:        registryTypeEnum("registry").notNull(),
  registryId:      text("registry_id"),
  website:         text("website"),
  description:     text("description"),
  causes:          text("causes").array().notNull().default(sql`'{}'`),
  kybStatus:       kybStatusEnum("kyb_status").notNull().default("NONE"),
  claimedByUserId: uuid("claimed_by_user_id").references(() => users.id),
  payoutAddress:   varchar("payout_address", { length: 42 }),
  logoCid:         text("logo_cid"),
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
                     .$onUpdateFn(() => new Date()),
}, (t) => [
  unique("organizations_registry_registry_id_uniq").on(t.registry, t.registryId),
  index("organizations_claimed_by_user_id_idx").on(t.claimedByUserId),
  check(
    "organizations_payout_address_format",
    sql`${t.payoutAddress} IS NULL OR ${t.payoutAddress} ~ '^0x[0-9a-f]{40}$'`,
  ),
]);

// ── org_members ───────────────────────────────────────────────────────────────
// Sole source of org membership (not duplicated in user_roles — CTO decision).
export const orgMembers = appSchema.table("org_members", {
  id:        uuidPk(),
  orgId:     uuid("org_id").notNull().references(() => organizations.id),
  userId:    uuid("user_id").notNull().references(() => users.id),
  role:      orgMemberRoleEnum("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
               .$onUpdateFn(() => new Date()),
}, (t) => [
  unique("org_members_org_id_user_id_uniq").on(t.orgId, t.userId),
  index("org_members_org_id_idx").on(t.orgId),
  index("org_members_user_id_idx").on(t.userId),
]);

// ── kyb_submissions ───────────────────────────────────────────────────────────
export const kybSubmissions = appSchema.table("kyb_submissions", {
  id:              uuidPk(),
  orgId:           uuid("org_id").notNull().references(() => organizations.id),
  submittedBy:     uuid("submitted_by").notNull().references(() => users.id),
  status:          kybSubmissionStatusEnum("status").notNull().default("PENDING"),
  reviewerId:      uuid("reviewer_id").references(() => users.id),
  reviewNote:      text("review_note"),
  /** When a reviewer approved or rejected it; the 90-day retention of rejected documents counts from here (ADR-034). */
  reviewedAt:      timestamp("reviewed_at", { withTimezone: true }),
  privateFileKeys: text("private_file_keys").array().notNull().default(sql`'{}'`),
  /**
   * The validated form data of this submission (name, legal name, country,
   * website, description, causes, payout address). No file data and no personal
   * data of the applicant. For a claim or a resubmission the organisations row
   * is not changed before approval; the review applies this to the row.
   */
  application:     jsonb("application").notNull().default(sql`'{}'`),
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
                     .$onUpdateFn(() => new Date()),
}, (t) => [
  index("kyb_submissions_org_id_idx").on(t.orgId),
  index("kyb_submissions_submitted_by_idx").on(t.submittedBy),
  // One pending application per user at a time.
  uniqueIndex("kyb_submissions_one_pending_per_submitter")
    .on(t.submittedBy)
    .where(sql`${t.status} = 'PENDING'`),
]);
