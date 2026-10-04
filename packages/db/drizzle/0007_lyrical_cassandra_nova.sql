CREATE TABLE "app"."contract_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"timelock" text NOT NULL,
	"operation_id" text NOT NULL,
	"targets" text[] NOT NULL,
	"payloads" text[] NOT NULL,
	"predecessor" text NOT NULL,
	"salt" text NOT NULL,
	"delay_seconds" integer NOT NULL,
	"summary" jsonb NOT NULL,
	"scheduled_by" uuid NOT NULL,
	"schedule_tx_hash" text NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_by" uuid,
	"execute_tx_hash" text,
	"executed_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_tx_hash" text,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "contract_changes_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "contract_changes_operation_id" CHECK ("app"."contract_changes"."operation_id" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "contract_changes_timelock" CHECK ("app"."contract_changes"."timelock" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "contract_changes_lengths" CHECK (cardinality("app"."contract_changes"."targets") = cardinality("app"."contract_changes"."payloads") and cardinality("app"."contract_changes"."targets") > 0),
	CONSTRAINT "contract_changes_not_both" CHECK (not ("app"."contract_changes"."executed_at" is not null and "app"."contract_changes"."cancelled_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "app"."contract_changes" ADD CONSTRAINT "contract_changes_scheduled_by_users_id_fk" FOREIGN KEY ("scheduled_by") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contract_changes" ADD CONSTRAINT "contract_changes_executed_by_users_id_fk" FOREIGN KEY ("executed_by") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contract_changes" ADD CONSTRAINT "contract_changes_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_changes_scheduled_at_idx" ON "app"."contract_changes" USING btree ("scheduled_at");