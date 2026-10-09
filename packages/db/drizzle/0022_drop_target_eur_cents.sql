-- TASK-060 (ADR-060), contract step 2: the code stopped selecting target_eur_cents
-- (PR #191, deployed before this migration), so the legacy column and the trigger
-- that kept it in step (0021) can go.
DROP TRIGGER IF EXISTS "campaigns_goal_sync" ON "app"."campaigns";--> statement-breakpoint
DROP FUNCTION IF EXISTS "app"."campaigns_goal_sync"();--> statement-breakpoint
ALTER TABLE "app"."campaigns" DROP COLUMN "target_eur_cents";
