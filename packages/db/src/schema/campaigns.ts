import { boolean, char, index, integer, jsonb, numeric, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  appSchema,
  beneficiaryTypeEnum,
  campaignStatusEnum,
  evidenceStatusEnum,
  evidenceVisibilityEnum,
  mediaKindEnum,
  storageProviderEnum,
} from "./enums.js";
import { bytea, numeric78, uuidPk } from "./helpers.js";
import { privateFiles } from "./files.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

const ADDR_RE = sql`'^0x[0-9a-f]{40}$'`;

// ── campaigns ─────────────────────────────────────────────────────────────────
export const campaigns = appSchema.table("campaigns", {
  id:                 uuidPk(),
  /** 32-byte deterministic campaign identifier used before on-chain deployment. */
  offchainId:         bytea("offchain_id").unique(),
  orgId:              uuid("org_id").references(() => organizations.id),
  starterUserId:      uuid("starter_user_id").notNull().references(() => users.id),
  beneficiaryType:    beneficiaryTypeEnum("beneficiary_type").notNull(),
  /** Immutable on-chain beneficiary address. Required once status ≥ APPROVED. */
  beneficiaryAddress: varchar("beneficiary_address", { length: 42 }),
  title:              text("title").notNull(),
  slug:               text("slug").notNull().unique(),
  story:              jsonb("story").notNull(),
  cause:              text("cause").notNull(),
  country:            char("country", { length: 2 }).notNull(),
  // The legacy column target_eur_cents (before ADR-060) still exists until migration
  // 0022 drops it with its trigger; the code no longer selects it (contract step 1).
  /** ADR-060: the currency the fundraiser chose for the goal (GOAL_CURRENCIES). */
  goalCurrency:       text("goal_currency").notNull().default("EUR"),
  /** ADR-060: the goal in minor units (cents) of goal_currency. Never float. */
  goalAmountMinor:    numeric("goal_amount_minor", { precision: 18, scale: 0 }).notNull(),
  /** EUR/USD rate snapshot — set at admin approval. */
  eurUsdRate:         numeric("eur_usd_rate", { precision: 18, scale: 8 }),
  rateSource:         text("rate_source"),
  rateAt:             timestamp("rate_at", { withTimezone: true }),
  /** USDC target (numeric(78,0) → bigint). Set at approval. */
  targetUsdc:         numeric78("target_usdc"),
  durationDays:       integer("duration_days").notNull(),
  status:             campaignStatusEnum("status").notNull().default("DRAFT"),
  reviewNote:         text("review_note"),
  /** Set when the organisation submits it for review (the slug is fixed from then on). */
  submittedAt:        timestamp("submitted_at", { withTimezone: true }),
  reviewedAt:         timestamp("reviewed_at", { withTimezone: true }),
  reviewerId:         uuid("reviewer_id").references(() => users.id),
  /** Hash of the createCampaign transaction the operator sent. APPROVED + a hash = "publishing". */
  publishTxHash:      varchar("publish_tx_hash", { length: 66 }),
  /** On-chain deadline, set when the call data is prepared (now + duration_days). */
  deadline:           timestamp("deadline", { withTimezone: true }),
  deployedAt:         timestamp("deployed_at", { withTimezone: true }),
  /** Campaign contract address (EIP-1167 clone). Set after on-chain deployment. */
  onchainAddress:     varchar("onchain_address", { length: 42 }).unique(),
  // ADR-052: made-up campaign for testing on local/dev; shows a "Demo" badge.
  isDemo:             boolean("is_demo").notNull().default(false),
  createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
                        .$onUpdateFn(() => new Date()),
}, (t) => [
  index("campaigns_org_id_idx").on(t.orgId),
  index("campaigns_starter_user_id_idx").on(t.starterUserId),
  index("campaigns_status_idx").on(t.status),
  // TASK-047: the live public campaigns by deadline (landing hero + grid, the
  // live section of /campaigns) without sorting every published campaign.
  index("campaigns_public_deadline_idx").on(t.deadline, t.id).where(sql`${t.status} = 'DEPLOYED' and ${t.onchainAddress} is not null`),
  check("campaigns_beneficiary_address_format",
    sql`${t.beneficiaryAddress} IS NULL OR ${t.beneficiaryAddress} ~ ${ADDR_RE}`),
  check("campaigns_beneficiary_required_when_approved",
    sql`${t.status}::text NOT IN ('APPROVED','DEPLOYED') OR ${t.beneficiaryAddress} IS NOT NULL`),
  check("campaigns_onchain_address_format",
    sql`${t.onchainAddress} IS NULL OR ${t.onchainAddress} ~ ${ADDR_RE}`),
  check("campaigns_publish_tx_hash_format",
    sql`${t.publishTxHash} IS NULL OR ${t.publishTxHash} ~ '^0x[0-9a-f]{64}$'`),
  check("campaigns_goal_currency", sql`${t.goalCurrency} IN ('EUR','USD')`),
  check("campaigns_goal_amount_positive", sql`${t.goalAmountMinor} > 0`),
  check("campaigns_offchain_id_length",
    sql`${t.offchainId} IS NULL OR length(${t.offchainId}) = 32`),
]);

