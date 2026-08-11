import app from "./app";
import { logger } from "./lib/logger";
import { recoverStaleJobs, ensureActiveRunIndex } from "./lib/stale-jobs";
import { startScheduler } from "./lib/scheduler";
import { startWorker } from "./lib/worker";
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

// ── Validate OpenAI config in production ──────────────────────────────────────
if (process.env["NODE_ENV"] === "production") {
  const apiKey = process.env["OPENAI_API_KEY"];
  const model = process.env["OPENAI_MODEL"];
  if (!apiKey) {
    logger.warn("OPENAI_API_KEY is not set — research runs will fail immediately");
  }
  if (!model) {
    logger.warn(
      "OPENAI_MODEL is not set — will fall back to gpt-5.6-terra. " +
      "Set OPENAI_MODEL in Replit Secrets to pin to a specific model."
    );
  }
}

// ── Schema migrations — applied automatically before any traffic ──────────────
await runMigrations();
logger.info("Database migrations applied");

// ── Fail-closed DB initialisation ────────────────────────────────────────────
await ensureActiveRunIndex();

// Stale-job recovery: heartbeat-based — only recovers jobs with stale/absent
// heartbeat_at, so a job running in another process is not incorrectly reset.
try {
  await recoverStaleJobs();
} catch (err) {
  logger.error({ err }, "Stale-job recovery failed — continuing startup");
}

// ── Start background services ─────────────────────────────────────────────────
// Both are started AFTER DB readiness. Importing app.ts has no background
// side effects — scheduler and worker are app.ts-independent.
startScheduler();
startWorker();

app.listen(port, () => {
  logger.info({ port }, "Server listening");
});
