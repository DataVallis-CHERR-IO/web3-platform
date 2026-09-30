-- Enable pgvector extension (no vector columns in Phase 1; required in Phase 2)
CREATE EXTENSION IF NOT EXISTS "vector";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "app";
--> statement-breakpoint
CREATE TYPE "app"."address_kind" AS ENUM('EMBEDDED', 'SMART_ACCOUNT', 'EXTERNAL');--> statement-breakpoint
CREATE TYPE "app"."beneficiary_type" AS ENUM('ORGANIZATION', 'INDIVIDUAL');--> statement-breakpoint
CREATE TYPE "app"."campaign_status" AS ENUM('DRAFT', 'PENDING_REVIEW', 'REJECTED', 'APPROVED', 'DEPLOYED');--> statement-breakpoint
CREATE TYPE "app"."evidence_status" AS ENUM('DRAFT', 'SUBMITTED_ONCHAIN', 'VOTING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "app"."kyb_status" AS ENUM('NONE', 'PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "app"."kyb_submission_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "app"."kyc_status" AS ENUM('INITIATED', 'PENDING', 'APPROVED', 'REJECTED', 'RESUBMISSION_REQUESTED');--> statement-breakpoint
CREATE TYPE "app"."media_kind" AS ENUM('COVER', 'GALLERY', 'VIDEO');--> statement-breakpoint
CREATE TYPE "app"."onramp_provider" AS ENUM('TRANSAK');--> statement-breakpoint
CREATE TYPE "app"."onramp_status" AS ENUM('PENDING', 'COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "app"."org_member_role" AS ENUM('ORG_ADMIN', 'ORG_MEMBER');--> statement-breakpoint
CREATE TYPE "app"."org_source" AS ENUM('REGISTERED', 'IMPORTED');--> statement-breakpoint
CREATE TYPE "app"."platform_role" AS ENUM('PLATFORM_ADMIN');--> statement-breakpoint
CREATE TYPE "app"."point_bucket" AS ENUM('STATUS', 'REWARD');--> statement-breakpoint
CREATE TYPE "app"."point_reason" AS ENUM('REGISTRATION', 'DONATION', 'RATING', 'VOTE', 'KYC_PASSED', 'KYB_REFERRAL', 'ADMIN_ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "app"."registry_type" AS ENUM('SI_AJPES', 'SI_MJU', 'UK_CC', 'US_IRS', 'NONE');--> statement-breakpoint
CREATE TYPE "app"."storage_provider" AS ENUM('POLLINATIONX', 'PINATA');--> statement-breakpoint
CREATE TABLE "app"."user_addresses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"address" varchar(42) NOT NULL,
	"kind" "app"."address_kind" NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_addresses_address_unique" UNIQUE("address"),
	CONSTRAINT "user_addresses_address_format" CHECK ("app"."user_addresses"."address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "app"."user_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "app"."platform_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_user_id_role_uniq" UNIQUE("user_id","role")
);
--> statement-breakpoint
CREATE TABLE "app"."users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"privy_did" text,
	"locale" varchar(10) DEFAULT 'en' NOT NULL,
	"anonymous_donations" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_privy_did_unique" UNIQUE("privy_did")
);
--> statement-breakpoint
CREATE TABLE "app"."kyb_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"submitted_by" uuid NOT NULL,
	"status" "app"."kyb_submission_status" DEFAULT 'PENDING' NOT NULL,
	"reviewer_id" uuid,
	"review_note" text,
	"private_file_keys" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."org_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "app"."org_member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_org_id_user_id_uniq" UNIQUE("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "app"."organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" "app"."org_source" NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"country" char(2) NOT NULL,
	"registry" "app"."registry_type" NOT NULL,
	"registry_id" text,
	"website" text,
	"description" text,
	"causes" text[] DEFAULT '{}' NOT NULL,
	"kyb_status" "app"."kyb_status" DEFAULT 'NONE' NOT NULL,
	"claimed_by_user_id" uuid,
	"payout_address" varchar(42),
	"logo_cid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_registry_registry_id_uniq" UNIQUE("registry","registry_id"),
	CONSTRAINT "organizations_payout_address_format" CHECK ("app"."organizations"."payout_address" IS NULL OR "app"."organizations"."payout_address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "app"."kyc_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text DEFAULT 'SUMSUB' NOT NULL,
	"applicant_id" text NOT NULL,
	"status" "app"."kyc_status" DEFAULT 'INITIATED' NOT NULL,
	"level" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."campaign_media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"kind" "app"."media_kind" NOT NULL,
	"cid" text NOT NULL,
	"storage" "app"."storage_provider" NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"offchain_id" "bytea",
	"org_id" uuid,
	"starter_user_id" uuid NOT NULL,
	"beneficiary_type" "app"."beneficiary_type" NOT NULL,
	"beneficiary_address" varchar(42),
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"story" jsonb NOT NULL,
	"cause" text NOT NULL,
	"country" char(2) NOT NULL,
	"target_eur_cents" numeric(18, 0) NOT NULL,
	"eur_usd_rate" numeric(18, 8),
	"rate_source" text,
	"rate_at" timestamp with time zone,
	"target_usdc" numeric(78,0),
	"duration_days" integer NOT NULL,
	"status" "app"."campaign_status" DEFAULT 'DRAFT' NOT NULL,
	"review_note" text,
	"onchain_address" varchar(42),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_offchain_id_unique" UNIQUE("offchain_id"),
	CONSTRAINT "campaigns_slug_unique" UNIQUE("slug"),
	CONSTRAINT "campaigns_onchain_address_unique" UNIQUE("onchain_address"),
	CONSTRAINT "campaigns_beneficiary_address_format" CHECK ("app"."campaigns"."beneficiary_address" IS NULL OR "app"."campaigns"."beneficiary_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "campaigns_beneficiary_required_when_approved" CHECK ("app"."campaigns"."status"::text NOT IN ('APPROVED','DEPLOYED') OR "app"."campaigns"."beneficiary_address" IS NOT NULL),
	CONSTRAINT "campaigns_onchain_address_format" CHECK ("app"."campaigns"."onchain_address" IS NULL OR "app"."campaigns"."onchain_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "campaigns_offchain_id_length" CHECK ("app"."campaigns"."offchain_id" IS NULL OR length("app"."campaigns"."offchain_id") = 32)
);
--> statement-breakpoint
CREATE TABLE "app"."evidence_bundles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"bundle_hash" "bytea",
	"private_file_keys" text[] DEFAULT '{}' NOT NULL,
	"public_cids" text[] DEFAULT '{}' NOT NULL,
	"status" "app"."evidence_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_bundles_campaign_round_uniq" UNIQUE("campaign_id","round"),
	CONSTRAINT "evidence_bundles_hash_length" CHECK ("app"."evidence_bundles"."bundle_hash" IS NULL OR length("app"."evidence_bundles"."bundle_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "app"."points_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"bucket" "app"."point_bucket" NOT NULL,
	"delta" bigint NOT NULL,
	"reason" "app"."point_reason" NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"rule_version" integer DEFAULT 1 NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."ratings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"stars" integer NOT NULL,
	"comment" text,
	"signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ratings_campaign_id_user_id_uniq" UNIQUE("campaign_id","user_id"),
	CONSTRAINT "ratings_stars_range" CHECK ("app"."ratings"."stars" >= 1 AND "app"."ratings"."stars" <= 5)
);
--> statement-breakpoint
CREATE TABLE "app"."user_levels" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"status_points" bigint DEFAULT 0 NOT NULL,
	"reward_points" bigint DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."registry_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"registry" "app"."registry_type" NOT NULL,
	"registry_id" text NOT NULL,
	"raw" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registry_records_registry_id_uniq" UNIQUE("registry","registry_id")
);
--> statement-breakpoint
CREATE TABLE "app"."trust_scores" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"score" numeric(5, 2) NOT NULL,
	"components" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."emergency_subpools" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pool_id" integer NOT NULL,
	"slug" text NOT NULL,
	"name_key" text NOT NULL,
	"description_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "emergency_subpools_pool_id_unique" UNIQUE("pool_id"),
	CONSTRAINT "emergency_subpools_slug_unique" UNIQUE("slug"),
	CONSTRAINT "emergency_subpools_pool_id_non_negative" CHECK ("app"."emergency_subpools"."pool_id" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."onramp_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "app"."onramp_provider" DEFAULT 'TRANSAK' NOT NULL,
	"provider_order_id" text NOT NULL,
	"status" "app"."onramp_status" DEFAULT 'PENDING' NOT NULL,
	"fiat_amount_cents" bigint NOT NULL,
	"fiat_currency" char(3) NOT NULL,
	"usdc_amount" numeric(78,0) NOT NULL,
	"wallet_address" varchar(42) NOT NULL,
	"campaign_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onramp_orders_provider_order_id_unique" UNIQUE("provider_order_id"),
	CONSTRAINT "onramp_orders_wallet_address_format" CHECK ("app"."onramp_orders"."wallet_address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "app"."audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"data" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."user_addresses" ADD CONSTRAINT "user_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."kyb_submissions" ADD CONSTRAINT "kyb_submissions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."kyb_submissions" ADD CONSTRAINT "kyb_submissions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."kyb_submissions" ADD CONSTRAINT "kyb_submissions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."org_members" ADD CONSTRAINT "org_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."org_members" ADD CONSTRAINT "org_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."organizations" ADD CONSTRAINT "organizations_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."kyc_checks" ADD CONSTRAINT "kyc_checks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."campaign_media" ADD CONSTRAINT "campaign_media_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "app"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD CONSTRAINT "campaigns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD CONSTRAINT "campaigns_starter_user_id_users_id_fk" FOREIGN KEY ("starter_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."evidence_bundles" ADD CONSTRAINT "evidence_bundles_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "app"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."points_ledger" ADD CONSTRAINT "points_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ratings" ADD CONSTRAINT "ratings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ratings" ADD CONSTRAINT "ratings_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "app"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ratings" ADD CONSTRAINT "ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_levels" ADD CONSTRAINT "user_levels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."trust_scores" ADD CONSTRAINT "trust_scores_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."onramp_orders" ADD CONSTRAINT "onramp_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."onramp_orders" ADD CONSTRAINT "onramp_orders_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "app"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_addresses_user_id_idx" ON "app"."user_addresses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_roles_user_id_idx" ON "app"."user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "kyb_submissions_org_id_idx" ON "app"."kyb_submissions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "kyb_submissions_submitted_by_idx" ON "app"."kyb_submissions" USING btree ("submitted_by");--> statement-breakpoint
CREATE INDEX "org_members_org_id_idx" ON "app"."org_members" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "org_members_user_id_idx" ON "app"."org_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "organizations_claimed_by_user_id_idx" ON "app"."organizations" USING btree ("claimed_by_user_id");--> statement-breakpoint
CREATE INDEX "kyc_checks_user_id_idx" ON "app"."kyc_checks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "campaign_media_campaign_id_idx" ON "app"."campaign_media" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "campaigns_org_id_idx" ON "app"."campaigns" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "campaigns_starter_user_id_idx" ON "app"."campaigns" USING btree ("starter_user_id");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "app"."campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "evidence_bundles_campaign_id_idx" ON "app"."evidence_bundles" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "points_ledger_user_id_created_at_idx" ON "app"."points_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ratings_org_id_idx" ON "app"."ratings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ratings_campaign_id_idx" ON "app"."ratings" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "ratings_user_id_idx" ON "app"."ratings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "registry_records_registry_idx" ON "app"."registry_records" USING btree ("registry");--> statement-breakpoint
CREATE INDEX "trust_scores_org_id_computed_at_idx" ON "app"."trust_scores" USING btree ("org_id","computed_at");--> statement-breakpoint
CREATE INDEX "onramp_orders_user_id_idx" ON "app"."onramp_orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "onramp_orders_campaign_id_idx" ON "app"."onramp_orders" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_user_id_idx" ON "app"."audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "app"."audit_log" USING btree ("entity_type","entity_id");