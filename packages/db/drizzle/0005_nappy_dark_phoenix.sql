ALTER TYPE "app"."media_kind" ADD VALUE 'DOCUMENT';--> statement-breakpoint
ALTER TYPE "app"."storage_provider" ADD VALUE 'EXTERNAL';--> statement-breakpoint
ALTER TABLE "app"."campaign_media" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "app"."campaign_media" ADD COLUMN "size_bytes" integer;--> statement-breakpoint
ALTER TABLE "app"."campaign_media" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "app"."campaign_media" ADD CONSTRAINT "campaign_media_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;