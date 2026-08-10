import app from "./app";
import { logger } from "./lib/logger";
import { recoverStaleJobs, ensureActiveRunIndex } from "./lib/stale-jobs";
import { runMigrations } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ── Schema migrations — applied automatically before any traffic ──────────────
//
// runMigrations() uses Drizzle's built-in journal to skip already-applied
// migrations, so it is safe to call on every startup (cold deploy or restart).
// Fail-closed: if migrations fail (e.g. DB unavailable, constraint error) we
// do NOT start the server — continuing without schema would give 500s.
await runMigrations();
logger.info("Database migrations applied");

// ── Fail-closed DB initialisation — must complete BEFORE accepting traffic ────
//
// ensureActiveRunIndex creates the partial unique index that backs the
// ON CONFLICT DO NOTHING guard in queueResearch. If it fails (DB outage,
// pre-existing duplicate rows, etc.) we do NOT start the server — accepting
// traffic without the index would leave the duplicate-research-run race fully
// open. Let the unhandled rejection crash the process so the supervisor can
// restart or alert.
await ensureActiveRunIndex();

// Stale-job recovery is best-effort (cleanup only, not a safety gate). Log
// failures but do not abort startup.
try {
  await recoverStaleJobs();
} catch (err) {
  logger.error({ err }, "Stale-job recovery failed — continuing startup");
}

app.listen(port, () => {
  logger.info({ port }, "Server listening");
});
