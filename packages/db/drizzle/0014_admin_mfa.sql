CREATE TABLE "app"."admin_mfa" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"secret_enc" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_used_step" integer,
	"recovery_code_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_mfa_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "app"."admin_mfa" ADD CONSTRAINT "admin_mfa_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;