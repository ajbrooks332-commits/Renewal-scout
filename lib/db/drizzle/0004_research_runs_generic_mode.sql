-- Migration 0004: Add generic_mode boolean to research_runs
--
-- When a research run is triggered with researchMode:"generic", the AI prompt
-- omits personal household context and uses generic public-example framing instead.
-- Stored on the run so executeResearch knows which prompt variant to build.
--
-- Safe to run against:
--   a) Fresh databases that ran 0000–0003 (standard path)
--   b) Databases provisioned via drizzle-kit push (column may already exist)
--
-- Uses conditional guard so running twice is a no-op.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'research_runs'
      AND column_name = 'generic_mode'
  ) THEN
    ALTER TABLE "research_runs"
      ADD COLUMN "generic_mode" boolean NOT NULL DEFAULT false;
  END IF;
END
$$;
