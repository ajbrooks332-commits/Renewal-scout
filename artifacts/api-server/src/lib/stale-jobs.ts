import { db, pool, researchRunsTable, servicesTable } from "@workspace/db";
import { eq, and, or, isNull, lt } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Heartbeat staleness threshold: a running job whose heartbeat_at is older
 * than this is considered abandoned and eligible for recovery.
 *
 * Validated as a finite positive integer; falls back to 5 min on invalid input.
 * NaN or zero would make every running job look stale (or never stale),
 * so we always use a safe floor.
 */
function parseStaleMs(raw: string | undefined, defaultMs: number): number {
  const parsed = parseInt(raw ?? "", 10);
  if (!isFinite(parsed) || parsed <= 0 || parsed > 60 * 60_000 /* 1 hour */) {
    if (raw !== undefined) {
      logger.warn({ raw, default: defaultMs }, "STALE_HEARTBEAT_MS invalid — using default");
    }
    return defaultMs;
  }
  return parsed;
}
const STALE_HEARTBEAT_MS = parseStaleMs(process.env["STALE_HEARTBEAT_MS"], 5 * 60_000);

/**
 * On server startup, recover research runs that were abandoned mid-execution.
 *
 * A run is considered stale (abandoned) if:
 *   - status = 'running', AND
 *   - heartbeat_at IS NULL (no heartbeat was ever sent — old pre-heartbeat run), OR
 *   - heartbeat_at < now() - STALE_HEARTBEAT_MS (worker crashed without final update)
 *
 * Stale runs are reset to 'queued' so the worker can pick them up, subject to
 * retry_count < max_retries. Runs that have exhausted their retry budget are
 * permanently failed.
 *
 * For services with auto_research disabled: always mark as failed (no auto-retry).
 */
export async function recoverStaleJobs(): Promise<void> {

  const staleThreshold = new Date(Date.now() - STALE_HEARTBEAT_MS);

  const staleRuns = await db
    .select()
    .from(researchRunsTable)
    .where(
      and(
        eq(researchRunsTable.status, "running"),
        or(
          isNull(researchRunsTable.heartbeatAt),
          lt(researchRunsTable.heartbeatAt, staleThreshold),
        ),
      ),
    );

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

    const retriesExhausted = run.retryCount >= run.maxRetries;

    if (service && !retriesExhausted) {
      // Requeue with incremented retry count so the worker picks it up
      await db
        .update(researchRunsTable)
        .set({
          status: "queued",
          startedAt: null,
          claimedAt: null,
          heartbeatAt: null,
          error: null,
          retryCount: run.retryCount + 1,
        })
        .where(eq(researchRunsTable.id, run.id));

      logger.info(
        { runId: run.id, serviceId: run.serviceId, retryCount: run.retryCount + 1 },
        "Stale-job recovery: requeued — worker will pick up on next poll",
      );
    } else {
      const reason = retriesExhausted
        ? `Retry limit reached (${run.retryCount}/${run.maxRetries}).`
        : "Server restarted while job was running.";

      await db
        .update(researchRunsTable)
        .set({
          status: "failed",
          error: reason,
          completedAt: new Date(),
        })
        .where(eq(researchRunsTable.id, run.id));

      logger.info(
        { runId: run.id, reason },
        "Stale-job recovery: marked as failed",
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
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_research_runs_one_active_per_service
    ON research_runs (service_id)
    WHERE status IN ('queued', 'running')
  `);
  logger.info("DB: active-run partial unique index verified");
}
