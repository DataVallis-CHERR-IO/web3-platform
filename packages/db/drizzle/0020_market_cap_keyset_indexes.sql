-- TASK-017b: Charity Market Cap keyset pages. The 0019 ranking indexes mixed
-- directions (score DESC, org_id ASC), which a row comparison cannot use; these run
-- one direction and are read backwards. No deployed code reads the dropped ones.
DROP INDEX IF EXISTS "app"."trust_scores_rank_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "app"."trust_scores_country_rank_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "app"."trust_scores_raised_idx";--> statement-breakpoint
CREATE INDEX "organizations_name_id_idx" ON "app"."organizations" USING btree ("name","id");--> statement-breakpoint
CREATE INDEX "trust_scores_rank_v2_idx" ON "app"."trust_scores" USING btree ("version","score","org_id") WHERE "app"."trust_scores"."listed";--> statement-breakpoint
CREATE INDEX "trust_scores_country_rank_v2_idx" ON "app"."trust_scores" USING btree ("version","country","score","org_id") WHERE "app"."trust_scores"."listed";--> statement-breakpoint
CREATE INDEX "trust_scores_registered_rank_idx" ON "app"."trust_scores" USING btree ("version","registered","score","org_id") WHERE "app"."trust_scores"."listed";--> statement-breakpoint
CREATE INDEX "trust_scores_raised_v2_idx" ON "app"."trust_scores" USING btree ("version","raised","org_id") WHERE "app"."trust_scores"."listed";