-- Migration 0007: Full-schema reconciliation
--
-- Ensures that ANY database — whether provisioned via sequential migrations
-- (0000–0006) OR via drizzle-kit push — has all the tables, columns, and
-- constraints defined in the current Drizzle schema.
--
-- Safe to run against:
--   a) Fresh databases that ran 0000–0006 (standard path) — no-ops throughout
--   b) Databases provisioned via drizzle-kit push — adds any missing constraints
--   c) Any partially-migrated state in between
--
-- All DDL uses conditional guards (IF NOT EXISTS / DO $$…$$ pattern) so
-- running this migration twice is a no-op.
--
-- Ordered sections:
--   1.  document_extractions table (from 0005) — full column reconciliation
--   2.  household_profile columns (from 0003 + initial schema)
--   3.  research_runs columns (from 0004 + 0006)
--   4.  services CHECK constraints
--   5.  research_runs CHECK + UNIQUE constraints
--   6.  household_profile singleton CHECK constraint
--   7.  current_deals UNIQUE(service_id)
--   8.  service_requirements UNIQUE(service_id)
--   9.  Partial UNIQUE index for active research runs

-- ────────────────────────────────────────────────────────────────────────────
-- 1. document_extractions table (full reconciliation)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS document_extractions (
  id              serial       PRIMARY KEY,
  service_id      integer      NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  extraction_id   text         NOT NULL UNIQUE,
  field_count     integer      NOT NULL DEFAULT 0,
  confirmed_count integer      NOT NULL DEFAULT 0,
  draft_field_keys jsonb       NOT NULL DEFAULT '[]',
  draft_fields    jsonb        NOT NULL DEFAULT '{}',
  status          text         NOT NULL DEFAULT 'draft',
  extracted_at    timestamp with time zone NOT NULL DEFAULT now(),
  confirmed_at    timestamp with time zone,
  discarded_at    timestamp with time zone,
  deleted_at      timestamp with time zone,
  expires_at      timestamp with time zone,
  created_at      timestamp with time zone NOT NULL DEFAULT now(),
  updated_at      timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Add any individual columns that might be missing (push-provisioned tables
-- may have the table but be missing columns added in later schema versions).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'document_extractions'
      AND column_name = 'draft_field_keys'
  ) THEN
    ALTER TABLE document_extractions ADD COLUMN draft_field_keys jsonb NOT NULL DEFAULT '[]';
  END IF;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'document_extractions'
      AND column_name = 'draft_fields'
  ) THEN
    ALTER TABLE document_extractions ADD COLUMN draft_fields jsonb NOT NULL DEFAULT '{}';
  END IF;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'document_extractions'
      AND column_name = 'expires_at'
  ) THEN
    ALTER TABLE document_extractions ADD COLUMN expires_at timestamp with time zone;
  END IF;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'document_extractions'
      AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE document_extractions ADD COLUMN deleted_at timestamp with time zone;
  END IF;
END
$$;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 2. household_profile columns (from 0003 + initial schema)
-- ────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'household_profile'
      AND column_name = 'unknown_fields'
  ) THEN
    ALTER TABLE household_profile ADD COLUMN unknown_fields jsonb NOT NULL DEFAULT '[]';
  END IF;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'household_profile'
      AND column_name = 'vehicles'
  ) THEN
    ALTER TABLE household_profile ADD COLUMN vehicles jsonb;
  END IF;
END
$$;
--> statement-breakpoint

-- Rename GBP columns to pence if the old names still exist
-- (handles databases created before the 0002 pence migration)
DO $$
BEGIN
  -- car_value: rename car_value_gbp → car_value_pence if needed
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'household_profile'
      AND column_name = 'car_value_gbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'household_profile'
      AND column_name = 'car_value_pence'
  ) THEN
    ALTER TABLE household_profile RENAME COLUMN car_value_gbp TO car_value_pence;
    -- Convert from GBP (real) to pence (integer) — multiply by 100
    ALTER TABLE household_profile ALTER COLUMN car_value_pence TYPE integer
      USING ROUND(car_value_pence * 100)::integer;
  END IF;
END
$$;
--> statement-breakpoint

-- Ensure car_value_pence exists (push-provisioned may already have it)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'household_profile'
      AND column_name = 'car_value_pence'
  ) THEN
    ALTER TABLE household_profile ADD COLUMN car_value_pence integer;
  END IF;
END
$$;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 3. research_runs columns (from 0004 + 0006)
-- ────────────────────────────────────────────────────────────────────────────

-- generic_mode (from 0004)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'research_runs'
      AND column_name = 'generic_mode'
  ) THEN
    ALTER TABLE research_runs ADD COLUMN generic_mode boolean NOT NULL DEFAULT false;
  END IF;
END
$$;
--> statement-breakpoint

-- Worker queue columns (from 0006 — already idempotent there, but guard again)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'research_runs'
      AND column_name = 'queued_at'
  ) THEN
    ALTER TABLE research_runs ADD COLUMN queued_at timestamp with time zone;
  END IF;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'research_runs'
      AND column_name = 'claimed_at'
  ) THEN
    ALTER TABLE research_runs ADD COLUMN claimed_at timestamp with time zone;
  END IF;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'research_runs'
      AND column_name = 'heartbeat_at'
  ) THEN
    ALTER TABLE research_runs ADD COLUMN heartbeat_at timestamp with time zone;
  END IF;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'research_runs'
      AND column_name = 'retry_count'
  ) THEN
    ALTER TABLE research_runs ADD COLUMN retry_count integer NOT NULL DEFAULT 0;
  END IF;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'research_runs'
      AND column_name = 'max_retries'
  ) THEN
    ALTER TABLE research_runs ADD COLUMN max_retries integer NOT NULL DEFAULT 2;
  END IF;