// ── campaign_media ────────────────────────────────────────────────────────────
export const campaignMedia = appSchema.table("campaign_media", {
  id:         uuidPk(),
  campaignId: uuid("campaign_id").notNull().references(() => campaigns.id),
  kind:       mediaKindEnum("kind").notNull(),
  cid:        text("cid").notNull(),
  storage:    storageProviderEnum("storage").notNull(),
  sort:       integer("sort").notNull().default(0),
  /** Display name of a public PDF (ADR-039); null for images and videos. */
  label:      text("label"),
  /** Size of the stored object in bytes; null for video links. */
  sizeBytes:  integer("size_bytes"),
  /** Who added it (null for rows from before TASK-030). */
  createdBy:  uuid("created_by").references(() => users.id),
  createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
                .$onUpdateFn(() => new Date()),
}, (t) => [
  index("campaign_media_campaign_id_idx").on(t.campaignId),
]);

// ── evidence_bundles ──────────────────────────────────────────────────────────
export const evidenceBundles = appSchema.table("evidence_bundles", {
  id:             uuidPk(),
  campaignId:     uuid("campaign_id").notNull().references(() => campaigns.id),
  /** Milestone round (0 = first tranche, 1 = second, 2 = third). */
  round:          integer("round").notNull(),
  /** SHA-256 of the bundle manifest, exactly 32 bytes. */
  bundleHash:     bytea("bundle_hash"),
  privateFileKeys: text("private_file_keys").array().notNull().default(sql`'{}'`),
  publicCids:     text("public_cids").array().notNull().default(sql`'{}'`),
  status:         evidenceStatusEnum("status").notNull().default("DRAFT"),
  /** Public note of the fundraiser for this round (ADR-047); part of the manifest. */
  note:           text("note").notNull().default(""),
  /** The exact manifest text whose SHA-256 is `bundle_hash`; set when sealed, never edited after. */
  manifest:       text("manifest"),
  sealedAt:       timestamp("sealed_at", { withTimezone: true }),
  createdBy:      uuid("created_by").references(() => users.id),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
                    .$onUpdateFn(() => new Date()),
}, (t) => [
  index("evidence_bundles_campaign_id_idx").on(t.campaignId),
  unique("evidence_bundles_campaign_round_uniq").on(t.campaignId, t.round),
  check("evidence_bundles_hash_length",
    sql`${t.bundleHash} IS NULL OR length(${t.bundleHash}) = 32`),
  check("evidence_bundles_note_length", sql`char_length(${t.note}) <= 2000`),
  check("evidence_bundles_sealed",
    sql`(${t.manifest} IS NULL) = (${t.bundleHash} IS NULL) AND (${t.manifest} IS NULL) = (${t.sealedAt} IS NULL)`),
]);

// ── evidence_files ────────────────────────────────────────────────────────────
// One file of an evidence bundle (TASK-033c, ADR-047). A PRIVATE file is an
// encrypted object in private storage (`private_files`, ADR-033); a PUBLIC file
// is an object in the public media bucket (ADR-037: images re-encoded without
// metadata, PDFs unchanged). `sha256` is of the stored bytes and goes into the
// manifest; no file name is kept.
export const evidenceFiles = appSchema.table("evidence_files", {
  id:            uuidPk(),
  bundleId:      uuid("bundle_id").notNull().references(() => evidenceBundles.id),
  visibility:    evidenceVisibilityEnum("visibility").notNull(),
  privateFileId: uuid("private_file_id").unique().references(() => privateFiles.id),
  publicKey:     text("public_key").unique(),
  mimeType:      text("mime_type").notNull(),
  sizeBytes:     integer("size_bytes").notNull(),
  sha256:        char("sha256", { length: 64 }).notNull(),
  createdBy:     uuid("created_by").notNull().references(() => users.id),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("evidence_files_bundle_id_idx").on(t.bundleId),
  check("evidence_files_storage",
    sql`(${t.visibility} = 'PRIVATE' AND ${t.privateFileId} IS NOT NULL AND ${t.publicKey} IS NULL)
     OR (${t.visibility} = 'PUBLIC' AND ${t.publicKey} IS NOT NULL AND ${t.privateFileId} IS NULL)`),
  check("evidence_files_sha256_format", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  check("evidence_files_size", sql`${t.sizeBytes} > 0 AND ${t.sizeBytes} <= 10485760`),
]);
