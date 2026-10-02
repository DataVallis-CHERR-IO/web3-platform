import { char, index, integer, jsonb, numeric, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  appSchema,
  beneficiaryTypeEnum,
  campaignStatusEnum,
  evidenceStatusEnum,
  mediaKindEnum,
  storageProviderEnum,
} from "./enums.js";
import { bytea, numeric78, uuidPk } from "./helpers.js";
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
  /** EUR target stored as integer cents. Never float. */
  targetEurCents:     numeric("target_eur_cents", { precision: 18, scale: 0 }).notNull(),
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
  createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
                        .$onUpdateFn(() => new Date()),
}, (t) => [
  index("campaigns_org_id_idx").on(t.orgId),
  index("campaigns_starter_user_id_idx").on(t.starterUserId),
  index("campaigns_status_idx").on(t.status),
  check("campaigns_beneficiary_address_format",
    sql`${t.beneficiaryAddress} IS NULL OR ${t.beneficiaryAddress} ~ ${ADDR_RE}`),
  check("campaigns_beneficiary_required_when_approved",
    sql`${t.status}::text NOT IN ('APPROVED','DEPLOYED') OR ${t.beneficiaryAddress} IS NOT NULL`),
  check("campaigns_onchain_address_format",
    sql`${t.onchainAddress} IS NULL OR ${t.onchainAddress} ~ ${ADDR_RE}`),
  check("campaigns_publish_tx_hash_format",
    sql`${t.publishTxHash} IS NULL OR ${t.publishTxHash} ~ '^0x[0-9a-f]{64}$'`),
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
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
                    .$onUpdateFn(() => new Date()),
}, (t) => [
  index("evidence_bundles_campaign_id_idx").on(t.campaignId),
  unique("evidence_bundles_campaign_round_uniq").on(t.campaignId, t.round),
  check("evidence_bundles_hash_length",
    sql`${t.bundleHash} IS NULL OR length(${t.bundleHash}) = 32`),
]);
