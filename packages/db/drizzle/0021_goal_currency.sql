-- TASK-060 (ADR-060), expand step: goal currency per campaign. Ships before the
-- code that uses it, because migrations run after the new container starts.
-- target_eur_cents stays (nullable) for the code that is still running; the
-- trigger keeps both representations in step until a later contract migration
-- drops the old column and the trigger.
ALTER TABLE "app"."campaigns" ADD COLUMN "goal_currency" text DEFAULT 'EUR' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD COLUMN "goal_amount_minor" numeric(18, 0);--> statement-breakpoint
UPDATE "app"."campaigns" SET "goal_amount_minor" = "target_eur_cents" WHERE "goal_amount_minor" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."campaigns_goal_sync"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Code from before ADR-060 writes only target_eur_cents.
    IF NEW.goal_amount_minor IS NULL AND NEW.target_eur_cents IS NOT NULL THEN
      NEW.goal_currency := 'EUR';
      NEW.goal_amount_minor := NEW.target_eur_cents;
    END IF;
  ELSIF NEW.target_eur_cents IS DISTINCT FROM OLD.target_eur_cents
    AND NEW.target_eur_cents IS NOT NULL
    AND NEW.goal_amount_minor IS NOT DISTINCT FROM OLD.goal_amount_minor
    AND NEW.goal_currency IS NOT DISTINCT FROM OLD.goal_currency THEN
    -- An edit by code from before ADR-060.
    NEW.goal_currency := 'EUR';
    NEW.goal_amount_minor := NEW.target_eur_cents;
  END IF;
  -- The legacy column mirrors EUR goals only; other currencies have no EUR goal.
  IF NEW.goal_currency = 'EUR' THEN
    NEW.target_eur_cents := NEW.goal_amount_minor;
  ELSE
    NEW.target_eur_cents := NULL;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "campaigns_goal_sync" BEFORE INSERT OR UPDATE ON "app"."campaigns"
  FOR EACH ROW EXECUTE FUNCTION "app"."campaigns_goal_sync"();--> statement-breakpoint
ALTER TABLE "app"."campaigns" ALTER COLUMN "goal_amount_minor" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."campaigns" ALTER COLUMN "target_eur_cents" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD CONSTRAINT "campaigns_goal_currency" CHECK ("app"."campaigns"."goal_currency" IN ('EUR','USD'));--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD CONSTRAINT "campaigns_goal_amount_positive" CHECK ("app"."campaigns"."goal_amount_minor" > 0);
