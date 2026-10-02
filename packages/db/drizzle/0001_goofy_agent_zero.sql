CREATE TYPE "app"."private_file_kind" AS ENUM('KYB_REGISTRATION_EXTRACT', 'KYB_STATUTE', 'KYB_AUTHORISATION', 'KYB_OTHER');--> statement-breakpoint
CREATE TABLE "app"."private_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"kind" "app"."private_file_kind" NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" char(64) NOT NULL,
	"key_version" smallint DEFAULT 1 NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"kyb_submission_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "private_files_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "private_files_size_bytes_check" CHECK ("app"."private_files"."size_bytes" > 0 AND "app"."private_files"."size_bytes" <= 10485760),
	CONSTRAINT "private_files_sha256_format" CHECK ("app"."private_files"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "app"."private_files" ADD CONSTRAINT "private_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."private_files" ADD CONSTRAINT "private_files_kyb_submission_id_kyb_submissions_id_fk" FOREIGN KEY ("kyb_submission_id") REFERENCES "app"."kyb_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "private_files_uploaded_by_idx" ON "app"."private_files" USING btree ("uploaded_by");--> statement-breakpoint
CREATE INDEX "private_files_kyb_submission_id_idx" ON "app"."private_files" USING btree ("kyb_submission_id");