ALTER TYPE "app"."storage_provider" ADD VALUE 'HETZNER_PUBLIC';--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD COLUMN "reviewer_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD COLUMN "publish_tx_hash" varchar(66);--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD COLUMN "deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD COLUMN "deployed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD CONSTRAINT "campaigns_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."campaigns" ADD CONSTRAINT "campaigns_publish_tx_hash_format" CHECK ("app"."campaigns"."publish_tx_hash" IS NULL OR "app"."campaigns"."publish_tx_hash" ~ '^0x[0-9a-f]{64}$');