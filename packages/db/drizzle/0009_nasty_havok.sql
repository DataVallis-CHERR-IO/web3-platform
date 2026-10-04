CREATE TYPE "app"."notification_kind" AS ENUM('VOTE_OPENED', 'VOTE_REMINDER', 'VOTE_RESULT', 'REFUND_AVAILABLE', 'EMAIL_CONFIRM');--> statement-breakpoint
CREATE TYPE "app"."notification_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TABLE "app"."notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"email_enabled" boolean DEFAULT true NOT NULL,
	"contact_email" text,
	"pending_email" text,
	"confirm_token_hash" text,
	"confirm_expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"unsubscribe_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_unsubscribe_token_unique" UNIQUE("unsubscribe_token")
);
--> statement-breakpoint
CREATE TABLE "app"."notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "app"."notification_kind" NOT NULL,
	"dedupe_key" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "app"."notification_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"send_after" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_user_kind_key_uniq" UNIQUE("user_id","kind","dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "app"."points_ledger" ADD COLUMN "ref_key" text;--> statement-breakpoint
ALTER TABLE "app"."notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_status_send_after_idx" ON "app"."notifications" USING btree ("status","send_after");--> statement-breakpoint
CREATE UNIQUE INDEX "points_ledger_auto_uniq" ON "app"."points_ledger" USING btree ("user_id","reason","bucket","ref_key") WHERE "app"."points_ledger"."ref_key" IS NOT NULL;