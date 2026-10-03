CREATE TABLE "app"."fx_rates" (
	"currency" varchar(10) PRIMARY KEY NOT NULL,
	"usd_per_unit" numeric(38, 18) NOT NULL,
	"source" text NOT NULL,
	"rate_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_source" CHECK ("app"."fx_rates"."source" in ('ECB', 'COINGECKO')),
	CONSTRAINT "fx_rates_positive" CHECK ("app"."fx_rates"."usd_per_unit" > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."users" ADD COLUMN "display_currency" varchar(10);