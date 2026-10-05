ALTER TABLE "app"."users" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."organizations" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;