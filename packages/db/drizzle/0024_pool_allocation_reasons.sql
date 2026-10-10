CREATE TABLE "app"."pool_allocation_reasons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reason_hash" text NOT NULL,
	"text" text NOT NULL,
	"pool_id" integer NOT NULL,
	"campaign_id" uuid NOT NULL,
	"amount_usdc" numeric(78, 0) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pool_allocation_reasons_reason_hash_unique" UNIQUE("reason_hash"),
	CONSTRAINT "pool_allocation_reasons_hash_format" CHECK ("app"."pool_allocation_reasons"."reason_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "pool_allocation_reasons_text_length" CHECK (char_length("app"."pool_allocation_reasons"."text") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "app"."pool_allocation_reasons" ADD CONSTRAINT "pool_allocation_reasons_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "app"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pool_allocation_reasons" ADD CONSTRAINT "pool_allocation_reasons_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pool_allocation_reasons_campaign_id_idx" ON "app"."pool_allocation_reasons" USING btree ("campaign_id");