END
$$;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 4. services CHECK constraints
-- ────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_schema = 'public' AND table_name = 'services'
      AND constraint_name = 'services_notice_days_nonneg'
  ) THEN
    ALTER TABLE services
      ADD CONSTRAINT services_notice_days_nonneg CHECK (notice_days >= 0);
  END IF;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_schema = 'public' AND table_name = 'services'
      AND constraint_name = 'services_research_window_nonneg'
  ) THEN
    ALTER TABLE services
      ADD CONSTRAINT services_research_window_nonneg CHECK (research_window_days >= 0);
  END IF;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_schema = 'public' AND table_name = 'services'
      AND constraint_name = 'services_monthly_cost_nonneg'
  ) THEN
    ALTER TABLE services
      ADD CONSTRAINT services_monthly_cost_nonneg
        CHECK (monthly_cost_pence IS NULL OR monthly_cost_pence >= 0);
  END IF;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_schema = 'public' AND table_name = 'services'
      AND constraint_name = 'services_annual_cost_nonneg'
  ) THEN
    ALTER TABLE services
      ADD CONSTRAINT services_annual_cost_nonneg
        CHECK (annual_cost_pence IS NULL OR annual_cost_pence >= 0);
  END IF;
END
$$;
--> statement-breakpoint

-- Rename GBP columns to pence (pre-0002 databases)
DO $$
BEGIN
  -- monthly_cost_gbp → monthly_cost_pence
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'services'
      AND column_name = 'monthly_cost_gbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'services'
      AND column_name = 'monthly_cost_pence'
  ) THEN
    ALTER TABLE services RENAME COLUMN monthly_cost_gbp TO monthly_cost_pence;
    ALTER TABLE services ALTER COLUMN monthly_cost_pence TYPE integer
      USING ROUND(monthly_cost_pence * 100)::integer;
  END IF;

  -- annual_cost_gbp → annual_cost_pence
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'services'
      AND column_name = 'annual_cost_gbp'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'services'
      AND column_name = 'annual_cost_pence'
  ) THEN
    ALTER TABLE services RENAME COLUMN annual_cost_gbp TO annual_cost_pence;
    ALTER TABLE services ALTER COLUMN annual_cost_pence TYPE integer
      USING ROUND(annual_cost_pence * 100)::integer;
  END IF;
END
$$;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 5. research_runs CHECK constraint on status
-- ────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_schema = 'public' AND table_name = 'research_runs'
      AND constraint_name = 'research_runs_status_check'
  ) THEN
    -- Sanitise any invalid statuses before adding the constraint so the ALTER
    -- does not fail on existing rows. Unknown statuses become 'failed' so they
    -- can be inspected and retried rather than silently deleted.
    UPDATE research_runs
      SET status = 'failed'
      WHERE status NOT IN ('queued', 'running', 'complete', 'failed');
    ALTER TABLE research_runs
      ADD CONSTRAINT research_runs_status_check
        CHECK (status IN ('queued', 'running', 'complete', 'failed'));
  END IF;
END
$$;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 6. household_profile singleton CHECK (id = 1)
-- ────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_schema = 'public' AND table_name = 'household_profile'
      AND constraint_name = 'household_profile_singleton'
  ) THEN
    -- Before adding the constraint, handle any duplicate rows by keeping
    -- the row with id=1 (the canonical singleton) and removing others.
    -- If no row has id=1, keep the one with the lowest id and renumber it.
    DO $inner$
    DECLARE
      has_one boolean;
    BEGIN
      SELECT EXISTS(SELECT 1 FROM household_profile WHERE id = 1) INTO has_one;
      IF NOT has_one THEN
        -- Renumber the lowest id to 1 (safe: no FK references household_profile.id)
        UPDATE household_profile SET id = 1
          WHERE id = (SELECT MIN(id) FROM household_profile);
      END IF;
      -- Remove any remaining duplicates (id != 1)
      DELETE FROM household_profile WHERE id != 1;
    END
    $inner$;

    ALTER TABLE household_profile
      ADD CONSTRAINT household_profile_singleton CHECK (id = 1);
  END IF;
END
$$;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 7. current_deals UNIQUE(service_id)
-- ────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'current_deals'
      AND constraint_type = 'UNIQUE'
  ) THEN
    -- Deduplicate before adding constraint: keep the most recently updated row
    -- per service_id.
    DELETE FROM current_deals cd
      USING (
        SELECT service_id, MAX(updated_at) AS keep_ts
        FROM current_deals
        GROUP BY service_id
        HAVING COUNT(*) > 1
      ) dup
      WHERE cd.service_id = dup.service_id
        AND cd.updated_at < dup.keep_ts;
    ALTER TABLE current_deals
      ADD CONSTRAINT current_deals_service_id_unique UNIQUE (service_id);
  END IF;
END
$$;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 8. service_requirements UNIQUE(service_id)
-- ────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'service_requirements'
      AND constraint_type = 'UNIQUE'
  ) THEN
    -- Deduplicate before adding constraint
    DELETE FROM service_requirements sr
      USING (
        SELECT service_id, MAX(updated_at) AS keep_ts
        FROM service_requirements
        GROUP BY service_id
        HAVING COUNT(*) > 1
      ) dup
      WHERE sr.service_id = dup.service_id
        AND sr.updated_at < dup.keep_ts;
    ALTER TABLE service_requirements
      ADD CONSTRAINT service_requirements_service_id_unique UNIQUE (service_id);
  END IF;
END
$$;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 9. Partial UNIQUE index for active research runs (one per service)
-- ────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS research_runs_active_service_idx
  ON research_runs (service_id)
  WHERE status IN ('queued', 'running');
