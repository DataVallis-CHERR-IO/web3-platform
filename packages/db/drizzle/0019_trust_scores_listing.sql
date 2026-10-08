-- TASK-017 (ADR-059): one current Trust Score row per organisation and version,
-- with the listing columns the Charity Market Cap filters and sorts by.
-- trust_scores is empty and not read by any deployed code yet.
ALTER TABLE "app"."trust_scores" ADD COLUMN "listed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."trust_scores" ADD COLUMN "registered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."trust_scores" ADD COLUMN "country" char(2);--> statement-breakpoint
ALTER TABLE "app"."trust_scores" ADD COLUMN "causes" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."trust_scores" ADD COLUMN "raised" numeric(78, 0) DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "trust_scores_org_id_version_uniq" ON "app"."trust_scores" USING btree ("org_id","version");--> statement-breakpoint
CREATE INDEX "trust_scores_rank_idx" ON "app"."trust_scores" USING btree ("version","score" DESC NULLS LAST,"org_id") WHERE "app"."trust_scores"."listed";--> statement-breakpoint
CREATE INDEX "trust_scores_country_rank_idx" ON "app"."trust_scores" USING btree ("version","country","score" DESC NULLS LAST,"org_id") WHERE "app"."trust_scores"."listed";--> statement-breakpoint
CREATE INDEX "trust_scores_raised_idx" ON "app"."trust_scores" USING btree ("version","raised" DESC NULLS LAST,"org_id") WHERE "app"."trust_scores"."listed";--> statement-breakpoint
CREATE INDEX "trust_scores_causes_idx" ON "app"."trust_scores" USING gin ("causes");;--> statement-breakpoint
-- Name search over ~1 M organisations (Charity Market Cap): trigram index.
-- pg_trgm ships with Postgres (contrib) and is a trusted extension since PG 13.
CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA public;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organizations_name_trgm_idx" ON "app"."organizations" USING gin ("name" public.gin_trgm_ops);