-- Task 5 additions: household profile, service requirements, current deals,
-- and document extraction tables.  All CREATE TABLE statements use IF NOT
-- EXISTS and FK constraints use DO BEGIN...EXCEPTION so this migration is safe
-- to run against any database state (fresh or previously provisioned via push).
CREATE TABLE IF NOT EXISTS "household_profile" (
	"id" serial PRIMARY KEY NOT NULL,
	"postcode" text,
	"property_type" text,
	"tenure" text,
	"bedrooms" integer,
	"year_built" integer,
	"num_adults" integer,
	"num_children" integer,
	"heating_type" text,
	"has_ev" boolean,
	"ev_charger_type" text,
	"has_solar" boolean,
	"solar_export_tariff" text,
	"annual_electricity_kwh" integer,
	"annual_gas_kwh" integer,
	"has_sky_tv" boolean,
	"has_sky_mobile" boolean,
	"has_virgin_media" boolean,
	"num_cars" integer,
	"car_make" text,
	"car_model" text,
	"car_year" integer,
	"car_value_gbp" integer,
	"annual_mileage" integer,
	"driving_experience" text,
	"claims_last_5_years" integer,
	"smoker" boolean,
	"accessibility_needs" text,
	"general_preferences" text,
	"questionnaire_version" text DEFAULT '1' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_requirements" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_id" integer NOT NULL,
	"schema_version" text DEFAULT '1' NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_requirements_service_id_unique" UNIQUE("service_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "current_deals" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_id" integer NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_confirmed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "current_deals_service_id_unique" UNIQUE("service_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_extractions" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_id" integer NOT NULL,
	"extraction_id" text NOT NULL,
	"field_count" integer DEFAULT 0 NOT NULL,
	"confirmed_count" integer DEFAULT 0 NOT NULL,
	"draft_field_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "document_extractions_extraction_id_unique" UNIQUE("extraction_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_requirements" ADD CONSTRAINT "service_requirements_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "current_deals" ADD CONSTRAINT "current_deals_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
