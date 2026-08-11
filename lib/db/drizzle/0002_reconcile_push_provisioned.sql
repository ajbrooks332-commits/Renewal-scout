-- Migration 0002: Reconciliation for push-provisioned databases + schema hardening.
--
-- This migration is safe to run against:
--   a) Fresh databases that ran 0000 and 0001 (standard path)
--   b) Databases provisioned via drizzle-kit push (all tables already exist)
--   c) Any partial state in between
--
-- All DDL uses conditional guards so running twice is a no-op.

-- ── 1. Rename and convert monetary columns (GBP real → pence integer) ─────────
--
-- services: monthly_cost_gbp (real GBP) → monthly_cost_pence (integer pence)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'services'
      AND column_name = 'monthly_cost_gbp'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'services'
        AND column_name = 'monthly_cost_pence'
    ) THEN
      UPDATE services
        SET monthly_cost_pence = COALESCE(
          monthly_cost_pence,
          ROUND(monthly_cost_gbp::numeric * 100)::integer
        );
      ALTER TABLE services DROP COLUMN monthly_cost_gbp;
    ELSE
      ALTER TABLE services RENAME COLUMN monthly_cost_gbp TO monthly_cost_pence;
      ALTER TABLE services ALTER COLUMN monthly_cost_pence TYPE integer
        USING CASE WHEN monthly_cost_pence IS NULL THEN NULL
                   ELSE ROUND(monthly_cost_pence::numeric * 100)::integer END;
    END IF;
  END IF;
END
$$;
--> statement-breakpoint

-- services: annual_cost_gbp (real GBP) → annual_cost_pence (integer pence)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'services'
      AND column_name = 'annual_cost_gbp'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'services'
        AND column_name = 'annual_cost_pence'
    ) THEN
      UPDATE services
        SET annual_cost_pence = COALESCE(
          annual_cost_pence,
          ROUND(annual_cost_gbp::numeric * 100)::integer
        );
      ALTER TABLE services DROP COLUMN annual_cost_gbp;
    ELSE
      ALTER TABLE services RENAME COLUMN annual_cost_gbp TO annual_cost_pence;
      ALTER TABLE services ALTER COLUMN annual_cost_pence TYPE integer
        USING CASE WHEN annual_cost_pence IS NULL THEN NULL
                   ELSE ROUND(annual_cost_pence::numeric * 100)::integer END;
    END IF;
  END IF;
END
$$;
--> statement-breakpoint

-- household_profile: car_value_gbp (integer whole-GBP) → car_value_pence (integer pence)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'household_profile'
      AND column_name = 'car_value_gbp'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'household_profile'
        AND column_name = 'car_value_pence'
    ) THEN
      UPDATE household_profile
        SET car_value_pence = COALESCE(
          car_value_pence,
          ROUND(car_value_gbp::numeric * 100)::integer
        );
      ALTER TABLE household_profile DROP COLUMN car_value_gbp;
    ELSE
      ALTER TABLE household_profile RENAME COLUMN car_value_gbp TO car_value_pence;
      ALTER TABLE household_profile ALTER COLUMN car_value_pence TYPE integer
        USING CASE WHEN car_value_pence IS NULL THEN NULL
                   ELSE ROUND(car_value_pence::numeric * 100)::integer END;
    END IF;
  END IF;
END
$$;
--> statement-breakpoint

-- ── 2. research_runs: status CHECK constraint ─────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'research_runs'
      AND constraint_name = 'research_runs_status_check'
  ) THEN
    ALTER TABLE research_runs ADD CONSTRAINT research_runs_status_check
      CHECK (status IN ('queued', 'running', 'complete', 'failed'));
  END IF;
END
$$;
--> statement-breakpoint

-- ── 3. Non-negative CHECK constraints ─────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'services'
      AND constraint_name = 'services_notice_days_nonneg'
  ) THEN
    ALTER TABLE services ADD CONSTRAINT services_notice_days_nonneg
      CHECK (notice_days >= 0);
  END IF;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'services'
      AND constraint_name = 'services_research_window_nonneg'
  ) THEN
    ALTER TABLE services ADD CONSTRAINT services_research_window_nonneg
      CHECK (research_window_days >= 0);
  END IF;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'services'
      AND constraint_name = 'services_monthly_cost_nonneg'
  ) THEN
    ALTER TABLE services ADD CONSTRAINT services_monthly_cost_nonneg
      CHECK (monthly_cost_pence IS NULL OR monthly_cost_pence >= 0);
  END IF;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'services'
      AND constraint_name = 'services_annual_cost_nonneg'
  ) THEN
    ALTER TABLE services ADD CONSTRAINT services_annual_cost_nonneg
      CHECK (annual_cost_pence IS NULL OR annual_cost_pence >= 0);
  END IF;
END
$$;
--> statement-breakpoint

-- ── 4. household_profile singleton constraint (id must equal 1) ───────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'household_profile'
      AND constraint_name = 'household_profile_singleton'
  ) THEN
    ALTER TABLE household_profile ADD CONSTRAINT household_profile_singleton
      CHECK (id = 1);
  END IF;
END
$$;
--> statement-breakpoint

-- ── 5. Unique constraints (safe for push-provisioned databases) ───────────────
--
-- These may already exist if the DB was provisioned from 0001 (which declares
-- them). The EXCEPTION handlers make this safe either way.
DO $$ BEGIN
  ALTER TABLE service_requirements
    ADD CONSTRAINT service_requirements_service_id_unique UNIQUE (service_id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR unique_violation THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE current_deals
    ADD CONSTRAINT current_deals_service_id_unique UNIQUE (service_id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR unique_violation THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE document_extractions
    ADD CONSTRAINT document_extractions_extraction_id_unique UNIQUE (extraction_id);
EXCEPTION WHEN duplicate_table OR duplicate_object OR unique_violation THEN NULL;
END $$;
--> statement-breakpoint

-- ── 6. FK constraints (safe re-add for push-provisioned databases) ────────────
DO $$ BEGIN
  ALTER TABLE service_requirements
    ADD CONSTRAINT service_requirements_service_id_services_id_fk
    FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE current_deals
    ADD CONSTRAINT current_deals_service_id_services_id_fk
    FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE document_extractions
    ADD CONSTRAINT document_extractions_service_id_services_id_fk
    FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- ── 7. Partial unique index: at most one active run per service ───────────────
--
-- Prevents duplicate queued/running research runs for the same service.
-- Replaces the application-level guard in queueResearch with a DB-level guarantee.
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS research_runs_active_service_idx
    ON research_runs (service_id)
    WHERE status IN ('queued', 'running');
EXCEPTION WHEN unique_violation THEN NULL;
END $$;
