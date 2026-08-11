-- Migration 0004: Add generic_mode boolean to research_runs
--
-- When a research run is triggered with researchMode:"generic", the AI prompt
-- omits personal household context and uses generic public-example framing instead.
-- Stored on the run so executeResearch knows which prompt variant to build.

ALTER TABLE "research_runs"
  ADD COLUMN "generic_mode" boolean NOT NULL DEFAULT false;
