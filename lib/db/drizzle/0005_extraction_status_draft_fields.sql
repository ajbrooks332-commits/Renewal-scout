-- Migration 0005: Draft lifecycle for document_extractions
--
-- Safe to run against:
--   a) Fresh databases that ran 0000–0004 (standard path)
--   b) Databases provisioned via drizzle-kit push (columns/constraint already exist)
--   c) Any partial state in between
--
-- All DDL uses conditional guards so running twice is a no-op.
--
-- Adds:
--  status       — lifecycle state machine: draft | applying | applied | discarded | expired | failed
--  expires_at   — soft TTL (24h); scanner marks draft rows as expired when past this
--  draft_fields — JSONB snapshot of extracted values (for draft resume after page refresh)
--
-- Existing rows (completed extractions) are backfilled as 'applied'.

-- ── 1. status column ──────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'document_extractions'
      AND column_name = 'status'
  ) THEN
    ALTER TABLE document_extractions
      ADD COLUMN status text NOT NULL DEFAULT 'applied';
    -- Change default for future rows to 'draft' (new extractions start in draft state).
    ALTER TABLE document_extractions
      ALTER COLUMN status SET DEFAULT 'draft';
  END IF;
END
$$;
--> statement-breakpoint

-- ── 2. expires_at column ──────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'document_extractions'
      AND column_name = 'expires_at'
  ) THEN
    ALTER TABLE document_extractions
      ADD COLUMN expires_at timestamp with time zone;
  END IF;
END
$$;
--> statement-breakpoint

-- ── 3. draft_fields column ───────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'document_extractions'
      AND column_name = 'draft_fields'
  ) THEN
    ALTER TABLE document_extractions
      ADD COLUMN draft_fields jsonb NOT NULL DEFAULT '{}';
  END IF;
END
$$;
--> statement-breakpoint

-- ── 4. status CHECK constraint ────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'document_extractions'
      AND constraint_name = 'document_extractions_status_check'
  ) THEN
    ALTER TABLE document_extractions
      ADD CONSTRAINT document_extractions_status_check
      CHECK (status IN ('draft', 'applying', 'applied', 'discarded', 'expired', 'failed'));
  END IF;
END
$$;
