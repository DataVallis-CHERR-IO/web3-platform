-- TASK-055 (ADR-057 §5), expand step: the schema ships before the code that uses it,
-- because migrations run after the new container starts (deploy.yml).
CREATE TABLE "app"."campaign_referrals" (
	"user_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"referrer_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_referrals_user_id_campaign_id_pk" PRIMARY KEY("user_id","campaign_id"),
	CONSTRAINT "campaign_referrals_not_self" CHECK ("app"."campaign_referrals"."user_id" <> "app"."campaign_referrals"."referrer_user_id")
);
--> statement-breakpoint
ALTER TABLE "app"."users" ADD COLUMN "ref_code" varchar(16);--> statement-breakpoint
ALTER TABLE "app"."users" ADD COLUMN "referred_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."campaign_referrals" ADD CONSTRAINT "campaign_referrals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."campaign_referrals" ADD CONSTRAINT "campaign_referrals_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "app"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."campaign_referrals" ADD CONSTRAINT "campaign_referrals_referrer_user_id_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_referrals_referrer_idx" ON "app"."campaign_referrals" USING btree ("referrer_user_id","campaign_id");--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_referred_by_user_id_users_id_fk" FOREIGN KEY ("referred_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_ref_code_unique" UNIQUE("ref_code");--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_ref_code_format" CHECK ("app"."users"."ref_code" IS NULL OR "app"."users"."ref_code" ~ '^[a-z0-9]{8,16}$');--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_not_self_referred" CHECK ("app"."users"."referred_by_user_id" IS NULL OR "app"."users"."referred_by_user_id" <> "app"."users"."id");