ALTER TYPE "app"."point_reason" ADD VALUE 'FIRST_DONATION';--> statement-breakpoint
ALTER TYPE "app"."point_reason" ADD VALUE 'REFERRAL';--> statement-breakpoint
ALTER TYPE "app"."point_reason" ADD VALUE 'CAMPAIGN_SUCCESS';--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "app"."users" USING btree ("created_at");--> statement-breakpoint
-- ADR-057: a milestone vote is worth 30 points (was 200, ADR-048). The old
-- entries are voided, not deleted (append-only ledger); the v2 worker credits
-- 30 under new keys (`vote2:<campaign>:<round>`, rule_version 2).
UPDATE "app"."points_ledger"
SET "voided_at" = now(), "voided_reason" = 'ADR-057 rescale: a vote is 30 points (rule_version 2)'
WHERE "reason" = 'VOTE' AND "ref_key" LIKE 'vote:%' AND "voided_at" IS NULL;
--> statement-breakpoint
-- user_levels mirrors the ledger: recompute both balances.
UPDATE "app"."user_levels" AS ul
SET "status_points" = s.status, "reward_points" = s.reward, "updated_at" = now()
FROM (
  SELECT u."user_id",
         coalesce(sum(l."delta") FILTER (WHERE l."bucket" = 'STATUS' AND l."voided_at" IS NULL), 0) AS status,
         coalesce(sum(l."delta") FILTER (WHERE l."bucket" = 'REWARD' AND l."voided_at" IS NULL), 0) AS reward
  FROM "app"."user_levels" u
  LEFT JOIN "app"."points_ledger" l ON l."user_id" = u."user_id"
  GROUP BY u."user_id"
) AS s
WHERE s."user_id" = ul."user_id";
