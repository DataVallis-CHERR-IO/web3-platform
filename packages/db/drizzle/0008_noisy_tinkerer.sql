CREATE TYPE "app"."evidence_visibility" AS ENUM('PRIVATE', 'PUBLIC');--> statement-breakpoint
ALTER TYPE "app"."private_file_kind" ADD VALUE 'EVIDENCE';--> statement-breakpoint
CREATE TABLE "app"."evidence_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bundle_id" uuid NOT NULL,
	"visibility" "app"."evidence_visibility" NOT NULL,
	"private_file_id" uuid,
	"public_key" text,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" char(64) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_files_private_file_id_unique" UNIQUE("private_file_id"),
	CONSTRAINT "evidence_files_public_key_unique" UNIQUE("public_key"),
	CONSTRAINT "evidence_files_storage" CHECK (("app"."evidence_files"."visibility" = 'PRIVATE' AND "app"."evidence_files"."private_file_id" IS NOT NULL AND "app"."evidence_files"."public_key" IS NULL)
     OR ("app"."evidence_files"."visibility" = 'PUBLIC' AND "app"."evidence_files"."public_key" IS NOT NULL AND "app"."evidence_files"."private_file_id" IS NULL)),
	CONSTRAINT "evidence_files_sha256_format" CHECK ("app"."evidence_files"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "evidence_files_size" CHECK ("app"."evidence_files"."size_bytes" > 0 AND "app"."evidence_files"."size_bytes" <= 10485760)
);
--> statement-breakpoint
ALTER TABLE "app"."evidence_bundles" ADD COLUMN "note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."evidence_bundles" ADD COLUMN "manifest" text;--> statement-breakpoint
ALTER TABLE "app"."evidence_bundles" ADD COLUMN "sealed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."evidence_bundles" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "app"."evidence_files" ADD CONSTRAINT "evidence_files_bundle_id_evidence_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "app"."evidence_bundles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."evidence_files" ADD CONSTRAINT "evidence_files_private_file_id_private_files_id_fk" FOREIGN KEY ("private_file_id") REFERENCES "app"."private_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."evidence_files" ADD CONSTRAINT "evidence_files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_files_bundle_id_idx" ON "app"."evidence_files" USING btree ("bundle_id");--> statement-breakpoint
ALTER TABLE "app"."evidence_bundles" ADD CONSTRAINT "evidence_bundles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."evidence_bundles" ADD CONSTRAINT "evidence_bundles_note_length" CHECK (char_length("app"."evidence_bundles"."note") <= 2000);--> statement-breakpoint
ALTER TABLE "app"."evidence_bundles" ADD CONSTRAINT "evidence_bundles_sealed" CHECK (("app"."evidence_bundles"."manifest" IS NULL) = ("app"."evidence_bundles"."bundle_hash" IS NULL) AND ("app"."evidence_bundles"."manifest" IS NULL) = ("app"."evidence_bundles"."sealed_at" IS NULL));