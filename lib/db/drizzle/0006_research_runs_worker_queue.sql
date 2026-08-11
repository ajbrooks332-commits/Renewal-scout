-- Migration 0006: PG-backed worker queue columns for research_runs
--
-- Safe to run against:
--   a) Fresh databases that ran 0000–0005 (standard path)
--   b) Databases provisioned via drizzle-kit push (columns may already exist)
--   c) Any partial state in between
--
-- All DDL uses conditional guards so running twice is a no-op.
--
-- Adds:
--  queued_at    — when the job was inserted into the queue
--  claimed_at   — when a worker atomically claimed the job (queued → running)
--  heartbeat_at — last heartbeat from the running worker; stale → abandoned
--  retry_count  — how many times this job has been retried
--  max_retries  — maximum allowed retries (default 2)

-- ── 1. queued_at ──────────────────────────────────────────────────────────────
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

-- ── 2. claimed_at ─────────────────────────────────────────────────────────────
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

-- ── 3. heartbeat_at ───────────────────────────────────────────────────────────
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

-- ── 4. retry_count ────────────────────────────────────────────────────────────
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

-- ── 5. max_retries ────────────────────────────────────────────────────────────
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
