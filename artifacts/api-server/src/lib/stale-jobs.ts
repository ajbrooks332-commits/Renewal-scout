import { db, pool, researchRunsTable, servicesTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * On server startup, recover ALL research runs stuck in "running" status.
 * Any run that is still "running" when this process starts must have been
 * claimed by a prior process that crashed — the current process was not
 * running it. We do not use a time-based threshold so that a run claimed
 * just before a crash is also recovered.
 *
 * If the service has auto_research enabled, reset to "queued" and re-execute.
 * Otherwise mark as failed.
 */
export async function recoverStaleJobs(): Promise<void> {
  // Import lazily to avoid circular dependency with research-service
  const { executeResearch } = await import("./research-service");

  const staleRuns = await db
    .select()
    .from(researchRunsTable)
    .where(eq(researchRunsTable.status, "running"));

  if (staleRuns.length === 0) {
    logger.info("Stale-job recovery: no stale jobs found");
    return;
  }

  logger.warn(
    { count: staleRuns.length },
    "Stale-job recovery: found stale running jobs — recovering",
  );

  for (const run of staleRuns) {
    const [service] = await db
      .select()
      .from(servicesTable)
      .where(
        and(
          eq(servicesTable.id, run.serviceId),
          eq(servicesTable.active, true),
          eq(servicesTable.autoResearch, true),
        ),
      );

    if (service) {
      // Requeue so it can be picked up and retried
      await db
        .update(researchRunsTable)
        .set({ status: "queued", startedAt: null, error: null })
        .where(eq(researchRunsTable.id, run.id));

      logger.info(
        { runId: run.id, serviceId: run.serviceId },
        "Stale-job recovery: requeued",
      );

      executeResearch(run.id).catch((err) =>
        logger.error(
          { err, runId: run.id },
          "Stale-job recovery: requeued job failed",
        ),
      );
    } else {
      await db
        .update(researchRunsTable)
        .set({
          status: "failed",
          error: "Server restarted while job was running.",
          completedAt: new Date(),
        })
        .where(eq(researchRunsTable.id, run.id));

      logger.info(
        { runId: run.id },
        "Stale-job recovery: marked as failed (service inactive or no auto-research)",
      );
    }
  }
}

/**
 * Create a DB-level partial unique index to prevent more than one active
 * (queued or running) research run per service. This runs synchronously
 * BEFORE the server accepts traffic so every subsequent insert is protected.
 * Idempotent — safe to call on every startup.
 */
export async function ensureActiveRunIndex(): Promise<void> {
  // This MUST succeed before the server accepts traffic. If index creation
  // fails (e.g. due to pre-existing duplicate active rows or a DB outage),
  // let the error propagate so the caller aborts startup. Without this index,
  // ON CONFLICT DO NOTHING in queueResearch has no constraint to fire against,
  // leaving the race window fully open.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_research_runs_one_active_per_service
    ON research_runs (service_id)
    WHERE status IN ('queued', 'running')
  `);
  logger.info("DB: active-run partial unique index verified");
}
