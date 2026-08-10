-- Pre-Task-5 baseline: the two tables that existed before household/deal tracking.
-- Uses IF NOT EXISTS so re-running on an already-provisioned database is safe.
CREATE TABLE IF NOT EXISTS "services" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_type" text DEFAULT 'Other' NOT NULL,
	"provider" text NOT NULL,
	"product_name" text,
	"monthly_cost_gbp" real,
	"annual_cost_gbp" real,
	"renewal_date" date,
	"contract_end_date" date,
	"notice_days" integer DEFAULT 30 NOT NULL,
	"research_window_days" integer DEFAULT 60 NOT NULL,
	"location" text,
	"current_terms" text,
	"preferences" text,
	"quote_facts" text,
	"auto_research" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_researched_at" timestamp with time zone,
	"next_research_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_id" integer NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"report_json" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
