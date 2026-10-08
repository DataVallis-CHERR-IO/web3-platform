-- TASK-057 (ADR-058): who signed a rating and when (EIP-712), and an index for the
-- worker's rating points watermark. Expand only: no code reads these yet.
ALTER TABLE "app"."ratings" ADD COLUMN "signer_address" text;--> statement-breakpoint
ALTER TABLE "app"."ratings" ADD COLUMN "signed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ratings_created_at_idx" ON "app"."ratings" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "app"."ratings" ADD CONSTRAINT "ratings_signer_address_lower" CHECK ("app"."ratings"."signer_address" = lower("app"."ratings"."signer_address"));