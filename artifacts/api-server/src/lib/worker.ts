/**
 * PG-backed research worker.
 *
 * Polls the research_runs table for queued jobs and executes them.
 * Uses the same atomic claim (queued → running) as executeResearch, so
 * multiple worker instances (or manual API triggers) cannot execute the
 * same job twice.
 *
 * The scheduler (scheduler.ts) only inserts jobs — the worker executes them.
 */
import { db, researchRunsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { logger } from "./logger";

// ─── Validated configuration ──────────────────────────────────────────────────
//
// All duration values are validated at module load. Invalid (non-finite,
// non-positive, or NaN) values fall back to a safe default so we never
// schedule a 1ms-interval tight loop or skip stale detection entirely.

const DEFAULT_POLL_INTERVAL_MS = 10_000; // 10 s
const MAX_POLL_INTERVAL_MS = 300_000;    // 5 min — sanity upper bound

function parsePositiveInt(raw: string | undefined, defaultValue: number, max: number): number {
  const parsed = parseInt(raw ?? "", 10);
  if (!isFinite(parsed) || parsed <= 0 || parsed > max) {
    if (raw !== undefined) {
      logger.warn(
        { raw, defaultValue },
        `Worker: invalid interval value — using default ${defaultValue}ms`,
      );
    }
    return defaultValue;
  }
  return parsed;
}

const WORKER_POLL_INTERVAL_MS = parsePositiveInt(
  process.env["WORKER_POLL_INTERVAL_MS"],
  DEFAULT_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
);

let workerHandle: ReturnType<typeof setInterval> | null = null;
/** Reentrancy guard: prevents overlapping concurrent poll executions. */
let pollInProgress = false;

/**
 * Start the worker poll loop.
 * Idempotent — calling again while already running is a no-op.
 * Fires one guarded poll immediately on start to minimise dispatch latency
 * for jobs that were queued before the process started.
 */
export function startWorker(): void {
  if (workerHandle) return;

  logger.info({ pollIntervalMs: WORKER_POLL_INTERVAL_MS }, "Worker: starting poll loop");

  // One immediate guarded poll on startup so queued jobs are claimed without
  // waiting for the first interval (important after process restart).
  pollAndExecute().catch((err) => {
    logger.error({ err }, "Worker: startup poll error");
  });

  workerHandle = setInterval(() => {
    pollAndExecute().catch((err) => {
      logger.error({ err }, "Worker: poll iteration error");
    });
  }, WORKER_POLL_INTERVAL_MS);
}

export function stopWorker(): void {
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = null;
    logger.info("Worker: stopped");
  }
}

/**
 * Find the oldest queued job and hand it to executeResearch.
 * A reentrancy guard prevents two concurrent polls from running simultaneously
 * (the immediate startup poll and the first interval overlap by construction).
 * executeResearch performs the atomic claim internally, so concurrent worker
 * instances or manual triggers will not double-execute the job.
 */
async function pollAndExecute(): Promise<void> {
  if (pollInProgress) return;
  pollInProgress = true;
  try {
    // Dynamic import to avoid circular dependency:
    // worker → research-service (which does NOT import worker)
    const { executeResearch } = await import("./research-service");

    const [queued] = await db
      .select({ id: researchRunsTable.id })
      .from(researchRunsTable)
      .where(eq(researchRunsTable.status, "queued"))
      .orderBy(asc(researchRunsTable.createdAt))
      .limit(1);

    if (!queued) return;

    logger.info({ runId: queued.id }, "Worker: dispatching queued job");

    // Fire and forget — executeResearch handles its own error logging and
    // final status update; the next poll will not re-pick the same job
    // because its status moves to 'running' atomically on claim.
    executeResearch(queued.id).catch((err) => {
      logger.error({ err, runId: queued.id }, "Worker: job execution threw unexpectedly");
    });
  } finally {
    pollInProgress = false;
  }
}
