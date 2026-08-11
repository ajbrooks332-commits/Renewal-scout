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

// ── Production secret validation ──────────────────────────────────────────────
// Fail with a clear message if required secrets are absent so operators are
// not left guessing why requests fail at runtime.
if (process.env["NODE_ENV"] === "production") {
  const adminPassword = process.env["ADMIN_PASSWORD"];
  if (!adminPassword) {
    logger.error(
      "FATAL: ADMIN_PASSWORD is not set in production. " +
      "Add it to Replit Secrets before deploying.",
    );
    process.exit(1);
  }

  const appBaseUrl = process.env["APP_BASE_URL"];
  if (!appBaseUrl) {
    logger.error(
      "FATAL: APP_BASE_URL is not set in production. " +
      "Set it to your HTTPS deployment URL in Replit Secrets (e.g. https://my-app.replit.app). " +
      "Without it, CORS and CSRF origin checks will reject all cross-origin requests.",
    );
    process.exit(1);
  } else {
    try {
      const parsed = new URL(appBaseUrl);
      if (parsed.protocol !== "https:") {
        logger.error(
          `FATAL: APP_BASE_URL "${appBaseUrl}" must use HTTPS in production. ` +
          "Update the secret to an https:// URL.",
        );
        process.exit(1);
      }
    } catch {
      logger.error(
        `FATAL: APP_BASE_URL "${appBaseUrl}" is not a valid URL. Fix it in Replit Secrets.`,
      );
      process.exit(1);
    }
  }

  const apiKey = process.env["OPENAI_API_KEY"];
  const model = process.env["OPENAI_MODEL"];
  if (!apiKey) {
    logger.warn("OPENAI_API_KEY is not set — research runs will fail immediately");
  }
  if (!model) {
    logger.warn(
      "OPENAI_MODEL is not set — will fall back to gpt-5.6-terra. " +
      "Set OPENAI_MODEL in Replit Secrets to pin to a specific model.",
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
