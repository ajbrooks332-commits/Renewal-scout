/**
 * PG-backed research worker.
 *
 * Polls the research_runs table for queued jobs and executes them.
 * Uses the same atomic claim (queued → running) as executeResearch, so
 * multiple worker instances (or manual API triggers) cannot execute the
 * same job twice.
 *
 * Concurrency guarantee: at most ONE job executes at a time per process.
 * executeResearch is AWAITED before the poll-in-progress flag is released,
 * so the next interval cannot start a second job while one is running.
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

/**
 * Reentrancy guard: true while a poll OR a job execution is in progress.
 * Because executeResearch is awaited, this stays true for the job's full
 * duration — preventing a second job from starting on the next poll tick.
 */
let pollInProgress = false;

/**
 * The promise of the currently running job, kept for shutdown tracking.
 * Null when no job is active.
 */
let activeJobPromise: Promise<void> | null = null;

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

/**
 * Stop the worker poll loop and wait for any active job to finish.
 *
 * @param shutdownTimeoutMs Maximum time (ms) to wait for an active job before
 *   giving up. The job may still complete in the DB after this timeout —
 *   stale-job recovery handles the cleanup if it doesn't.
 */
export async function stopWorker(shutdownTimeoutMs = 30_000): Promise<void> {
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = null;
    logger.info("Worker: poll loop stopped");
  }
  if (activeJobPromise) {
    logger.info({ shutdownTimeoutMs }, "Worker: waiting for active job to complete…");
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Worker shutdown timed out after ${shutdownTimeoutMs}ms`)),
        shutdownTimeoutMs,
      ),
    );
    await Promise.race([activeJobPromise, timeout]).catch((err) => {
      logger.warn({ err }, "Worker: shutdown timeout — active job may still be running in DB");
    });
  }
}

/**
 * Find the oldest queued job and execute it synchronously (awaited).
 *
 * A reentrancy guard prevents two concurrent polls from running simultaneously.
 * Because executeResearch is AWAITED, the guard remains set for the job's full
 * duration — the next poll tick returns immediately if a job is still running.
 * This guarantees at most one concurrent AI research job per worker process.
 *
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

    // Track the active promise so stopWorker() can await it during shutdown.
    const jobPromise = executeResearch(queued.id).catch((err) => {
      logger.error({ err, runId: queued.id }, "Worker: job execution threw unexpectedly");
    });
    activeJobPromise = jobPromise;

    // AWAIT the job — this is the key concurrency boundary.
    // pollInProgress stays true for the job's full duration so that the next
    // poll interval cannot start a second job while this one is executing.
    await jobPromise;
  } finally {
    activeJobPromise = null;
    pollInProgress = false;
  }
}
